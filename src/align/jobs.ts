/**
 * Alignment jobs on the main thread (plan §1.2, step 12): the queue that runs the pipeline for
 * a book, keeps its live progress for the cover, and writes the result into Dexie.
 *
 * - {@link startAlignment} queues a book. Jobs run one at a time, oldest first, so a phone
 *   resuming three half-imported books does not spin up three workers. Starting a book that is
 *   already queued or running returns the same promise.
 * - Progress lives in memory, not in the store: a tick every chapter pair would otherwise
 *   rewrite the book row and re-render the whole shelf. The book row only records the status
 *   (`pending` → `aligning` → `ready` | `failed`), the chapter map, the learned lexicon and
 *   the stats, so a reload can tell finished books from interrupted ones and
 *   {@link resumeAlignments} can queue the latter again.
 * - The pipeline runs through a {@link Runner}. The app installs the module worker's runner
 *   from `worker-runner.ts` at startup; tests pass one that calls {@link alignBook} directly.
 * - Saving checks the book still exists, so a book deleted while aligning leaves nothing
 *   behind; {@link cancelAlignment} also terminates its worker.
 * - Pre-aligned input (step 14, `prealigned.ts`) takes the same path minus the runner: the
 *   result is built from the lines directly and saved, so the shelf shows it as any other
 *   book and an interrupted import resumes the same way.
 * - A **re-alignment** of a book that is already `ready` (step 15's "Re-align with high
 *   accuracy", `neural: true`) keeps the book readable: its status stays `ready` and its beads
 *   stay in place until the new ones are saved in one transaction. If the run fails (offline
 *   before the model was ever downloaded, say) the old alignment survives and the error is
 *   recorded on the book for the shelf to show until {@link clearAlignmentError} is called.
 * - A **chapter edit** from the chapter sheet (step 17, {@link applyChapterEdits}) stores the
 *   edits on the book and runs a job over the changed chapters only: the queue plans the new
 *   chapter map on the main thread, tells the runner which pairs it may `reuse` (those with
 *   the same {@link pairKey} as before), and {@link mergeAlignment} splices the new beads in
 *   among the kept ones. A book aligned with the language model is repaired with it too, so
 *   its beads stay of a kind. The edits also travel with every later full run.
 */

import type { Lang, Paragraph } from '../import/types.ts'
import { getParagraphs } from '../store/books.ts'
import { db as sharedDb, type AlignmentState, type BeadRow, type Book, type InterlinearDB, type SentenceRow } from '../store/db.ts'
import {
  alignBook,
  pairKey,
  planChapters,
  statsFor,
  type AlignProgress,
  type AlignRequest,
  type AlignResult,
  type AlignStage,
  type ChapterMap,
} from './pipeline.ts'
import { isPrealignedBook, prealignedResult } from './prealigned.ts'
import type { ChapterEdits } from './structure.ts'

// ---------------------------------------------------------------------------------------------
// Runners

/** Runs the pipeline for one request, reporting progress; must reject once `signal` aborts. */
export type Runner = (request: AlignRequest, onProgress: (p: AlignProgress) => void, signal: AbortSignal) => Promise<AlignResult>

export class AlignmentCancelled extends Error {
  override name = 'AlignmentCancelled'
  constructor() {
    super('Alignment cancelled')
  }
}

/**
 * Runs the pipeline on this thread. For tests and as a fallback where workers are missing. It
 * has no language model, so a neural request is refused rather than quietly aligned classically.
 */
export const inlineRunner: Runner = (request, onProgress, signal) => {
  if (signal.aborted) return Promise.reject(new AlignmentCancelled())
  if (request.neural) return Promise.reject(new Error('The language model runs only in the alignment worker'))
  try {
    return Promise.resolve(alignBook(request, null, onProgress))
  } catch (err) {
    return Promise.reject(err)
  }
}

let defaultRunner: Runner = inlineRunner

/** Install the runner {@link startAlignment} uses when none is given; `main.tsx` sets the worker one. */
export function setDefaultRunner(runner: Runner): void {
  defaultRunner = runner
}

// ---------------------------------------------------------------------------------------------
// Live job state

export interface AlignmentJob {
  bookId: string
  stage: AlignStage | 'queued'
  fraction: number
  /** True for a re-alignment with the language model (step 15). */
  neural: boolean
  /** True for a run over the chapters a chapter edit changed (step 17). */
  partial: boolean
}

type Listener = (jobs: ReadonlyMap<string, AlignmentJob>) => void

interface Active {
  job: AlignmentJob
  controller: AbortController
  promise: Promise<void>
}

const active = new Map<string, Active>()
const listeners = new Set<Listener>()
let snapshot: ReadonlyMap<string, AlignmentJob> = new Map()
let queue: Promise<void> = Promise.resolve()

function publish(): void {
  snapshot = new Map(Array.from(active, ([id, a]) => [id, { ...a.job }]))
  for (const fn of listeners) fn(snapshot)
}

/** The jobs queued or running right now, by book id. A new map on every change. */
export function getAlignmentJobs(): ReadonlyMap<string, AlignmentJob> {
  return snapshot
}

/** Be told whenever a job starts, moves or ends. Returns the unsubscribe function. */
export function subscribeAlignmentJobs(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export interface AlignmentDeps {
  db?: InterlinearDB
  runner?: Runner
  /** Re-align with the language model (step 15). Needs a runner that can, i.e. the worker. */
  neural?: boolean
  /**
   * `changed` (step 17): on a ready book, align only the chapter pairs its edits changed and
   * keep the rest; with the model if the book was aligned with it. `book` (the default)
   * aligns everything. A book that is not ready is aligned in full either way.
   */
  scope?: 'book' | 'changed'
}

// ---------------------------------------------------------------------------------------------
// Running and saving

function toParagraph(row: { idx: number; text: string; cls?: string }): Paragraph {
  return row.cls === undefined ? { idx: row.idx, text: row.text } : { idx: row.idx, text: row.text, cls: row.cls }
}

/** Build the worker's request from what the store holds for a book, its chapter edits included. */
export async function requestFor(book: Book, db: InterlinearDB): Promise<AlignRequest> {
  const side = async (lang: Lang) => ({
    paragraphs: (await getParagraphs(book.id, lang, db)).map(toParagraph),
    sections: book.sources[lang].sections,
  })
  const request: AlignRequest = { de: await side('de'), en: await side('en') }
  if (book.chapterEdits !== undefined) request.edits = book.chapterEdits
  return request
}

/**
 * The chapter pairs of `next` whose beads an alignment of `previous` can stand in for: those
 * with the same {@link pairKey}, i.e. the same paragraphs on both sides. One-sided pairs have
 * no beads and are never listed.
 */
export function reusablePairs(previous: ChapterMap, next: ChapterMap): string[] {
  const before = new Set(previous.pairs.map((p) => pairKey(p, previous)))
  return next.pairs.filter((p) => p.de.length > 0 && p.en.length > 0).map((p) => pairKey(p, next)).filter((k) => before.has(k))
}

function sentenceRows(bookId: string, lang: Lang, sentences: AlignResult['sentences'][Lang]): SentenceRow[] {
  return sentences.map((s) => ({
    bookId,
    lang,
    idx: s.idx,
    paraIdx: s.paraIdx,
    text: s.text,
    charStart: s.charStart,
    charEnd: s.charEnd,
  }))
}

function beadRows(bookId: string, beads: AlignResult['beads']): BeadRow[] {
  return beads.map((b, beadIdx) => ({
    bookId,
    beadIdx,
    deSentenceIdx: b.deSentenceIdx,
    enSentenceIdx: b.enSentenceIdx,
    confidence: b.confidence,
    manual: false,
  }))
}

/**
 * Replace a book's sentences and beads with a pipeline result and mark it ready, in one
 * transaction. Returns false, writing nothing, when the book is gone.
 */
export async function saveAlignment(bookId: string, result: AlignResult, db: InterlinearDB = sharedDb()): Promise<boolean> {
  return db.transaction('rw', [db.books, db.sentences, db.beads], async () => {
    if ((await db.books.get(bookId)) === undefined) return false
    await db.sentences.where('bookId').equals(bookId).delete()
    await db.beads.where('bookId').equals(bookId).delete()
    await db.sentences.bulkAdd(sentenceRows(bookId, 'de', result.sentences.de))
    await db.sentences.bulkAdd(sentenceRows(bookId, 'en', result.sentences.en))
    await db.beads.bulkAdd(beadRows(bookId, result.beads))
    const alignment: AlignmentState = {
      status: 'ready',
      updated: Date.now(),
      chapters: result.chapters,
      lexicon: result.lexicon,
      stats: result.stats,
    }
    await db.books.update(bookId, { alignment })
    return true
  })
}

/** Group beads by the chapter pair they sit in, through their sentences' paragraphs. */
function beadsByPair<B extends { deSentenceIdx: number[]; enSentenceIdx: number[] }>(
  beads: readonly B[],
  chapters: ChapterMap,
  sentences: { de: ReadonlyMap<number, number>; en: ReadonlyMap<number, number> },
): Map<string, B[]> {
  const paraToKey = { de: new Map<number, string>(), en: new Map<number, string>() }
  for (const pair of chapters.pairs) {
    const key = pairKey(pair, chapters)
    for (const i of pair.de) {
      const c = chapters.de[i]
      for (let p = c.paraStart; p < c.paraStart + c.paraCount; p++) paraToKey.de.set(p, key)
    }
    for (const j of pair.en) {
      const c = chapters.en[j]
      for (let p = c.paraStart; p < c.paraStart + c.paraCount; p++) paraToKey.en.set(p, key)
    }
  }
  const groups = new Map<string, B[]>()
  for (const b of beads) {
    const key =
      b.deSentenceIdx.length > 0
        ? paraToKey.de.get(sentences.de.get(b.deSentenceIdx[0]) ?? -1)
        : paraToKey.en.get(sentences.en.get(b.enSentenceIdx[0]) ?? -1)
    if (key === undefined) continue
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [b])
    else list.push(b)
  }
  return groups
}

/**
 * Save a partial run (step 17): the result's beads cover the chapter pairs that changed, the
 * stored beads of the pairs in `reuse` are kept (`manual` flags included), and the merged list
 * is written in reading order with the new chapter map and fresh stats. The book's lexicon
 * stays what the last full run taught. The sentences are rewritten too; they are the same
 * rows, since the splitter is a pure function of the paragraphs, and when they are not (the
 * splitter changed between app versions) the kept beads would point at the wrong sentences,
 * so the merge refuses and leaves the book as it was. Returns false when the book is gone.
 */
export async function mergeAlignment(bookId: string, result: AlignResult, reuse: readonly string[], db: InterlinearDB = sharedDb()): Promise<boolean> {
  return db.transaction('rw', [db.books, db.sentences, db.beads], async () => {
    const book = await db.books.get(bookId)
    if (book === undefined) return false
    const previous = book.alignment?.chapters
    if (book.alignment?.status !== 'ready' || previous === undefined) throw new Error('The book must be aligned before its chapters can be edited')
    const [oldDe, oldEn, oldBeads] = await Promise.all([
      db.sentences.where('[bookId+lang]').equals([bookId, 'de']).toArray(),
      db.sentences.where('[bookId+lang]').equals([bookId, 'en']).toArray(),
      db.beads.where('bookId').equals(bookId).sortBy('beadIdx'),
    ])
    const same = (rows: SentenceRow[], fresh: readonly { idx: number; paraIdx: number; charStart: number; charEnd: number }[]) =>
      rows.length === fresh.length &&
      rows.every((r) => {
        const s = fresh[r.idx]
        return s !== undefined && s.paraIdx === r.paraIdx && s.charStart === r.charStart && s.charEnd === r.charEnd
      })
    if (!same(oldDe, result.sentences.de) || !same(oldEn, result.sentences.en)) {
      throw new Error('The sentences of this book changed; re-align the whole book first')
    }
    const paraOf = (rows: readonly { idx: number; paraIdx: number }[]) => new Map(rows.map((s) => [s.idx, s.paraIdx]))
    const sentencePara = { de: paraOf(result.sentences.de), en: paraOf(result.sentences.en) }
    const kept = beadsByPair(oldBeads, previous, sentencePara)
    const fresh = beadsByPair(result.beads, result.chapters, sentencePara)
    const reusable = new Set(reuse)

    const merged: BeadRow[] = []
    for (const pair of result.chapters.pairs) {
      const key = pairKey(pair, result.chapters)
      if (reusable.has(key)) {
        for (const b of kept.get(key) ?? []) merged.push({ ...b, beadIdx: merged.length })
      } else {
        for (const b of fresh.get(key) ?? []) {
          merged.push({ bookId, beadIdx: merged.length, deSentenceIdx: b.deSentenceIdx, enSentenceIdx: b.enSentenceIdx, confidence: b.confidence, manual: false })
        }
      }
    }

    await db.sentences.where('bookId').equals(bookId).delete()
    await db.beads.where('bookId').equals(bookId).delete()
    await db.sentences.bulkAdd(sentenceRows(bookId, 'de', result.sentences.de))
    await db.sentences.bulkAdd(sentenceRows(bookId, 'en', result.sentences.en))
    await db.beads.bulkAdd(merged)
    const old = book.alignment.stats
    const alignment: AlignmentState = {
      status: 'ready',
      updated: Date.now(),
      chapters: result.chapters,
      lexicon: book.alignment.lexicon ?? [],
      stats: statsFor(result.sentences, merged, {
        learnedPairs: old?.learnedPairs ?? 0,
        changedBeads: old?.changedBeads ?? 0,
        pairedChapters: result.chapters.pairs.filter((p) => p.de.length > 0 && p.en.length > 0).length,
        elapsedMs: result.stats.elapsedMs,
        neural: old?.neural === true && result.stats.neural,
      }),
    }
    await db.books.update(bookId, { alignment })
    return true
  })
}

async function setStatus(db: InterlinearDB, bookId: string, status: 'aligning' | 'failed', error?: string): Promise<void> {
  const book = await db.books.get(bookId)
  if (book === undefined) return
  const alignment: AlignmentState = { ...book.alignment, status, updated: Date.now() }
  delete alignment.error
  if (error !== undefined) alignment.error = error
  await db.books.update(bookId, { alignment })
}

/** Record (or, with `undefined`, clear) an error on a book without touching its status. */
async function setError(db: InterlinearDB, bookId: string, error: string | undefined): Promise<void> {
  const book = await db.books.get(bookId)
  if (book?.alignment === undefined) return
  const alignment: AlignmentState = { ...book.alignment }
  delete alignment.error
  if (error !== undefined) alignment.error = error
  await db.books.update(bookId, { alignment })
}

/** Dismiss the error a failed re-alignment left on a ready book. */
export function clearAlignmentError(bookId: string, db: InterlinearDB = sharedDb()): Promise<void> {
  return setError(db, bookId, undefined)
}

async function run(bookId: string, entry: Active, db: InterlinearDB, runner: Runner): Promise<void> {
  const { signal } = entry.controller
  const book = await db.books.get(bookId)
  if (book === undefined || signal.aborted) return
  // A book that is already aligned stays readable while it is re-aligned, and keeps its beads
  // if the run fails; a first alignment is marked so that a reload can resume it.
  const keepReady = book.alignment?.status === 'ready'
  if (!keepReady) await setStatus(db, bookId, 'aligning')
  try {
    const request = await requestFor(book, db)
    // A partial run needs an alignment to keep most of; otherwise it is a full run.
    const previous = book.alignment?.status === 'ready' ? book.alignment.chapters : undefined
    const partial = entry.job.partial && previous !== undefined && !isPrealignedBook(book)
    let reuse: string[] = []
    if (partial) {
      reuse = reusablePairs(previous, planChapters(request))
      request.reuse = reuse
      request.lexicon = book.alignment?.lexicon ?? []
      if (book.alignment?.stats?.neural === true) entry.job.neural = true
    } else entry.job.partial = false
    if (entry.job.neural) request.neural = true
    entry.job.stage = 'structure'
    publish()
    const result = isPrealignedBook(book)
      ? prealignedResult(request.de.paragraphs, request.en.paragraphs)
      : await runner(
          request,
          (p) => {
            entry.job.stage = p.stage
            entry.job.fraction = p.fraction
            publish()
          },
          signal,
        )
    if (signal.aborted) return
    entry.job.stage = 'saving'
    entry.job.fraction = 0.95
    publish()
    if (partial) await mergeAlignment(bookId, result, reuse, db)
    else await saveAlignment(bookId, result, db)
    entry.job.fraction = 1
    publish()
  } catch (err) {
    if (err instanceof AlignmentCancelled || signal.aborted) return
    console.error(`Alignment of ${bookId} failed`, err)
    const message = err instanceof Error ? err.message : String(err)
    try {
      if (keepReady) await setError(db, bookId, message)
      else await setStatus(db, bookId, 'failed', message)
    } catch (inner) {
      console.error(`Could not record the failure of ${bookId}`, inner)
    }
  }
}

/**
 * Queue a book for alignment and resolve when it has been saved, failed, or been cancelled.
 * Never rejects; failures land in the book's `alignment.error`. With `deps.neural` the book is
 * re-aligned with the language model (step 15).
 */
export function startAlignment(bookId: string, deps: AlignmentDeps = {}): Promise<void> {
  const have = active.get(bookId)
  if (have !== undefined) return have.promise
  const db = deps.db ?? sharedDb()
  const runner = deps.runner ?? defaultRunner
  const controller = new AbortController()
  const entry = {
    job: { bookId, stage: 'queued', fraction: 0, neural: deps.neural === true, partial: deps.scope === 'changed' },
    controller,
  } as Active
  entry.promise = queue
    .then(() => run(bookId, entry, db, runner))
    .finally(() => {
      active.delete(bookId)
      publish()
    })
  // `run` swallows its own errors, but the chain must survive one anyway, or every later job
  // would be skipped.
  queue = entry.promise.catch(() => undefined)
  active.set(bookId, entry)
  publish()
  return entry.promise
}

/** Stop a queued or running job. The book's status is left as it was; nothing is saved. */
export function cancelAlignment(bookId: string): void {
  active.get(bookId)?.controller.abort()
}

/**
 * Store the reader's chapter edits on a book and re-align what they changed (step 17). A job
 * already running for the book is stopped first, so the newest edits are the ones applied;
 * the stored alignment is untouched until the new beads are saved. Resolves as
 * {@link startAlignment} does. A pre-aligned book has no chapter edits to apply.
 */
export async function applyChapterEdits(bookId: string, edits: ChapterEdits, deps: AlignmentDeps = {}): Promise<void> {
  const db = deps.db ?? sharedDb()
  const book = await db.books.get(bookId)
  if (book === undefined || isPrealignedBook(book)) return
  await db.books.update(bookId, { chapterEdits: edits })
  const running = active.get(bookId)
  if (running !== undefined) {
    running.controller.abort()
    await running.promise
  }
  return startAlignment(bookId, { ...deps, scope: 'changed' })
}

/** True for a book whose alignment has not finished: never started, interrupted, or failed. */
export function needsAlignment(book: Book): boolean {
  return book.alignment === undefined || book.alignment.status !== 'ready'
}

/**
 * Queue every book that is not aligned yet, except failed ones (those wait for a tap on
 * Retry, so a bug cannot loop a phone forever). Called once when the Library mounts. A neural
 * re-alignment cut short by a reload is not resumed: its book is still `ready` with its old
 * beads, and the user can tap Re-align again.
 */
export async function resumeAlignments(deps: AlignmentDeps = {}): Promise<void> {
  const db = deps.db ?? sharedDb()
  const books = await db.books.orderBy('created').toArray()
  await Promise.all(
    books.filter((b) => needsAlignment(b) && b.alignment?.status !== 'failed').map((b) => startAlignment(b.id, deps)),
  )
}
