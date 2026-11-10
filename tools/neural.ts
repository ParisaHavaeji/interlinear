// Grade the neural re-alignment of plan.md step 15 against the gold files, with the real model
// running under Node (transformers.js + onnxruntime-node; the first run downloads ~120 MB into
// node_modules/@huggingface/transformers/.cache).
//
//   node tools/neural.ts score [--pairs kafka-verwandlung,hesse-demian,goethe-werther]
//                              [--weights 0,3,6,9,12] [--all] [--verbose]
//
// For each pair the book is planned, the sentences of the chapter pairs that touch the gold
// range are embedded (every paired chapter with --all) and cached under node_modules/.cache,
// and the two passes run once per semantic weight. The table shows the gold recall of the
// classical alignment (weight 0, no vectors) and of every weight, so SEMANTIC_WEIGHT in
// src/align/neural.ts can be checked or moved. Nothing is written to the repository.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { scoreGold, type GoldFile } from '../src/align/gold.ts'
import { loadEmbedder } from '../src/align/neural-model.ts'
import { embedSentences, EMBEDDING_DIM, SEMANTIC_WEIGHT, type Embedder, type SentenceEmbeddings } from '../src/align/neural.ts'
import { alignPlanned, planBook, type BookPlan } from '../src/align/pipeline.ts'
import type { ParagraphSentence } from '../src/align/sentences.ts'
import { havePair, loadPair, pairById, pairPath, PAIRS, type PairSpec } from './pairs.ts'

const args = process.argv.slice(2)
const command = args[0]
const option = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
if (command !== 'score') {
  console.error('usage: node tools/neural.ts score [--pairs a,b] [--weights 0,3,6,9] [--all]')
  process.exit(2)
}
const wanted = option('--pairs')?.split(',').map(pairById) ?? PAIRS
const weights = (option('--weights') ?? `0,3,${SEMANTIC_WEIGHT},9,12`).split(',').map(Number)
const all = args.includes('--all')
/** Print the texts of the wrong beads at SEMANTIC_WEIGHT. */
const verbose = args.includes('--verbose')

const CACHE_DIR = fileURLToPath(new URL('../node_modules/.cache/interlinear-neural/', import.meta.url))
mkdirSync(CACHE_DIR, { recursive: true })

/** The chapter pairs whose sentences the gold file covers (every pair with --all). */
function pairsToEmbed(plan: BookPlan, gold: GoldFile): number[] {
  if (all) return plan.perPair.map((_, k) => k)
  const goldDe = new Set(gold.beads.flatMap((b) => b.de))
  const goldEn = new Set(gold.beads.flatMap((b) => b.en))
  return plan.perPair.flatMap((p, k) => (p.de.some((s) => goldDe.has(s.idx)) || p.en.some((s) => goldEn.has(s.idx)) ? [k] : []))
}

/** Vectors as one Float32Array per side plus the idx list, so a 3,500-sentence book is a few MB. */
interface Cached {
  idx: Record<'de' | 'en', number[]>
}

function cachePaths(spec: PairSpec, suffix: string) {
  return { meta: `${CACHE_DIR}${spec.id}${suffix}.json`, de: `${CACHE_DIR}${spec.id}${suffix}.de.f32`, en: `${CACHE_DIR}${spec.id}${suffix}.en.f32` }
}

function readCached(spec: PairSpec, suffix: string): SentenceEmbeddings | null {
  const paths = cachePaths(spec, suffix)
  if (!existsSync(paths.meta) || !existsSync(paths.de) || !existsSync(paths.en)) return null
  const meta = JSON.parse(readFileSync(paths.meta, 'utf8')) as Cached
  const side = (file: string, idx: number[]): (Float32Array | undefined)[] => {
    const buf = readFileSync(file)
    const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
    const out: (Float32Array | undefined)[] = []
    idx.forEach((i, k) => {
      out[i] = floats.slice(k * EMBEDDING_DIM, (k + 1) * EMBEDDING_DIM)
    })
    return out
  }
  return { de: side(paths.de, meta.idx.de), en: side(paths.en, meta.idx.en) }
}

function writeCached(spec: PairSpec, suffix: string, sentences: Record<'de' | 'en', ParagraphSentence[]>, emb: SentenceEmbeddings): void {
  const paths = cachePaths(spec, suffix)
  const meta: Cached = { idx: { de: sentences.de.map((s) => s.idx), en: sentences.en.map((s) => s.idx) } }
  writeFileSync(paths.meta, JSON.stringify(meta))
  for (const lang of ['de', 'en'] as const) {
    const flat = new Float32Array(sentences[lang].length * EMBEDDING_DIM)
    sentences[lang].forEach((s, k) => flat.set(emb[lang][s.idx]!, k * EMBEDDING_DIM))
    writeFileSync(paths[lang], Buffer.from(flat.buffer))
  }
}

const loaded: { embedder: Embedder | null } = { embedder: null }
async function model(): Promise<Embedder> {
  if (loaded.embedder !== null) return loaded.embedder
  let last = -1
  loaded.embedder = await loadEmbedder({
    device: 'cpu',
    onDownload: (f) => {
      const pct = Math.round(f * 100)
      if (pct !== last && pct % 10 === 0) console.log(`  model ${pct}%`)
      last = pct
    },
  })
  return loaded.embedder
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`

for (const spec of wanted) {
  if (!havePair(spec)) {
    console.log(`${spec.id}: skipped (files missing)`)
    continue
  }
  const gold = JSON.parse(readFileSync(pairPath(`tests/fixtures/${spec.id}.gold.json`), 'utf8')) as GoldFile
  const plan = planBook(await loadPair(spec))
  const chosen = pairsToEmbed(plan, gold)
  const sentences = { de: chosen.flatMap((k) => plan.perPair[k].de), en: chosen.flatMap((k) => plan.perPair[k].en) }
  const suffix = all ? '.all' : '.gold'
  let embeddings = readCached(spec, suffix)
  if (embeddings === null) {
    console.log(`${spec.id}: embedding ${sentences.de.length} + ${sentences.en.length} sentences of ${chosen.length} chapter pair(s)…`)
    const t0 = performance.now()
    let shown = -1
    embeddings = await embedSentences(await model(), sentences, {
      onProgress: (done, total) => {
        const p = Math.floor((10 * done) / total)
        if (p !== shown) {
          shown = p
          console.log(`  ${done}/${total}`)
        }
      },
    })
    console.log(`  ${Math.round(performance.now() - t0)} ms`)
    writeCached(spec, suffix, sentences, embeddings)
  } else {
    console.log(`${spec.id}: embeddings from cache (${sentences.de.length} + ${sentences.en.length} sentences)`)
  }

  const classical = scoreGold(alignPlanned(plan).beads, gold)
  console.log(`  classical          ${pct(classical.recall)} (${classical.correct}/${classical.gold})`)
  for (const w of weights) {
    const result = alignPlanned({ ...plan, options: { ...plan.options, weights: { lexical: 5, cognate: 1.5, punctuation: 0.5, semantic: w } } }, null, undefined, embeddings)
    const score = scoreGold(result.beads, gold)
    const marker = w === SEMANTIC_WEIGHT ? ' ←' : ''
    console.log(`  semantic ${String(w).padEnd(9)} ${pct(score.recall)} (${score.correct}/${score.gold})  uncertain ${result.stats.uncertain}${marker}`)
    if (score.missed.length > 0) console.log(`    missed  ${score.missed.map((m) => `${m.de.join('+')}:${m.en.join('+')}`).join('  ')}`)
    if (score.spurious.length > 0) {
      console.log(`    instead ${score.spurious.map((b) => `${b.deSentenceIdx.join('+')}:${b.enSentenceIdx.join('+')} (${b.confidence.toFixed(2)})`).join('  ')}`)
    }
    if (w === SEMANTIC_WEIGHT && verbose) {
      for (const b of score.spurious) {
        for (const i of b.deSentenceIdx) console.log(`      de ${i}  ${plan.sentences.de[i].text}`)
        for (const j of b.enSentenceIdx) console.log(`      en ${j}  ${plan.sentences.en[j].text}`)
      }
    }
  }
}

await loaded.embedder?.dispose?.()
