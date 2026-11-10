// The gold alignments of plan.md step 13: the gold module itself, and the aligner measured
// against the three hand-checked files. The Demian pair lives in Input/ (not in the repo) and
// its tests are skipped when the EPUBs are absent.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AlignedBead } from '../src/align/beads.ts'
import {
  checkGoldSentences,
  goldFromBeads,
  hashText,
  scoreGold,
  validateGoldBeads,
  withSentenceHashes,
  type GoldFile,
} from '../src/align/gold.ts'
import { alignBook, LOW_CONFIDENCE } from '../src/align/pipeline.ts'
import { havePair, loadPair, pairPath, PAIRS } from '../tools/pairs.ts'

const bead = (de: number[], en: number[], confidence = 1): AlignedBead => ({ deSentenceIdx: de, enSentenceIdx: en, cost: 0, margin: 0, confidence })
const sentences = (texts: string[]) => texts.map((text, idx) => ({ idx, text }))

describe('hashText', () => {
  it('is eight hex digits, stable, and sensitive to every character', () => {
    expect(hashText('')).toBe('811c9dc5')
    expect(hashText('Gregor')).toMatch(/^[0-9a-f]{8}$/)
    expect(hashText('Gregor')).toBe(hashText('Gregor'))
    expect(hashText('Gregor')).not.toBe(hashText('Gregor.'))
    expect(hashText('ä')).not.toBe(hashText('a'))
  })
})

describe('goldFromBeads / withSentenceHashes', () => {
  const de = sentences(['I.', 'Gregor lachte.', 'Samsa schlief.', 'Die Mutter kam.'])
  const en = sentences(['I.', 'Gregor laughed.', 'Samsa slept.', 'Mother came.'])

  it('takes the first n beads and hashes exactly the sentences they cover', () => {
    const gold = goldFromBeads('test', { de: 'a.txt', en: 'b.txt' }, { de, en }, [bead([1], [1]), bead([2, 3], [2]), bead([], [3])], 2)
    expect(gold.beads).toEqual([
      { de: [1], en: [1] },
      { de: [2, 3], en: [2] },
    ])
    expect(Object.keys(gold.sentences.de)).toEqual(['1', '2', '3'])
    expect(Object.keys(gold.sentences.en)).toEqual(['1', '2'])
    expect(gold.sentences.de['1']).toBe(hashText('Gregor lachte.'))
  })

  it('refuses a bead that names a sentence that does not exist', () => {
    expect(() => withSentenceHashes({ book: 't', sources: { de: '', en: '' }, sentences: { de: {}, en: {} }, beads: [{ de: [9], en: [] }] }, { de, en })).toThrow(
      /German sentence 9/,
    )
  })
})

describe('validateGoldBeads', () => {
  it('accepts a well-formed alignment, 1-3 beads included', () => {
    expect(
      validateGoldBeads([
        { de: [0], en: [0, 1, 2] },
        { de: [1], en: [] },
        { de: [], en: [3] },
        { de: [2, 3], en: [4] },
      ]),
    ).toEqual([])
  })

  it('reports duplicates, disorder, gaps and empty beads', () => {
    expect(validateGoldBeads([{ de: [0], en: [0] }, { de: [0], en: [1] }])).toEqual(['de sentence 0 appears twice'])
    expect(validateGoldBeads([{ de: [1], en: [0] }, { de: [0], en: [1] }])).toEqual(['de sentences 1 and 0 are out of order'])
    expect(validateGoldBeads([{ de: [0], en: [0] }, { de: [2], en: [1] }])).toEqual(['de sentence 1 is covered by no bead'])
    expect(validateGoldBeads([{ de: [], en: [] }])).toEqual(['a bead is empty on both sides'])
  })

  it('lets the caller excuse gaps that hold headings', () => {
    const beads = [{ de: [0], en: [0] }, { de: [2], en: [2] }]
    expect(validateGoldBeads(beads, (_side, idx) => idx !== 1)).toEqual([])
  })
})

describe('checkGoldSentences', () => {
  it('names every sentence whose text no longer matches its hash', () => {
    const de = sentences(['A.', 'B.'])
    const en = sentences(['A.', 'B.'])
    const gold = goldFromBeads('t', { de: '', en: '' }, { de, en }, [bead([0], [0]), bead([1], [1])], 2)
    expect(checkGoldSentences(gold, { de, en })).toEqual([])
    expect(checkGoldSentences(gold, { de: sentences(['A.', 'C.']), en: sentences(['A.']) })).toEqual(['de 1', 'en 1'])
  })
})

describe('scoreGold', () => {
  const gold: GoldFile = {
    book: 't',
    sources: { de: '', en: '' },
    sentences: { de: {}, en: {} },
    beads: [
      { de: [1], en: [1] },
      { de: [2], en: [2, 3] },
      { de: [3], en: [4] },
      { de: [4], en: [5] },
    ],
  }

  it('counts exact bead matches and ignores beads outside the gold range', () => {
    const beads = [bead([0], [0]), bead([1], [1]), bead([2], [2]), bead([], [3], 0.5), bead([3], [4]), bead([4], [5]), bead([5], [6])]
    const s = scoreGold(beads, gold)
    expect(s).toMatchObject({ gold: 4, predicted: 5, correct: 3 })
    expect(s.recall).toBeCloseTo(0.75)
    expect(s.precision).toBeCloseTo(0.6)
    expect(s.missed).toEqual([{ de: [2], en: [2, 3] }])
    expect(s.spurious.map((b) => [b.deSentenceIdx, b.enSentenceIdx])).toEqual([[[2], [2]], [[], [3]]])
    expect(s.judged.map((j) => j.correct)).toEqual([true, false, false, true, true])
  })

  it('counts a bead that straddles the range boundary as predicted', () => {
    const s = scoreGold([bead([1], [1]), bead([2], [2, 3]), bead([3], [4]), bead([4, 5], [5])], gold)
    expect(s).toMatchObject({ gold: 4, predicted: 4, correct: 3 })
  })

  it('is perfect on an empty gold file', () => {
    expect(scoreGold([], { ...gold, beads: [] })).toMatchObject({ recall: 1, precision: 1, f1: 1 })
  })
})

// ---------------------------------------------------------------------------------------------
// The aligner against the hand-checked beads. Floors are what the tuned defaults reach now, a
// little below so a platform rounding difference does not fail CI; step 14 raises them to the
// plan's targets (≥97% Kafka, ≥95% Demian, ≥93% Werther).

const FLOORS: Record<string, number> = {
  'kafka-verwandlung': 0.99,
  'hesse-demian': 0.97,
  'goethe-werther': 0.86,
}

describe.each(PAIRS)('gold alignment of $id', (spec) => {
  const available = havePair(spec)
  const gold = JSON.parse(readFileSync(pairPath(`tests/fixtures/${spec.id}.gold.json`), 'utf8')) as GoldFile

  it('is a well-formed gold file for this pair', () => {
    expect(gold.book).toBe(spec.id)
    expect(gold.beads.length).toBeGreaterThanOrEqual(140)
    expect(validateGoldBeads(gold.beads, () => false)).toEqual([])
    for (const side of ['de', 'en'] as const) {
      for (const idx of gold.beads.flatMap((b) => b[side])) expect(gold.sentences[side][String(idx)]).toMatch(/^[0-9a-f]{8}$/)
    }
  })

  it.skipIf(!available)('is graded on the same sentences the gold was checked against', async () => {
    const result = alignBook(await loadPair(spec))
    expect(checkGoldSentences(gold, result.sentences)).toEqual([])
    const beaded = { de: new Set(result.beads.flatMap((b) => b.deSentenceIdx)), en: new Set(result.beads.flatMap((b) => b.enSentenceIdx)) }
    expect(validateGoldBeads(gold.beads, (side, idx) => beaded[side].has(idx))).toEqual([])
  })

  it.skipIf(!available)(`reaches the recall floor of ${Math.round(100 * FLOORS[spec.id])}%`, async () => {
    const result = alignBook(await loadPair(spec))
    const score = scoreGold(result.beads, gold)
    expect(score.recall).toBeGreaterThanOrEqual(FLOORS[spec.id])
    // The uncertain flag should catch a good share of what went wrong without drowning it.
    const wrong = score.judged.filter((j) => !j.correct)
    const flagged = score.judged.filter((j) => j.bead.confidence <= LOW_CONFIDENCE)
    if (wrong.length > 0) expect(flagged.filter((j) => !j.correct).length / wrong.length).toBeGreaterThan(0.3)
    expect(flagged.length).toBeLessThan(score.judged.length / 4)
  })
})
