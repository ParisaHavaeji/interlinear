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
 * **Chapter pairing.** Step 5b's name-overlap DP is not built yet. Until it is, two editions
 * with the same number of chapters are paired by position, which holds for all three test
 * pairs; otherwise a length DP over the chapters' shares of their books pairs them, dropping
 * what finds no partner (a long introduction on one side). Every chapter of both sides is
 * listed in the result, matched or not, for the chapter list of step 17.
 */

import type { Paragraph } from '../import/types.ts'
import { alignBlocks, type AlignedBead, type AlignOptions, type ParagraphBlock } from './beads.ts'
import type { Lexicon } from './features.ts'
import { induceLexicon, mergeLexicons, type InducedPair, type InduceOptions } from './lexicon.ts'
import type { SentenceEmbeddings } from './neural.ts'
import { splitParagraphs, type ParagraphSentence } from './sentences.ts'
import { alignLengths, alignParagraphs, chaptersOf, ratioOf, type Chapter, type SectionRange } from './structure.ts'

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
}

export interface ChapterMap {
  de: ChapterMeta[]
  en: ChapterMeta[]
  pairs: ChapterPair[]
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
  /** `performance.now()` when planning began, for {@link AlignStats.elapsedMs}. */
  startedAt: number
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
  const chaptersDe = chaptersOf(request.de)
  const chaptersEn = chaptersOf(request.en)
  const pairs = pairChapters(chaptersDe, chaptersEn)
  const work: PairWork[] = []
  for (const [k, pair] of pairs.entries()) {
    if (pair.de.length === 0 || pair.en.length === 0) continue
    const deParas = pair.de.flatMap((i) => chaptersDe[i].paragraphs)
    const enParas = pair.en.flatMap((j) => chaptersEn[j].paragraphs)
    const blocks = alignParagraphs(deParas, enParas).map((b) => ({
      de: b.de.map((x) => deParas[x].idx),
      en: b.en.map((y) => enParas[y].idx),
    }))
    work.push({ blocks, deParas: new Set(deParas.map((p) => p.idx)), enParas: new Set(enParas.map((p) => p.idx)) })
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
    chapters: { de: chaptersDe.map(meta), en: chaptersEn.map(meta), pairs },
    work,
    sentences: { de: sentDe, en: sentEn },
    perPair,
    options: { ...alignOptions, ratio },
    induce,
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

  // 4. Pass two over the dictionary plus what the book taught.
  const learned = induceLexicon(sentDe, sentEn, firstPass, induce)
  const beads = learned.size === 0 ? firstPass : pass('pass2', 0.55, 0.95, mergeLexicons(dictionary, learned))
  report('pass2', 0.95)

  const stats: AlignStats = {
    sentences: { de: sentDe.length, en: sentEn.length },
    beads: beads.length,
    oneToOne: beads.filter((b) => b.deSentenceIdx.length === 1 && b.enSentenceIdx.length === 1).length,
    uncertain: beads.filter((b) => b.confidence <= LOW_CONFIDENCE).length,
    learnedPairs: learned.pairs.length,
    changedBeads: beads === firstPass ? 0 : countChanged(beads, firstPass),
    pairedChapters: work.length,
    elapsedMs: Math.round(performance.now() - plan.startedAt),
    neural: embeddings !== null,
  }

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
