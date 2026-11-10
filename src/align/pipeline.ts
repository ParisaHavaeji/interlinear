/**
 * The whole-book alignment pipeline (plan §1.2, step 12): every layer of Phase 2 chained into
 * one call that turns two paragraph lists into sentences and beads, reporting progress as it
 * goes. It is pure and synchronous, so it runs the same in a Web Worker ({@link ./worker.ts}),
 * in the job queue's tests, and in Node against the fixtures.
 *
 * Stages, with the share of the progress bar each gets:
 *
 * 1. **Structure** (0–10%). {@link chaptersOf} on each side, then {@link pairChapters} across
 *    the two editions, then the paragraph DP of step 7 inside every chapter pair. The result
 *    is the list of paragraph blocks the sentence DP is bounded by.
 * 2. **Sentences** (10–15%). The splitter of step 8 over *all* paragraphs of both sides, front
 *    matter included, so the reader can show every sentence; sentences of unpaired text simply
 *    get no bead.
 * 3. **Pass one** (15–55%). The bead DP of step 10 over the dictionary (none until Phase 4),
 *    one chapter pair at a time so the bar moves. The length ratio is estimated once over the
 *    paired text, as {@link alignBlocks} would over a whole book.
 * 4. **Pass two** (55–95%). The induced lexicon of step 11 from the confident beads of pass
 *    one, then the DP again over dictionary plus lexicon. Skipped when nothing was learned.
 *
 * The pipeline is cut in two halves, {@link planBook} (stages 1 and 2) and {@link alignPlanned}
 * (stages 3 and 4), because the neural re-alignment of step 15 needs the sentences of the paired
 * chapters *before* the bead DP runs: the worker plans, embeds {@link pairedSentences} with the
 * language model, then passes the vectors into `alignPlanned`, which hands them to the DP as the
 * semantic feature. {@link alignBook} is the two halves back to back.
 *
 * Chunking by chapter pair changes nothing: each block is aligned on its own, so the beads
 * equal those of `alignTwoPass` over the same blocks and ratio (the pipeline test checks this).
 *
 * **Chapter pairing.** Step 5b's name-overlap DP is not built yet. Until it is, a length DP
 * over the chapters' lengths relative to their side's median chapter pairs them, dropping
 * what finds no partner (a long introduction on one side). Every chapter of both sides is
 * listed in the result, matched or not, and so are the sections left out of alignment, for
 * the chapter list of step 17. Each two-sided pair carries a confidence from the two sides'
 * relative lengths; the sheet marks pairs below {@link LOW_CHAPTER_CONFIDENCE}.
 *
 * **Edits and partial runs** (step 17). The reader's corrections ({@link ChapterEdits}: include
 * or exclude a section, pair two chapters by hand) come with the request and shape stage 1:
 * hand-set pairs are pinned and the DP pairs the chapters left free
 * ({@link pairChaptersEdited}). After such an edit only the chapter pairs that changed need
 * aligning again: the request names the pairs to `reuse` by {@link pairKey}, planning skips
 * their paragraph DP, the passes skip their beads, and the result holds beads for the other
 * pairs only; `jobs.ts` merges them with the stored beads of the reused pairs. Pass two of a
 * partial run uses the book's stored `lexicon` instead of learning one from a few chapters.
 */

import type { Paragraph } from '../import/types.ts'
import { alignBlocks, type AlignedBead, type AlignOptions, type ParagraphBlock } from './beads.ts'
import type { Lexicon } from './features.ts'
import { induceLexicon, InducedLexicon, mergeLexicons, type InducedPair, type InduceOptions } from './lexicon.ts'
import type { SentenceEmbeddings } from './neural.ts'
import { splitParagraphs, type ParagraphSentence } from './sentences.ts'
import {
  alignLengths,
  alignParagraphs,
  chapterKey,
  ratioOf,
  structureOf,
  type Chapter,
  type ChapterEdits,
  type PairEdit,
  type SectionRange,
} from './structure.ts'

// ---------------------------------------------------------------------------------------------
// Types

/** One language of a book as the store holds it: flat paragraphs plus EPUB section ranges. */
export interface AlignSide {
  paragraphs: readonly Paragraph[]
  sections: readonly SectionRange[]
}

export interface AlignBookOptions extends AlignOptions {
  induce?: InduceOptions
}

/** What the worker is sent: both sides and the tuning knobs. Structured-cloneable. */
export interface AlignRequest {
  de: AlignSide
  en: AlignSide
  options?: AlignBookOptions
  /**
   * Re-align with high accuracy (step 15): embed the sentences with the language model and
   * score beads by meaning too. Only the worker can honour this; see `worker.ts`.
   */
  neural?: boolean
  /** The reader's corrections to the chapter structure (step 17), applied in stage 1. */
  edits?: ChapterEdits
  /**
   * Partial run (step 17): the {@link pairKey}s of chapter pairs whose beads the caller keeps
   * from an earlier alignment. They are planned (so the chapter map is complete) but neither
   * paragraph- nor sentence-aligned, and the result's beads cover only the other pairs.
   */
  reuse?: string[]
  /**
   * The lexicon pass two should use instead of inducing one: a partial run aligns too little
   * text to learn from, so it borrows what the whole book taught earlier.
   */
  lexicon?: InducedPair[]
}

export type AlignStage = 'structure' | 'sentences' | 'model' | 'embed' | 'pass1' | 'pass2' | 'saving'

export interface AlignProgress {
  stage: AlignStage
  /** Overall completion, 0–1, never decreasing within one run. */
  fraction: number
}

/** A chapter without its paragraphs: what the book record keeps about the mapping. */
export interface ChapterMeta {
  idx: number
  heading: string | null
  sectionIdx: number | null
  paraStart: number
  paraCount: number
  words: number
}

/** Chapter positions (`ChapterMeta.idx`) aligned across the editions; one side may be empty. */
export interface ChapterPair {
  de: number[]
  en: number[]
  /**
   * How well the two sides' lengths agree, 0–1 (see {@link pairConfidence}); absent on
   * one-sided pairs. Below {@link LOW_CHAPTER_CONFIDENCE} the chapter sheet marks the pair.
   */
  confidence?: number
  /** True for a pair the reader set by hand. */
  manual?: boolean
}

export interface ChapterMap {
  de: ChapterMeta[]
  en: ChapterMeta[]
  pairs: ChapterPair[]
  /**
   * The sections of each side that take no part in alignment (front and back matter, what
   * the reader excluded), in reading order. Missing on books aligned before step 17.
   */
  excluded?: { de: ChapterMeta[]; en: ChapterMeta[] }
}

/**
 * Beads at or below this confidence count as uncertain in {@link AlignStats} and get the
 * reader's dotted underline. Picked against the gold files (step 13): at 0.8 about half of the
 * wrong beads are flagged and under 3% of the right ones, the best F1 of the thresholds tried.
 */
export const LOW_CONFIDENCE = 0.8

export interface AlignStats {
  sentences: { de: number; en: number }
  beads: number
  /** Beads with exactly one sentence on each side. */
  oneToOne: number
  /** Beads with confidence at or below {@link LOW_CONFIDENCE}. */
  uncertain: number
  /** Translation pairs the book taught in pass one. */
  learnedPairs: number
  /** Beads that pass two placed differently from pass one. */
  changedBeads: number
  /** Chapter pairs with text on both sides. */
  pairedChapters: number
  elapsedMs: number
  /** True when the beads were also scored by the language model (step 15). */
  neural: boolean
}

export interface AlignResult {
  sentences: { de: ParagraphSentence[]; en: ParagraphSentence[] }
  beads: AlignedBead[]
  chapters: ChapterMap
  lexicon: InducedPair[]
  stats: AlignStats
}

export type ProgressCallback = (progress: AlignProgress) => void

// ---------------------------------------------------------------------------------------------
// Chapter pairing

/** A typical chapter of one side is this many units; the two sides are then directly comparable. */
const MEDIAN_CHAPTER_UNITS = 1000
/** Units per nat when a chapter finds no partner: dropping a typical chapter costs 20 nats. */
const CHAPTER_DELETION_SCALE = 50

/**
 * Each chapter's length in units of the side's median chapter. The median, not the total, so
 * that a long introduction on one side does not shrink every chapter of that side.
 */
function relativeLengths(chapters: readonly Chapter[]): number[] {
  const chars = chapters.map((c) => c.paragraphs.reduce((n, p) => n + p.text.length, 0))
  const sorted = [...chars].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  return chars.map((c) => (median === 0 ? 0 : (MEDIAN_CHAPTER_UNITS * c) / median))
}

/**
 * Pair the chapters of two editions: the length DP over the chapters' lengths relative to each
 * side's median chapter (ratio 1), so a preface or introduction on one side is dropped rather
 * than shifting every chapter after it, and a chapter one edition splits in two is merged.
 * Equal counts are no shortcut: Werther's two editions both have 89 letters, offset by one.
 * Pairs come back in reading order, unmatched chapters as one-sided pairs.
 */
export function pairChapters(de: readonly Chapter[], en: readonly Chapter[]): ChapterPair[] {
  return alignLengths(relativeLengths(de), relativeLengths(en), { ratio: 1, deletionScale: CHAPTER_DELETION_SCALE }).map(
    (b) => ({ de: b.de, en: b.en }),
  )
}

/**
 * Chapter pairs at or below this confidence get the chapter sheet's marker (plan §1.1b): the
 * two sides differ in relative length by more than about a third, which is more than a
 * translator's verbosity varies from chapter to chapter.
 */
export const LOW_CHAPTER_CONFIDENCE = 0.7

/**
 * Confidence of a two-sided chapter pair: the shorter side's relative length over the longer
 * side's, so 1 when both sides hold the same share of their books and 0.5 when one holds
 * twice the other's. Relative lengths are in units of each side's median chapter, which
 * absorbs the translation's overall ratio.
 */
export function pairConfidence(pair: ChapterPair, relDe: readonly number[], relEn: readonly number[]): number | undefined {
  if (pair.de.length === 0 || pair.en.length === 0) return undefined
  const d = pair.de.reduce((n, i) => n + relDe[i], 0)
  const e = pair.en.reduce((n, j) => n + relEn[j], 0)
  const hi = Math.max(d, e)
  if (hi === 0) return 1
  return Math.min(d, e) / hi
}

/**
 * {@link pairChapters} under the reader's hand-set pairs (step 17): each is pinned (keys that
 * match no chapter are dropped, a pair left one-sided or touching an already pinned chapter
 * is ignored), the chapters left free are paired by the DP among themselves, and the two
 * lists are merged into reading order. Every pair gets its {@link pairConfidence}.
 */
export function pairChaptersEdited(de: readonly Chapter[], en: readonly Chapter[], manual: readonly PairEdit[] = []): ChapterPair[] {
  const relDe = relativeLengths(de)
  const relEn = relativeLengths(en)
  const withConfidence = (p: ChapterPair): ChapterPair => {
    const confidence = pairConfidence(p, relDe, relEn)
    return confidence === undefined ? p : { ...p, confidence }
  }
  if (manual.length === 0) return pairChapters(de, en).map(withConfidence)

  const keyToIdx = (chapters: readonly Chapter[]) => new Map(chapters.map((c) => [chapterKey(c), c.idx]))
  const deByKey = keyToIdx(de)
  const enByKey = keyToIdx(en)
  const pinnedDe = new Set<number>()
  const pinnedEn = new Set<number>()
  const pinned: ChapterPair[] = []
  for (const edit of manual) {
    const d = edit.de.map((k) => deByKey.get(k)).filter((i): i is number => i !== undefined && !pinnedDe.has(i))
    const e = edit.en.map((k) => enByKey.get(k)).filter((j): j is number => j !== undefined && !pinnedEn.has(j))
    if (d.length === 0 || e.length === 0 || d.length !== edit.de.length || e.length !== edit.en.length) continue
    d.sort((a, b) => a - b)
    e.sort((a, b) => a - b)
    for (const i of d) pinnedDe.add(i)
    for (const j of e) pinnedEn.add(j)
    pinned.push(withConfidence({ de: d, en: e, manual: true }))
  }
  pinned.sort((a, b) => a.de[0] - b.de[0])

  const freeDe = de.filter((c) => !pinnedDe.has(c.idx))
  const freeEn = en.filter((c) => !pinnedEn.has(c.idx))
  const auto = pairChapters(freeDe, freeEn).map((p) => withConfidence({ de: p.de.map((i) => freeDe[i].idx), en: p.en.map((j) => freeEn[j].idx) }))

  // Merge the two ordered lists: a free pair goes before a pinned one when its first chapter
  // does, comparing on whichever side the free pair has.
  const out: ChapterPair[] = []
  let a = 0
  let p = 0
  while (a < auto.length || p < pinned.length) {
    if (p >= pinned.length) out.push(auto[a++])
    else if (a >= auto.length) out.push(pinned[p++])
    else {
      const free = auto[a]
      const pin = pinned[p]
      const before = free.de.length > 0 ? free.de[0] < pin.de[0] : free.en[0] < pin.en[0]
      out.push(before ? auto[a++] : pinned[p++])
    }
  }
  return out
}

/**
 * The key a chapter pair is recognised by across runs (step 17's partial re-alignment): the
 * paragraph ranges of its chapters on both sides, which stay the same when other chapters
 * are included, excluded or re-paired and the positions shift.
 */
export function pairKey(pair: ChapterPair, chapters: Pick<ChapterMap, 'de' | 'en'>): string {
  const span = (c: ChapterMeta) => `${c.paraStart}+${c.paraCount}`
  return `${pair.de.map((i) => span(chapters.de[i])).join(',')}|${pair.en.map((j) => span(chapters.en[j])).join(',')}`
}

function meta(c: Chapter): ChapterMeta {
  return {
    idx: c.idx,
    heading: c.heading,
    sectionIdx: c.sectionIdx,
    paraStart: c.paraStart,
    paraCount: c.paragraphs.length,
    words: c.words,
  }
}

// ---------------------------------------------------------------------------------------------
// The pipeline

/** The paragraph blocks of one chapter pair and the `Paragraph.idx` sets they cover. */
export interface PairWork {
  /** Position of the pair in `ChapterMap.pairs`. */
  pairIdx: number
  blocks: ParagraphBlock[]
  deParas: Set<number>
  enParas: Set<number>
}

/** What {@link planBook} hands {@link alignPlanned}: everything before the bead DP. */
export interface BookPlan {
  chapters: ChapterMap
  /** The paragraph blocks of every chapter pair with text on both sides, in reading order. */
  work: PairWork[]
  /** Every sentence of both sides; position equals `ParagraphSentence.idx`. */
  sentences: { de: ParagraphSentence[]; en: ParagraphSentence[] }
  /** The sentences of each entry of `work`. */
  perPair: { de: ParagraphSentence[]; en: ParagraphSentence[] }[]
  /** The bead DP options with the book-wide length ratio filled in. */
  options: AlignOptions
  induce: InduceOptions | undefined
  /** A lexicon given with the request, used by pass two in place of an induced one. */
  lexicon: InducedPair[] | undefined
  /** `performance.now()` when planning began, for {@link AlignStats.elapsedMs}. */
  startedAt: number
}

/**
 * Stage 1 without the paragraph DP: the chapters of both sides under the reader's edits, the
 * sections left out, and the chapter pairs. Cheap enough for the main thread, which is where
 * the job queue works out what a partial run may reuse.
 */
export function planChapters(request: Pick<AlignRequest, 'de' | 'en' | 'edits'>): ChapterMap {
  const de = structureOf(request.de, request.edits?.de)
  const en = structureOf(request.en, request.edits?.en)
  return {
    de: de.chapters.map(meta),
    en: en.chapters.map(meta),
    pairs: pairChaptersEdited(de.chapters, en.chapters, request.edits?.pairs),
    excluded: { de: de.excluded.map(meta), en: en.excluded.map(meta) },
  }
}

/** The stats of a finished alignment over its beads. */
export function statsFor(
  sentences: { de: readonly unknown[]; en: readonly unknown[] },
  beads: readonly Pick<AlignedBead, 'deSentenceIdx' | 'enSentenceIdx' | 'confidence'>[],
  rest: Pick<AlignStats, 'learnedPairs' | 'changedBeads' | 'pairedChapters' | 'elapsedMs' | 'neural'>,
): AlignStats {
  return {
    sentences: { de: sentences.de.length, en: sentences.en.length },
    beads: beads.length,
    oneToOne: beads.filter((b) => b.deSentenceIdx.length === 1 && b.enSentenceIdx.length === 1).length,
    uncertain: beads.filter((b) => b.confidence <= LOW_CONFIDENCE).length,
    ...rest,
  }
}

/** Beads of `a` that have no identical bead in `b`. */
function countChanged(a: readonly AlignedBead[], b: readonly AlignedBead[]): number {
  const keys = new Set(b.map((x) => `${x.deSentenceIdx.join('+')}:${x.enSentenceIdx.join('+')}`))
  let n = 0
  for (const x of a) if (!keys.has(`${x.deSentenceIdx.join('+')}:${x.enSentenceIdx.join('+')}`)) n++
  return n
}

/**
 * Stages 1 and 2: chapters, chapter pairs, paragraph blocks, sentences, and the length ratio.
 * Reports progress from 0 to 0.15. Throws nothing of its own; an empty side plans no work.
 */
export function planBook(request: AlignRequest, onProgress?: ProgressCallback): BookPlan {
  const startedAt = performance.now()
  const report = (stage: AlignStage, fraction: number) => onProgress?.({ stage, fraction })
  const { induce, ...alignOptions } = request.options ?? {}

  // 1. Structure: chapters, chapter pairs, paragraph blocks inside each pair.
  report('structure', 0)
  const chapters = planChapters(request)
  const { pairs } = chapters
  const reuse = new Set(request.reuse ?? [])
  const paragraphsOf = (side: AlignSide, c: ChapterMeta) => side.paragraphs.slice(c.paraStart, c.paraStart + c.paraCount)
  const work: PairWork[] = []
  for (const [k, pair] of pairs.entries()) {
    if (pair.de.length === 0 || pair.en.length === 0) continue
    if (reuse.has(pairKey(pair, chapters))) continue
    const deParas = pair.de.flatMap((i) => paragraphsOf(request.de, chapters.de[i]))
    const enParas = pair.en.flatMap((j) => paragraphsOf(request.en, chapters.en[j]))
    const blocks = alignParagraphs(deParas, enParas).map((b) => ({
      de: b.de.map((x) => deParas[x].idx),
      en: b.en.map((y) => enParas[y].idx),
    }))
    work.push({ pairIdx: k, blocks, deParas: new Set(deParas.map((p) => p.idx)), enParas: new Set(enParas.map((p) => p.idx)) })
    report('structure', (0.1 * (k + 1)) / pairs.length)
  }

  // 2. Sentences of everything, so that position equals `ParagraphSentence.idx`.
  report('sentences', 0.1)
  const sentDe = splitParagraphs(request.de.paragraphs, 'de')
  const sentEn = splitParagraphs(request.en.paragraphs, 'en')
  report('sentences', 0.15)

  // The sentences of each pair, and the book-wide length ratio over the paired text only.
  const perPair = work.map((w) => ({
    de: sentDe.filter((s) => w.deParas.has(s.paraIdx)),
    en: sentEn.filter((s) => w.enParas.has(s.paraIdx)),
  }))
  const chars = (ss: readonly ParagraphSentence[]) => ss.reduce((n, s) => n + s.text.length, 0)
  const ratio =
    alignOptions.ratio ??
    ratioOf(
      perPair.reduce((n, p) => n + chars(p.de), 0),
      perPair.reduce((n, p) => n + chars(p.en), 0),
    )

  return {
    chapters,
    work,
    sentences: { de: sentDe, en: sentEn },
    perPair,
    options: { ...alignOptions, ratio },
    induce,
    lexicon: request.lexicon,
    startedAt,
  }
}

/**
 * The sentences that can end up in a bead: those of the paired chapters, in reading order on
 * each side. What the language model of step 15 embeds; front matter and unmatched chapters
 * are left out since no bead will ask about them.
 */
export function pairedSentences(plan: BookPlan): { de: ParagraphSentence[]; en: ParagraphSentence[] } {
  return { de: plan.perPair.flatMap((p) => p.de), en: plan.perPair.flatMap((p) => p.en) }
}

/**
 * Stages 3 and 4 over a plan: pass one on the dictionary (`null` until Phase 4), pass two on
 * the dictionary plus the lexicon the book taught. `embeddings` are the sentence vectors of
 * step 15, keyed by `ParagraphSentence.idx`; with them the DP also scores beads by meaning and
 * the stats say so. Reports progress from 0.15 to 0.95.
 */
export function alignPlanned(
  plan: BookPlan,
  dictionary: Lexicon | null = null,
  onProgress?: ProgressCallback,
  embeddings: SentenceEmbeddings | null = null,
): AlignResult {
  const report = (stage: AlignStage, fraction: number) => onProgress?.({ stage, fraction })
  const { work, perPair, options, induce } = plan
  const sentDe = plan.sentences.de
  const sentEn = plan.sentences.en

  const pass = (stage: 'pass1' | 'pass2', from: number, to: number, lexicon: Lexicon | null): AlignedBead[] => {
    const out: AlignedBead[] = []
    report(stage, from)
    for (const [k, w] of work.entries()) {
      out.push(...alignBlocks(perPair[k].de, perPair[k].en, w.blocks, lexicon, options, embeddings))
      report(stage, from + ((to - from) * (k + 1)) / work.length)
    }
    report(stage, to)
    return out
  }

  // 3. Pass one over the dictionary alone.
  const firstPass = pass('pass1', 0.15, 0.55, dictionary)

  // 4. Pass two over the dictionary plus what the book taught (or was told).
  const learned = plan.lexicon === undefined ? induceLexicon(sentDe, sentEn, firstPass, induce) : new InducedLexicon(plan.lexicon)
  const beads = learned.size === 0 ? firstPass : pass('pass2', 0.55, 0.95, mergeLexicons(dictionary, learned))
  report('pass2', 0.95)

  const stats = statsFor(plan.sentences, beads, {
    learnedPairs: learned.pairs.length,
    changedBeads: beads === firstPass ? 0 : countChanged(beads, firstPass),
    pairedChapters: work.length,
    elapsedMs: Math.round(performance.now() - plan.startedAt),
    neural: embeddings !== null,
  })

  return {
    sentences: { de: sentDe, en: sentEn },
    beads,
    chapters: plan.chapters,
    lexicon: [...learned.pairs],
    stats,
  }
}

/**
 * Align a book. `dictionary` is the shipped dictionary once Phase 4 exists, `null` until then;
 * `embeddings` are the language model's sentence vectors when a caller has them (the worker
 * does for a neural re-align). `onProgress` is called after every chapter pair of every stage,
 * with a fraction that only grows. Throws nothing of its own; an empty side yields no beads.
 */
export function alignBook(
  request: AlignRequest,
  dictionary: Lexicon | null = null,
  onProgress?: ProgressCallback,
  embeddings: SentenceEmbeddings | null = null,
): AlignResult {
  return alignPlanned(planBook(request, onProgress), dictionary, onProgress, embeddings)
}
