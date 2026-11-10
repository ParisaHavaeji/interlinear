/**
 * Alignment Layer C, part two (plan §1.2, step 10): the sentence bead DP.
 *
 * Inside one aligned paragraph block (a {@link ParagraphBead} of step 7) the German and English
 * sentences are aligned by dynamic programming over beads of 1-1, 1-2, 2-1, 1-0, 0-1 and 2-2
 * sentences. A bead's cost is the combined feature cost of step 9 (length fit, dictionary
 * overlap, cognates, punctuation shape, the overlap penalties scaled by the bead's size in
 * sentence pairs) plus the −log prior of its shape, the Gale–Church priors with 2-2 added. The
 * cheapest path through the grid is the alignment.
 *
 * Every bead also gets a **confidence**: the margin, in nats, between the best path and the
 * best path that does not contain this bead. A path avoids a bead exactly when it covers one
 * of the bead's sentences with a different bead, so the margin is found by running the DP
 * forwards and backwards once and then, for each chosen bead, taking the cheapest through-path
 * of any other bead that shares a sentence with it. A margin of zero means an equally good
 * alternative exists (the bead is a coin flip); three nats means the alternative is twenty
 * times less likely. {@link SentenceBead.confidence} maps the margin to the two-way posterior
 * 1 / (1 + e^−margin), so a tie is 0.5 and a sure bead is close to 1; the reader underlines
 * beads below a threshold that step 13 picks against the gold files.
 *
 * {@link alignBlocks} runs the DP over every paragraph block of a book and reports beads in
 * terms of `ParagraphSentence.idx`, ready for the `beads` table; step 12 feeds it the chapter
 * pairs' paragraph beads in reading order.
 */

import {
  beadFeatures,
  combinedCost,
  DEFAULT_WEIGHTS,
  prepareSentence,
  type FeatureWeights,
  type Lexicon,
  type PreparedSentence,
} from './features.ts'
import type { ParagraphSentence } from './sentences.ts'

/** One aligned group of sentences: positions into the two lists given to {@link alignSentences}. */
export interface SentenceBead {
  /** Indices of the German sentences in this bead (0, 1 or 2 of them). */
  de: number[]
  /** Indices of the English sentences in this bead (0, 1 or 2 of them). */
  en: number[]
  /** Cost of this bead in nats: the combined feature cost plus the shape's prior. */
  cost: number
  /**
   * How many nats the best path avoiding this bead costs more than the best path. Zero when an
   * equally good alternative exists; `Infinity` when no alternative covers these sentences.
   */
  margin: number
  /** The two-way posterior of the bead, 1 / (1 + e^−margin): 0.5 for a tie, near 1 when sure. */
  confidence: number
}

export interface AlignOptions {
  /** Expected English characters per German character; estimated from the sentences when omitted. */
  ratio?: number
  /** Gale–Church variance; defaults to the structure module's. */
  variance?: number
  /** Characters per nat for one-sided beads; defaults to the structure module's. */
  deletionScale?: number
  /** Feature weights; defaults to {@link DEFAULT_WEIGHTS}. */
  weights?: FeatureWeights
}

/**
 * Move table: [German sentences consumed, English sentences consumed, prior probability].
 * Gale & Church (1993), table 5.
 */
export const MOVES: readonly (readonly [number, number, number])[] = [
  [1, 1, 0.89],
  [1, 0, 0.0099],
  [0, 1, 0.0099],
  [2, 1, 0.089],
  [1, 2, 0.089],
  [2, 2, 0.011],
]
const MOVE_COSTS = MOVES.map(([, , prior]) => -Math.log(prior))
const K = MOVES.length

/** Character-length ratio of the English side to the German side, clamped to [0.5, 2]. */
export function estimateSentenceRatio(de: readonly PreparedSentence[], en: readonly PreparedSentence[]): number {
  const d = de.reduce((n, s) => n + s.chars, 0)
  const e = en.reduce((n, s) => n + s.chars, 0)
  if (d === 0 || e === 0) return 1
  return Math.min(2, Math.max(0.5, e / d))
}

/** Margin in nats → two-way posterior probability of the best path over its nearest rival. */
export function confidenceOf(margin: number): number {
  return 1 / (1 + Math.exp(-margin))
}

/**
 * Align the prepared sentences of one block by dynamic programming over the six bead shapes.
 * Every sentence of both sides lands in exactly one bead, beads are in reading order on both
 * sides, and the beads' costs sum to the minimum over all such alignments. Each bead carries
 * its margin and confidence (see the module comment).
 */
export function alignSentences(
  de: readonly PreparedSentence[],
  en: readonly PreparedSentence[],
  options: AlignOptions = {},
): SentenceBead[] {
  const n = de.length
  const m = en.length
  if (n === 0 && m === 0) return []
  const ratio = options.ratio ?? estimateSentenceRatio(de, en)
  const weights = options.weights ?? DEFAULT_WEIGHTS
  const featureOptions = { ratio, variance: options.variance, deletionScale: options.deletionScale }

  // edge[(i * width + j) * K + k]: cost of the bead that ends at cell (i, j) by move k,
  // Infinity when the move does not fit before the cell.
  const width = m + 1
  const cells = (n + 1) * width
  const edge = new Float64Array(cells * K).fill(Infinity)
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      for (let k = 0; k < K; k++) {
        const [a, b] = MOVES[k]
        if (i < a || j < b) continue
        const f = beadFeatures(de.slice(i - a, i), en.slice(j - b, j), featureOptions)
        edge[(i * width + j) * K + k] = combinedCost(f, weights, (a + b) / 2) + MOVE_COSTS[k]
      }
    }
  }

  // fwd[c]: cheapest path from (0, 0) to cell c; back[c]: the move that ends it.
  const fwd = new Float64Array(cells).fill(Infinity)
  const back = new Uint8Array(cells)
  fwd[0] = 0
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (i === 0 && j === 0) continue
      const c = i * width + j
      for (let k = 0; k < K; k++) {
        const [a, b] = MOVES[k]
        if (i < a || j < b) continue
        const total = fwd[(i - a) * width + (j - b)] + edge[c * K + k]
        if (total < fwd[c]) {
          fwd[c] = total
          back[c] = k
        }
      }
    }
  }

  // bwd[c]: cheapest path from cell c to (n, m).
  const bwd = new Float64Array(cells).fill(Infinity)
  bwd[cells - 1] = 0
  for (let i = n; i >= 0; i--) {
    for (let j = m; j >= 0; j--) {
      if (i === n && j === m) continue
      const c = i * width + j
      for (let k = 0; k < K; k++) {
        const [a, b] = MOVES[k]
        if (i + a > n || j + b > m) continue
        const head = (i + a) * width + (j + b)
        const total = edge[head * K + k] + bwd[head]
        if (total < bwd[c]) bwd[c] = total
      }
    }
  }

  const best = fwd[cells - 1]

  /** Cheapest complete path through the bead that ends at (i2, j2) by move k2. */
  const through = (i2: number, j2: number, k2: number): number => {
    const [a2, b2] = MOVES[k2]
    const head = i2 * width + j2
    return fwd[(i2 - a2) * width + (j2 - b2)] + edge[head * K + k2] + bwd[head]
  }

  /**
   * Cheapest path that does not contain the bead ending at (i, j) by move k: the best
   * through-path of any other bead sharing a German sentence (heads i2 in (i−a, i+1]) or an
   * English sentence (heads j2 in (j−b, j+1]) with it.
   */
  const secondBest = (i: number, j: number, k: number): number => {
    const [a, b] = MOVES[k]
    let second = Infinity
    const consider = (i2: number, j2: number): void => {
      for (let k2 = 0; k2 < K; k2++) {
        if (i2 === i && j2 === j && k2 === k) continue
        const [a2, b2] = MOVES[k2]
        if (i2 < a2 || j2 < b2) continue
        const sharesDe = a > 0 && a2 > 0 && i2 - a2 < i && i2 > i - a
        const sharesEn = b > 0 && b2 > 0 && j2 - b2 < j && j2 > j - b
        if (!sharesDe && !sharesEn) continue
        const t = through(i2, j2, k2)
        if (t < second) second = t
      }
    }
    for (let i2 = i - a + 1; i2 <= Math.min(n, i + 1); i2++) for (let j2 = 0; j2 <= m; j2++) consider(i2, j2)
    for (let j2 = j - b + 1; j2 <= Math.min(m, j + 1); j2++) for (let i2 = 0; i2 <= n; i2++) consider(i2, j2)
    return second
  }

  const beads: SentenceBead[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    const c = i * width + j
    const k = back[c]
    const [a, b] = MOVES[k]
    const margin = Math.max(0, secondBest(i, j, k) - best)
    beads.push({
      de: Array.from({ length: a }, (_, x) => i - a + x),
      en: Array.from({ length: b }, (_, y) => j - b + y),
      cost: edge[c * K + k],
      margin,
      confidence: confidenceOf(margin),
    })
    i -= a
    j -= b
  }
  beads.reverse()
  return beads
}

// ---------------------------------------------------------------------------------------------
// Whole-book alignment over paragraph blocks

/** One paragraph bead of step 7 expressed in `Paragraph.idx` values of the flat paragraph lists. */
export interface ParagraphBlock {
  de: readonly number[]
  en: readonly number[]
}

/** A sentence bead of the book: what the `beads` table stores minus book id and `manual`. */
export interface AlignedBead {
  /** `ParagraphSentence.idx` of the German sentences (0, 1 or 2 of them). */
  deSentenceIdx: number[]
  /** `ParagraphSentence.idx` of the English sentences (0, 1 or 2 of them). */
  enSentenceIdx: number[]
  cost: number
  margin: number
  confidence: number
}

/**
 * Align the sentences of a book block by block. `blocks` are the paragraph beads of every
 * aligned chapter pair, in reading order, as `Paragraph.idx` lists; sentences of paragraphs
 * outside every block (front matter, unmatched chapters) get no bead. The German side is
 * prepared with the lexicon (the dictionary of step 22, or an induced book lexicon of step 11);
 * pass `null` to align on length, cognates and punctuation alone. Unless given, the length
 * ratio is estimated over all the sentences passed, so a verbose translator is absorbed
 * book-wide rather than per block.
 */
export function alignBlocks(
  de: readonly ParagraphSentence[],
  en: readonly ParagraphSentence[],
  blocks: readonly ParagraphBlock[],
  lexicon: Lexicon | null,
  options: AlignOptions = {},
): AlignedBead[] {
  const prepDe = de.map((s) => prepareSentence(s.text, 'de', lexicon))
  const prepEn = en.map((s) => prepareSentence(s.text, 'en'))
  const ratio = options.ratio ?? estimateSentenceRatio(prepDe, prepEn)
  const byPara = (sentences: readonly ParagraphSentence[]): Map<number, number[]> => {
    const map = new Map<number, number[]>()
    for (const [pos, s] of sentences.entries()) {
      const list = map.get(s.paraIdx)
      if (list === undefined) map.set(s.paraIdx, [pos])
      else list.push(pos)
    }
    return map
  }
  const deByPara = byPara(de)
  const enByPara = byPara(en)

  const out: AlignedBead[] = []
  for (const block of blocks) {
    const dePos = block.de.flatMap((p) => deByPara.get(p) ?? [])
    const enPos = block.en.flatMap((p) => enByPara.get(p) ?? [])
    const beads = alignSentences(
      dePos.map((p) => prepDe[p]),
      enPos.map((p) => prepEn[p]),
      { ...options, ratio },
    )
    for (const bead of beads) {
      out.push({
        deSentenceIdx: bead.de.map((x) => de[dePos[x]].idx),
        enSentenceIdx: bead.en.map((y) => en[enPos[y]].idx),
        cost: bead.cost,
        margin: bead.margin,
        confidence: bead.confidence,
      })
    }
  }
  return out
}
