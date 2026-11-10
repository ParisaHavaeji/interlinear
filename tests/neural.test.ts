// Layer D (plan.md step 15): the pure half of the neural re-alignment. The model itself never
// runs here; vectors are made by hand, or derived from the gold files so that an "oracle"
// embedder shows what the semantic feature does to the bead DP.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { alignBlocks, alignSentences } from '../src/align/beads.ts'
import { beadFeatures, combinedCost, DEFAULT_WEIGHTS, prepareSentence, semanticSimilarity } from '../src/align/features.ts'
import { scoreGold, type GoldFile } from '../src/align/gold.ts'
import {
  DEFAULT_BATCH_SIZE,
  dot,
  DownloadTracker,
  embedSentences,
  embedTexts,
  normalize,
  pooled,
  SEMANTIC_WEIGHT,
  sideSimilarity,
  type Embedder,
  type SentenceEmbeddings,
} from '../src/align/neural.ts'
import { alignBook, alignPlanned, pairedSentences, planBook, type AlignProgress } from '../src/align/pipeline.ts'
import type { ParagraphSentence } from '../src/align/sentences.ts'
import { parseTxt } from '../src/import/txt.ts'
import { havePair, loadPair, pairPath, PAIRS } from '../tools/pairs.ts'

const vec = (...xs: number[]) => Float32Array.from(xs)
const read = (file: string) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')

/** Unit vectors in a few dimensions, for hand-made tests. */
const E = {
  x: vec(1, 0, 0, 0),
  y: vec(0, 1, 0, 0),
  z: vec(0, 0, 1, 0),
  w: vec(0, 0, 0, 1),
}

describe('vector arithmetic', () => {
  it('normalises, leaves the zero vector alone, and pools as the normalised sum', () => {
    const n = normalize(vec(3, 4))
    expect(n[0]).toBeCloseTo(0.6)
    expect(n[1]).toBeCloseTo(0.8)
    expect([...normalize(vec(0, 0))]).toEqual([0, 0])
    expect(pooled([])).toBeNull()
    expect(pooled([E.x])).toBe(E.x)
    const p = pooled([E.x, E.y])!
    expect(dot(p, p)).toBeCloseTo(1)
    expect(p[0]).toBeCloseTo(Math.SQRT1_2)
    expect(p[1]).toBeCloseTo(Math.SQRT1_2)
  })

  it('sideSimilarity is the clamped cosine of the pooled sides, zero for an empty side', () => {
    expect(sideSimilarity([E.x], [E.x])).toBeCloseTo(1)
    expect(sideSimilarity([E.x], [E.y])).toBe(0)
    expect(sideSimilarity([E.x], [E.x, E.y])).toBeCloseTo(Math.SQRT1_2)
    expect(sideSimilarity([vec(1, 0)], [vec(-1, 0)])).toBe(0)
    expect(sideSimilarity([], [E.x])).toBe(0)
    expect(sideSimilarity([E.x], [])).toBe(0)
  })
})

/** An embedder that maps a text to a fixed vector by lookup, counting the batches it saw. */
function tableEmbedder(table: Record<string, Float32Array>): Embedder & { batches: string[][] } {
  const batches: string[][] = []
  return {
    batches,
    async embed(texts) {
      batches.push([...texts])
      return texts.map((t) => {
        const v = table[t]
        if (v === undefined) throw new Error(`no vector for "${t}"`)
        return v
      })
    },
  }
}

describe('embedTexts', () => {
  const table = { a: E.x, bb: E.y, ccc: E.z, dddd: E.w, ee: E.x }

  it('returns vectors in input order whatever the batching, longest texts first', async () => {
    const embedder = tableEmbedder(table)
    const done: [number, number][] = []
    const out = await embedTexts(embedder, ['a', 'bb', 'ccc', 'dddd', 'ee'], { batchSize: 2, onProgress: (d, t) => done.push([d, t]) })
    expect(out).toEqual([E.x, E.y, E.z, E.w, E.x])
    expect(embedder.batches).toEqual([['dddd', 'ccc'], ['bb', 'ee'], ['a']])
    expect(done).toEqual([
      [0, 5],
      [2, 5],
      [4, 5],
      [5, 5],
    ])
  })

  it('uses one batch for a short list and copes with nothing to embed', async () => {
    const embedder = tableEmbedder(table)
    expect(await embedTexts(embedder, [])).toEqual([])
    expect(embedder.batches).toEqual([])
    await embedTexts(embedder, ['a', 'bb'])
    expect(embedder.batches).toEqual([['bb', 'a']])
    expect(DEFAULT_BATCH_SIZE).toBeGreaterThan(2)
  })

  it('stops with an AbortError once the signal aborts, and refuses a short answer', async () => {
    const controller = new AbortController()
    const embedder: Embedder = {
      async embed(texts) {
        controller.abort()
        return texts.map(() => E.x)
      },
    }
    await expect(embedTexts(embedder, ['a', 'b', 'c'], { batchSize: 1, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    const short: Embedder = { embed: async () => [] }
    await expect(embedTexts(short, ['a'])).rejects.toThrow(/0 vectors for 1 texts/)
  })
})

describe('embedSentences', () => {
  it('places each vector at its sentence idx on its side, in one progress total', async () => {
    const s = (idx: number, text: string): ParagraphSentence => ({ idx, paraIdx: 0, text, charStart: 0, charEnd: text.length })
    const embedder = tableEmbedder({ Haus: E.x, Baum: E.y, house: E.z, tree: E.w })
    const seen: number[] = []
    const emb = await embedSentences(embedder, { de: [s(3, 'Haus'), s(5, 'Baum')], en: [s(0, 'house'), s(1, 'tree')] }, { onProgress: (_d, t) => seen.push(t) })
    expect(emb.de[3]).toBe(E.x)
    expect(emb.de[5]).toBe(E.y)
    expect(emb.de[4]).toBeUndefined()
    expect(emb.en[0]).toBe(E.z)
    expect(emb.en[1]).toBe(E.w)
    expect(new Set(seen)).toEqual(new Set([4]))
  })
})

describe('DownloadTracker', () => {
  it('reports bytes loaded over bytes expected across the files seen, and 1 when all are done', () => {
    const t = new DownloadTracker()
    expect(t.fraction).toBe(0)
    t.update('model.onnx', 50, 100)
    expect(t.fraction).toBe(0.5)
    t.update('tokenizer.json', 0, 100)
    expect(t.fraction).toBe(0.25)
    t.update('tokenizer.json', 100, 100)
    t.done('model.onnx')
    expect(t.fraction).toBe(1)
    t.done('config.json')
    expect(t.fraction).toBe(1)
    t.update('odd', 10, 0)
    expect(t.fraction).toBe(1)
  })
})

describe('the semantic feature', () => {
  const de = (text: string, v?: Float32Array) => prepareSentence(text, 'de', null, v)
  const en = (text: string, v?: Float32Array) => prepareSentence(text, 'en', null, v)
  const options = { ratio: 1 }

  it('is absent without vectors, so classical costs are unchanged', () => {
    const f = beadFeatures([de('Gregor lachte.')], [en('Gregor laughed.')], options)
    expect(f.semantic).toBeUndefined()
    expect(semanticSimilarity([de('a')], [en('b', E.x)])).toBeUndefined()
    expect(combinedCost(f)).toBe(combinedCost({ ...f }, { lexical: 5, cognate: 1.5, punctuation: 0.5 }))
  })

  it('is the cosine of the sides, zero for a one-sided bead, and costs weight × (1 − cosine)', () => {
    const match = beadFeatures([de('Gregor lachte.', E.x)], [en('Gregor laughed.', E.x)], options)
    const miss = beadFeatures([de('Gregor lachte.', E.x)], [en('Gregor laughed.', E.y)], options)
    expect(match.semantic).toBeCloseTo(1)
    expect(miss.semantic).toBe(0)
    expect(combinedCost(miss) - combinedCost(match)).toBeCloseTo(SEMANTIC_WEIGHT)
    expect(combinedCost(miss, { ...DEFAULT_WEIGHTS, semantic: 2 }) - combinedCost(match, { ...DEFAULT_WEIGHTS, semantic: 2 })).toBeCloseTo(2)
    const oneSided = beadFeatures([de('Gregor lachte.', E.x)], [], options)
    expect(oneSided.semantic).toBe(0)
    expect(beadFeatures([de('Gregor lachte.')], [], options).semantic).toBeUndefined()
  })

  it('decides a bead that length leaves open', () => {
    // Two German sentences of equal length against three English ones of equal length, with no
    // word in common: by length alone the DP cannot tell which German sentence the translator
    // split in two (both answers cost the same), so the vectors decide.
    const D1 = 'Alpha beta gamma delta epsilon zeta eta omega.'
    const D2 = 'Iota kappa lambda mu nu xi omicron pi rho sig.'
    const E1 = 'One two three four five six.'
    const E2 = 'Seven eight nine ten eleven.'
    const E3 = 'Twelve thirteen fourteen xv.'
    const key = (beads: { de: number[]; en: number[] }[]) => beads.map((b) => `${b.de.join('+')}:${b.en.join('+')}`)

    const first = alignSentences([de(D1, E.x), de(D2, E.y)], [en(E1, E.x), en(E2, E.x), en(E3, E.y)], { ratio: 1 })
    expect(key(first)).toEqual(['0:0+1', '1:2'])

    const second = alignSentences([de(D1, E.x), de(D2, E.y)], [en(E1, E.x), en(E2, E.y), en(E3, E.y)], { ratio: 1 })
    expect(key(second)).toEqual(['0:0', '1:1+2'])

    // Without vectors the two answers (all but) tie, and whichever the DP picks is a near coin flip.
    const blind = alignSentences([de(D1), de(D2)], [en(E1), en(E2), en(E3)], { ratio: 1 })
    expect(Math.max(...blind.map((b) => b.confidence))).toBeLessThan(0.6)
    expect(Math.min(...first.map((b) => b.confidence))).toBeGreaterThan(0.9)
  })

  it('alignBlocks looks vectors up by sentence idx', () => {
    const s = (idx: number, paraIdx: number, text: string): ParagraphSentence => ({ idx, paraIdx, text, charStart: 0, charEnd: text.length })
    const deS = [s(7, 2, 'Alpha beta gamma delta epsilon zeta eta theta.'), s(8, 2, 'Iota kappa lambda mu nu xi omicron pi rho sig.')]
    const enS = [s(4, 9, 'One two three four fiv.'), s(5, 9, 'Six seven eight nine ten.'), s(6, 9, 'Eleven twelve thirteen fourteen fifteen sixte.')]
    const embeddings: SentenceEmbeddings = { de: [], en: [] }
    ;(embeddings.de as (Float32Array | undefined)[])[7] = E.x
    ;(embeddings.de as (Float32Array | undefined)[])[8] = E.y
    ;(embeddings.en as (Float32Array | undefined)[])[4] = E.x
    ;(embeddings.en as (Float32Array | undefined)[])[5] = E.x
    ;(embeddings.en as (Float32Array | undefined)[])[6] = E.y
    const beads = alignBlocks(deS, enS, [{ de: [2], en: [9] }], null, { ratio: 1 }, embeddings)
    expect(beads.map((b) => `${b.deSentenceIdx.join('+')}:${b.enSentenceIdx.join('+')}`)).toEqual(['7:4+5', '8:6'])
  })
})

// ---------------------------------------------------------------------------------------------
// The pipeline with an oracle embedder

/**
 * Vectors that know the gold alignment: every sentence of a gold bead gets that bead's own
 * random unit vector, every other sentence a vector of its own, so the semantic feature says
 * exactly what the translator did. What the real model approximates, taken to its limit.
 */
function oracleEmbeddings(gold: GoldFile, sentences: { de: readonly ParagraphSentence[]; en: readonly ParagraphSentence[] }): SentenceEmbeddings {
  let seed = 12345
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff - 0.5
  }
  const fresh = () => normalize(Float32Array.from({ length: 64 }, random))
  const de: (Float32Array | undefined)[] = []
  const en: (Float32Array | undefined)[] = []
  for (const b of gold.beads) {
    const v = fresh()
    for (const i of b.de) de[i] = v
    for (const j of b.en) en[j] = v
  }
  for (const s of sentences.de) if (de[s.idx] === undefined) de[s.idx] = fresh()
  for (const s of sentences.en) if (en[s.idx] === undefined) en[s.idx] = fresh()
  return { de, en }
}

describe('alignBook with embeddings', () => {
  // The Kafka novella takes a few seconds per pass, so everything is aligned once up here.
  const paraDe = parseTxt(read('kafka-verwandlung.de.txt'))
  const paraEn = parseTxt(read('kafka-verwandlung.en.txt'))
  const request = { de: { paragraphs: paraDe, sections: [] }, en: { paragraphs: paraEn, sections: [] } }
  const gold = JSON.parse(read('kafka-verwandlung.gold.json')) as GoldFile
  const plan = planBook(request)
  const whole = alignBook(request)
  const halves = alignPlanned(plan)
  const seen: AlignProgress[] = []
  const neural = alignPlanned(plan, null, (p) => seen.push(p), oracleEmbeddings(gold, plan.sentences))

  it('plans once, embeds only the paired chapters, and the two halves equal the whole', () => {
    const paired = pairedSentences(plan)
    expect(paired.de.length).toBeLessThan(plan.sentences.de.length)
    expect(paired.de.length).toBeGreaterThan(plan.sentences.de.length - 10)
    const chapters = new Set(plan.chapters.de.flatMap((c) => Array.from({ length: c.paraCount }, (_, k) => c.paraStart + k)))
    expect(paired.de.every((s) => chapters.has(s.paraIdx))).toBe(true)
    expect(halves.beads).toEqual(whole.beads)
    expect(halves.stats.neural).toBe(false)
    expect(whole.stats.neural).toBe(false)
  })

  it('reports the neural stat and the same stage order, and reaches every gold bead with oracle vectors', () => {
    expect(neural.stats.neural).toBe(true)
    expect([...new Set(seen.map((p) => p.stage))]).toEqual(['pass1', 'pass2'])
    expect(seen.at(-1)).toEqual({ stage: 'pass2', fraction: 0.95 })
    expect(scoreGold(neural.beads, gold).recall).toBe(1)
    // Every sentence is still covered exactly once: the model re-scores, it does not restructure.
    expect(neural.beads.flatMap((b) => b.deSentenceIdx)).toEqual(whole.beads.flatMap((b) => b.deSentenceIdx))
    expect(neural.beads.flatMap((b) => b.enSentenceIdx)).toEqual(whole.beads.flatMap((b) => b.enSentenceIdx))
  })
})

describe('oracle vectors on the Werther fixture', () => {
  const spec = PAIRS.find((p) => p.id === 'goethe-werther')!
  it.skipIf(!havePair(spec))('fix every two-sided bead the classical pass gets wrong', async () => {
    const request = await loadPair(spec)
    const gold = JSON.parse(readFileSync(pairPath(`tests/fixtures/${spec.id}.gold.json`), 'utf8')) as GoldFile
    const plan = planBook(request)
    const classical = scoreGold(alignPlanned(plan).beads, gold)
    const neural = scoreGold(alignPlanned(plan, null, undefined, oracleEmbeddings(gold, plan.sentences)).beads, gold)
    expect(classical.recall).toBeLessThan(1)
    expect(neural.recall).toBeGreaterThan(classical.recall)
    // What is left comes from the one-sided gold beads: a sentence the translator dropped and
    // a translator's aside. Similarity between two sides cannot speak for a bead that has only
    // one, so those pay the same fixed price as before and the DP still folds each into a
    // neighbour, costing that neighbour's bead too.
    const unpaired = {
      de: new Set(gold.beads.filter((b) => b.en.length === 0).flatMap((b) => b.de)),
      en: new Set(gold.beads.filter((b) => b.de.length === 0).flatMap((b) => b.en)),
    }
    expect(neural.spurious.length).toBeGreaterThan(0)
    for (const b of neural.spurious) {
      expect(b.deSentenceIdx.some((i) => unpaired.de.has(i)) || b.enSentenceIdx.some((j) => unpaired.en.has(j))).toBe(true)
    }
  }, 60_000)
})
