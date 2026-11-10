/**
 * Alignment Layer A (plan §1.2, step 7): structure anchors.
 *
 * 1. Chapter detection. EPUB imports already carry one section per spine item with a detected
 *    heading and kind; plain text gets the same heading heuristics run over its paragraphs, so
 *    "Kapitel 3", "CHAPTER THREE", "II.", "Am 4. Mai 1771" and friends start a new chapter.
 *    Either way the result is a flat list of {@link Chapter}s, the unit the chapter-mapping DP
 *    (step 5b) pairs across the two editions and inside which all further alignment happens.
 *
 * 2. Paragraph alignment inside one chapter pair: Gale–Church dynamic programming over paragraph
 *    character lengths with 1-1, 1-2, 2-1, 1-0 and 0-1 moves (deletions priced linearly in
 *    length rather than by the normal tail, see {@link deletionCost}). Translators keep
 *    paragraphs far more faithfully than sentences, so these beads bound the sentence DP of
 *    step 10.
 */

import { countWords, isHeadingLine } from '../import/sections.ts'
import type { Paragraph, SectionKind } from '../import/types.ts'

/** A run of paragraphs under one heading: the unit chapter mapping and alignment work on. */
export interface Chapter {
  /** 0-based position in the book's chapter list. */
  idx: number
  /** Heading lines joined with ": " ("BOOK I: MAY 4."), or null when none was detected. */
  heading: string | null
  /** Spine index of the section this chapter came from (EPUB), null for plain text. */
  sectionIdx: number | null
  /** Position of `paragraphs[0]` in the import's flat paragraph list. */
  paraStart: number
  /** Prose paragraphs in reading order, heading lines removed. */
  paragraphs: Paragraph[]
  words: number
}

/** The slice of a section record that chapter building needs (see `SectionMeta` in the store). */
export interface SectionRange {
  idx: number
  title: string | null
  heading: string | null
  kind: SectionKind
  linear: boolean
  paraStart: number
  paraCount: number
}

/** At most this many consecutive heading lines form one heading ("Erstes Buch" + "Am 4. Mai 1771"). */
const MAX_HEADING_LINES = 3

/**
 * Split a plain-text paragraph list into chapters at heading lines (plan §1.2 Layer A: the
 * EPUB heading heuristics run on paragraphs). Up to three consecutive heading lines are joined
 * into one heading; a longer run of short lines (an epigraph, a poem) stays body text after the
 * third. Text before the first heading becomes a chapter without a heading. Heading lines at
 * the very end ("ENDE", "THE END") are kept as prose of the last chapter rather than opening an
 * empty one. A text with no headings at all is one chapter.
 */
export function chaptersFromParagraphs(paragraphs: readonly Paragraph[]): Chapter[] {
  const chapters: Chapter[] = []
  let heading: string | null = null
  let paraStart = 0
  let body: Paragraph[] = []

  const flush = (): void => {
    if (body.length === 0 && heading === null) return
    chapters.push({ idx: chapters.length, heading, sectionIdx: null, paraStart, paragraphs: body, words: countWords(body) })
  }

  let i = 0
  while (i < paragraphs.length) {
    // Length of the run of heading-like lines starting here.
    let run = 0
    while (i + run < paragraphs.length && isHeadingLine(paragraphs[i + run].text)) run++
    if (run > 0 && i + run < paragraphs.length) {
      const take = Math.min(run, MAX_HEADING_LINES)
      flush()
      heading = paragraphs.slice(i, i + take).map((p) => p.text).join(': ')
      paraStart = i + take
      // The rest of an over-long run is body text, not further headings.
      body = paragraphs.slice(i + take, i + run)
      i += run
      continue
    }
    if (body.length === 0 && heading === null) paraStart = i
    body.push(paragraphs[i])
    i++
  }
  flush()
  return chapters
}

/**
 * One chapter per body section of an EPUB, in spine order. Front and back matter and
 * non-linear items are skipped: they take no part in alignment, though the chapter list sheet
 * still shows them (plan §1.1b). The heading is the detected one, else the navigation title.
 */
export function chaptersFromSections(sections: readonly SectionRange[], paragraphs: readonly Paragraph[]): Chapter[] {
  const chapters: Chapter[] = []
  for (const s of sections) {
    if (s.kind !== 'body' || !s.linear || s.paraCount === 0) continue
    const body = paragraphs.slice(s.paraStart, s.paraStart + s.paraCount)
    chapters.push({
      idx: chapters.length,
      heading: s.heading ?? s.title,
      sectionIdx: s.idx,
      paraStart: s.paraStart,
      paragraphs: body,
      words: countWords(body),
    })
  }
  return chapters
}

/** Chapters of an imported text: by section for EPUBs, by heading line for plain text. */
export function chaptersOf(text: { paragraphs: readonly Paragraph[]; sections: readonly SectionRange[] }): Chapter[] {
  return text.sections.length > 0 ? chaptersFromSections(text.sections, text.paragraphs) : chaptersFromParagraphs(text.paragraphs)
}

// ---------------------------------------------------------------------------------------------
// Paragraph alignment

/** One aligned group of paragraphs: positions into the two lists given to {@link alignParagraphs}. */
export interface ParagraphBead {
  /** Indices of the German paragraphs in this bead (0, 1 or 2 of them). */
  de: number[]
  /** Indices of the English paragraphs in this bead (0, 1 or 2 of them). */
  en: number[]
  /** Cost of this bead in nats: length fit ({@link lengthCost} or {@link deletionCost}) plus the move's prior. */
  cost: number
}

export interface LengthModelOptions {
  /**
   * Expected English characters per German character. Estimated from the two lists when
   * omitted, which absorbs a translator's verbosity; clamped to [0.5, 2].
   */
  ratio?: number
  /** Gale–Church variance of the length difference per character. */
  variance?: number
  /** Characters of unmatched text per nat of deletion cost (see {@link deletionCost}). */
  deletionScale?: number
}

/** Gale & Church (1993): variance of the character-length difference per source character. */
const DEFAULT_VARIANCE = 6.8
/** A dropped paragraph costs one nat per this many characters, on top of the move's prior. */
const DEFAULT_DELETION_SCALE = 100

/** Move table: [German paragraphs consumed, English paragraphs consumed, prior probability]. */
const MOVES: readonly (readonly [number, number, number])[] = [
  [1, 1, 0.89],
  [1, 0, 0.0099],
  [0, 1, 0.0099],
  [2, 1, 0.089],
  [1, 2, 0.089],
]

/**
 * log(erfc(x)) for x ≥ 0 via the Chebyshev fit from Numerical Recipes (fractional error below
 * 1.2e-7), taken in the log domain so deep tails neither underflow nor get clamped: a 0-1 bead
 * of a long paragraph stays more expensive than one of a short paragraph.
 */
export function logErfc(x: number): number {
  const t = 1 / (1 + 0.5 * x)
  const poly =
    -1.26551223 +
    t *
      (1.00002368 +
        t *
          (0.37409196 +
            t *
              (0.09678418 +
                t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
  return Math.log(t) - x * x + poly
}

/**
 * Gale–Church length cost in nats for a bead whose sides total `de` and `en` characters:
 * −log of the two-sided probability of the observed length difference under a normal model
 * with mean 0 and variance proportional to length. Zero for an empty bead.
 */
export function lengthCost(de: number, en: number, ratio: number, variance = DEFAULT_VARIANCE): number {
  if (de === 0 && en === 0) return 0
  const mean = (de + en / ratio) / 2
  const z = Math.abs(en - de * ratio) / Math.sqrt(mean * variance)
  // P(|Z| ≥ z) = erfc(z / √2)
  return -logErfc(z / Math.SQRT2)
}

/**
 * Cost in nats of a 1-0 or 0-1 bead holding `chars` characters: linear in length, i.e. an
 * exponential prior on how much text a translator drops or adds. Gale–Church's normal tail
 * is not used here: under it a dropped paragraph of any length costs more than merging it
 * into a neighbour, and a long one costs more than distorting a whole run of neighbours, so
 * deletions would never be chosen and errors would cascade instead of staying local.
 */
export function deletionCost(chars: number, scale = DEFAULT_DELETION_SCALE): number {
  return chars / scale
}

/** Character-length ratio of the English side to the German side, clamped to a sane range. */
export function estimateRatio(de: readonly { text: string }[], en: readonly { text: string }[]): number {
  const sum = (ps: readonly { text: string }[]) => ps.reduce((n, p) => n + p.text.length, 0)
  const d = sum(de)
  const e = sum(en)
  if (d === 0 || e === 0) return 1
  return Math.min(2, Math.max(0.5, e / d))
}

/**
 * Align the paragraphs of one chapter pair by dynamic programming over character lengths
 * (Gale & Church 1993) with 1-1, 1-2, 2-1, 1-0 and 0-1 moves. Every paragraph of both sides
 * lands in exactly one bead, beads are in reading order on both sides, and the beads' costs
 * sum to the minimum over all such alignments.
 */
export function alignParagraphs(
  de: readonly { text: string }[],
  en: readonly { text: string }[],
  options: LengthModelOptions = {},
): ParagraphBead[] {
  const n = de.length
  const m = en.length
  if (n === 0 && m === 0) return []
  const ratio = options.ratio ?? estimateRatio(de, en)
  const variance = options.variance ?? DEFAULT_VARIANCE
  const deletionScale = options.deletionScale ?? DEFAULT_DELETION_SCALE
  const lenDe = de.map((p) => p.text.length)
  const lenEn = en.map((p) => p.text.length)
  const moveCosts = MOVES.map(([, , prior]) => -Math.log(prior))

  // cost[i * width + j]: cheapest alignment of the first i German and first j English paragraphs.
  const width = m + 1
  const cost = new Float64Array((n + 1) * width).fill(Infinity)
  const back = new Uint8Array((n + 1) * width)
  cost[0] = 0
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (i === 0 && j === 0) continue
      let best = Infinity
      let bestMove = 0
      for (let k = 0; k < MOVES.length; k++) {
        const [takeDe, takeEn] = MOVES[k]
        if (i < takeDe || j < takeEn) continue
        const prev = cost[(i - takeDe) * width + (j - takeEn)]
        if (prev === Infinity) continue
        let d = 0
        for (let a = i - takeDe; a < i; a++) d += lenDe[a]
        let e = 0
        for (let b = j - takeEn; b < j; b++) e += lenEn[b]
        const fit = takeDe === 0 || takeEn === 0 ? deletionCost(d + e, deletionScale) : lengthCost(d, e, ratio, variance)
        const c = prev + fit + moveCosts[k]
        if (c < best) {
          best = c
          bestMove = k
        }
      }
      cost[i * width + j] = best
      back[i * width + j] = bestMove
    }
  }

  const beads: ParagraphBead[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    const k = back[i * width + j]
    const [takeDe, takeEn] = MOVES[k]
    const deIdx = Array.from({ length: takeDe }, (_, a) => i - takeDe + a)
    const enIdx = Array.from({ length: takeEn }, (_, b) => j - takeEn + b)
    beads.push({ de: deIdx, en: enIdx, cost: cost[i * width + j] - cost[(i - takeDe) * width + (j - takeEn)] })
    i -= takeDe
    j -= takeEn
  }
  beads.reverse()
  return beads
}
