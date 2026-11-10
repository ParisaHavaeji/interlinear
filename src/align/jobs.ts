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
 */

import type { Lang, Paragraph } from '../import/types.ts'
import { getParagraphs } from '../store/books.ts'
import { db as sharedDb, type AlignmentState, type BeadRow, type Book, type InterlinearDB, type SentenceRow } from '../store/db.ts'
import { alignBook, type AlignProgress, type AlignRequest, type AlignResult, type AlignStage } from './pipeline.ts'

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

/** Runs the pipeline on this thread. For tests and as a fallback where workers are missing. */
export const inlineRunner: Runner = (request, onProgress, signal) => {
  if (signal.aborted) return Promise.reject(new AlignmentCancelled())
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
}

// ---------------------------------------------------------------------------------------------
// Running and saving

function toParagraph(row: { idx: number; text: string; cls?: string }): Paragraph {
  return row.cls === undefined ? { idx: row.idx, text: row.text } : { idx: row.idx, text: row.text, cls: row.cls }
}

/** Build the worker's request from what the store holds for a book. */
export async function requestFor(book: Book, db: InterlinearDB): Promise<AlignRequest> {
  const side = async (lang: Lang) => ({
    paragraphs: (await getParagraphs(book.id, lang, db)).map(toParagraph),
    sections: book.sources[lang].sections,
  })
  return { de: await side('de'), en: await side('en') }
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

async function setStatus(db: InterlinearDB, bookId: string, status: 'aligning' | 'failed', error?: string): Promise<void> {
  const book = await db.books.get(bookId)
  if (book === undefined) return
  const alignment: AlignmentState = { ...book.alignment, status, updated: Date.now() }
  delete alignment.error
  if (error !== undefined) alignment.error = error
  await db.books.update(bookId, { alignment })
}

async function run(bookId: string, entry: Active, db: InterlinearDB, runner: Runner): Promise<void> {
  const { signal } = entry.controller
  const book = await db.books.get(bookId)
  if (book === undefined || signal.aborted) return
  await setStatus(db, bookId, 'aligning')
  try {
    const request = await requestFor(book, db)
    entry.job.stage = 'structure'
    publish()
    const result = await runner(
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
    await saveAlignment(bookId, result, db)
    entry.job.fraction = 1
    publish()
  } catch (err) {
    if (err instanceof AlignmentCancelled || signal.aborted) return
    console.error(`Alignment of ${bookId} failed`, err)
    try {
      await setStatus(db, bookId, 'failed', err instanceof Error ? err.message : String(err))
    } catch (inner) {
      console.error(`Could not record the failure of ${bookId}`, inner)
    }
  }
}

/**
 * Queue a book for alignment and resolve when it has been saved, failed, or been cancelled.
 * Never rejects; failures land in the book's `alignment.error`.
 */
export function startAlignment(bookId: string, deps: AlignmentDeps = {}): Promise<void> {
  const have = active.get(bookId)
  if (have !== undefined) return have.promise
  const db = deps.db ?? sharedDb()
  const runner = deps.runner ?? defaultRunner
  const controller = new AbortController()
  const entry = { job: { bookId, stage: 'queued', fraction: 0 }, controller } as Active
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

/** True for a book whose alignment has not finished: never started, interrupted, or failed. */
export function needsAlignment(book: Book): boolean {
  return book.alignment === undefined || book.alignment.status !== 'ready'
}

/**
 * Queue every book that is not aligned yet, except failed ones (those wait for a tap on
 * Retry, so a bug cannot loop a phone forever). Called once when the Library mounts.
 */
export async function resumeAlignments(deps: AlignmentDeps = {}): Promise<void> {
  const db = deps.db ?? sharedDb()
  const books = await db.books.orderBy('created').toArray()
  await Promise.all(
    books.filter((b) => needsAlignment(b) && b.alignment?.status !== 'failed').map((b) => startAlignment(b.id, deps)),
  )
}
