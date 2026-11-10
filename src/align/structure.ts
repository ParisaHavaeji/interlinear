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
 *    character lengths with 1-1, 1-2, 2-1, 1-3, 3-1, 1-4, 4-1, 1-0 and 0-1 moves (deletions priced linearly in
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

/**
 * The reader's corrections to one side's structure (plan §1.1b, step 17), by {@link chapterKey}:
 * sections forced into the aligned text although they look like front or back matter, and
 * sections (or plain-text chapters) forced out of it.
 */
export interface SideEdits {
  include?: number[]
  exclude?: number[]
}

/** A chapter pair the reader set by hand: chapter keys of each side (see {@link chapterKey}). */
export interface PairEdit {
  de: number[]
  en: number[]
}

/** Every correction the reader made to a book's chapters; the aligner applies them on every run. */
export interface ChapterEdits {
  de?: SideEdits
  en?: SideEdits
  /** Pairs set by hand; the DP pairs whatever chapters they leave free. */
  pairs?: PairEdit[]
}

/**
 * The stable key of a chapter on one side, which the edits refer to: the spine index for an
 * EPUB section, else the index of the chapter's first paragraph. Chapter positions (`idx`)
 * shift when a section is included or excluded; keys do not.
 */
export function chapterKey(c: { sectionIdx: number | null; paraStart: number }): number {
  return c.sectionIdx ?? c.paraStart
}

/** What one side's chapter detection found: the chapters to align, and what was left out. */
export interface Structure {
  chapters: Chapter[]
  /**
   * Sections (or chapters) that take no part in alignment, in reading order: front and back
   * matter, non-linear spine items, and whatever the reader excluded. Their `idx` is their
   * position in this list. Listed so the chapter sheet can show and reverse the decision.
   */
  excluded: Chapter[]
}

/** At most this many consecutive heading lines form one heading ("Erstes Buch" + "Am 4. Mai 1771"). */
const MAX_HEADING_LINES = 3

/**
 * Split a plain-text paragraph list into chapters at heading lines (plan §1.2 Layer A: the
 * EPUB heading heuristics run on paragraphs). Up to three consecutive heading lines are joined
 * into one heading; a longer run of short lines (an epigraph, a poem) stays body text after the
 * third. Text before the first heading becomes a chapter without a heading. Heading lines at
 * the very end ("ENDE", "THE END") are kept as prose of the last chapter rather than opening an
 * empty one. A text with no headings at all is one chapter. Chapters whose key the reader
 * excluded (`edits.exclude`) are left out and the rest renumbered; `structureFromParagraphs`
 * also returns them.
 */
export function chaptersFromParagraphs(paragraphs: readonly Paragraph[], edits?: SideEdits): Chapter[] {
  return structureFromParagraphs(paragraphs, edits).chapters
}

/** {@link chaptersFromParagraphs} plus the chapters the reader excluded. */
export function structureFromParagraphs(paragraphs: readonly Paragraph[], edits?: SideEdits): Structure {
  const all = detectChapters(paragraphs)
  const excluded = new Set(edits?.exclude ?? [])
  if (excluded.size === 0) return { chapters: all, excluded: [] }
  const out: Structure = { chapters: [], excluded: [] }
  for (const c of all) {
    const list = excluded.has(chapterKey(c)) ? out.excluded : out.chapters
    list.push({ ...c, idx: list.length })
  }
  return out
}

function detectChapters(paragraphs: readonly Paragraph[]): Chapter[] {
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
 * The reader's edits override the detected kind: an included section is a chapter whatever
 * it looks like, an excluded one is not. Empty sections are neither.
 */
export function chaptersFromSections(sections: readonly SectionRange[], paragraphs: readonly Paragraph[], edits?: SideEdits): Chapter[] {
  return structureFromSections(sections, paragraphs, edits).chapters
}

/** True when a section takes part in alignment unless the reader says otherwise. */
export function isBodyByDefault(s: Pick<SectionRange, 'kind' | 'linear'>): boolean {
  return s.kind === 'body' && s.linear
}

/** {@link chaptersFromSections} plus the sections left out, as chapters of their own list. */
export function structureFromSections(sections: readonly SectionRange[], paragraphs: readonly Paragraph[], edits?: SideEdits): Structure {
  const include = new Set(edits?.include ?? [])
  const exclude = new Set(edits?.exclude ?? [])
  const out: Structure = { chapters: [], excluded: [] }
  for (const s of sections) {
    if (s.paraCount === 0) continue
    const body = paragraphs.slice(s.paraStart, s.paraStart + s.paraCount)
    const included = exclude.has(s.idx) ? false : include.has(s.idx) || isBodyByDefault(s)
    const list = included ? out.chapters : out.excluded
    list.push({
      idx: list.length,
      heading: s.heading ?? s.title,
      sectionIdx: s.idx,
      paraStart: s.paraStart,
      paragraphs: body,
      words: countWords(body),
    })
  }
  return out
}

/** Chapters of an imported text: by section for EPUBs, by heading line for plain text. */
export function chaptersOf(text: { paragraphs: readonly Paragraph[]; sections: readonly SectionRange[] }, edits?: SideEdits): Chapter[] {
  return structureOf(text, edits).chapters
}

/** {@link chaptersOf} with the excluded sections alongside. */
export function structureOf(text: { paragraphs: readonly Paragraph[]; sections: readonly SectionRange[] }, edits?: SideEdits): Structure {
  return text.sections.length > 0 ? structureFromSections(text.sections, text.paragraphs, edits) : structureFromParagraphs(text.paragraphs, edits)
}

// ---------------------------------------------------------------------------------------------
// Paragraph alignment

/** One aligned group of paragraphs: positions into the two lists given to {@link alignParagraphs}. */
export interface ParagraphBead {
  /** Indices of the German paragraphs in this bead (0 to 4 of them; both sides never exceed 5 together). */
  de: number[]
  /** Indices of the English paragraphs in this bead (0 to 4 of them). */
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

/**
 * Move table: [German paragraphs consumed, English paragraphs consumed, prior probability].
 * Gale & Church's priors for 1-1, 1-0, 0-1, 2-1 and 1-2, plus 3-1, 1-3, 4-1 and 1-4 with priors
 * falling by about a factor of four per extra paragraph: a translator who runs four short
 * paragraphs together (Boylan does, in Werther) must be met with one bead, since the only
 * alternative under a 2-1 cap is a run of one-sided beads that misplaces every sentence in it.
 */
const MOVES: readonly (readonly [number, number, number])[] = [
  [1, 1, 0.89],
  [1, 0, 0.0099],
  [0, 1, 0.0099],
  [2, 1, 0.089],
  [1, 2, 0.089],
  [3, 1, 0.02],
  [1, 3, 0.02],
  [4, 1, 0.005],
  [1, 4, 0.005],
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

/** English-to-German length ratio from two totals, clamped to [0.5, 2]; 1 when either is empty. */
export function ratioOf(deChars: number, enChars: number): number {
  if (deChars === 0 || enChars === 0) return 1
  return Math.min(2, Math.max(0.5, enChars / deChars))
}

/** Character-length ratio of the English side to the German side, clamped to a sane range. */
export function estimateRatio(de: readonly { text: string }[], en: readonly { text: string }[]): number {
  const sum = (ps: readonly { text: string }[]) => ps.reduce((n, p) => n + p.text.length, 0)
  return ratioOf(sum(de), sum(en))
}

/**
 * Align the paragraphs of one chapter pair by dynamic programming over character lengths
 * (Gale & Church 1993) with 1-1, 1-2, 2-1, 1-3, 3-1, 1-4, 4-1, 1-0 and 0-1 moves. Every paragraph of both sides
 * lands in exactly one bead, beads are in reading order on both sides, and the beads' costs
 * sum to the minimum over all such alignments.
 */
export function alignParagraphs(
  de: readonly { text: string }[],
  en: readonly { text: string }[],
  options: LengthModelOptions = {},
): ParagraphBead[] {
  if (de.length === 0 && en.length === 0) return []
  const ratio = options.ratio ?? estimateRatio(de, en)
  return alignLengths(
    de.map((p) => p.text.length),
    en.map((p) => p.text.length),
    { ...options, ratio },
  )
}

/**
 * The paragraph DP over bare lengths. {@link alignParagraphs} is this over paragraph character
 * counts; the pipeline of step 12 also runs it over whole chapters (as shares of the book) to
 * pair the chapters of two editions whose counts differ.
 */
export function alignLengths(
  lenDe: readonly number[],
  lenEn: readonly number[],
  options: LengthModelOptions = {},
): ParagraphBead[] {
  const n = lenDe.length
  const m = lenEn.length
  if (n === 0 && m === 0) return []
  const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)
  const ratio = options.ratio ?? ratioOf(sum(lenDe), sum(lenEn))
  const variance = options.variance ?? DEFAULT_VARIANCE
  const deletionScale = options.deletionScale ?? DEFAULT_DELETION_SCALE
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
