// The job queue's side of plan.md step 15: a neural re-alignment of a book that is already
// aligned keeps the book readable, replaces the beads on success, and keeps the old ones (with
// an error on the book) on failure. The runner is faked; the model never runs here.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cancelAlignment,
  clearAlignmentError,
  getAlignmentJobs,
  inlineRunner,
  startAlignment,
  subscribeAlignmentJobs,
  type AlignmentJob,
  type Runner,
} from '../src/align/jobs.ts'
import { alignBook, type AlignRequest } from '../src/align/pipeline.ts'
import type { ImportedText } from '../src/import/file.ts'
import { addBook } from '../src/store/books.ts'
import { openDatabase, type InterlinearDB } from '../src/store/db.ts'

let db: InterlinearDB
let n = 0

beforeEach(() => {
  db = openDatabase(`jobs-neural-${n++}`)
})

afterEach(async () => {
  for (const id of getAlignmentJobs().keys()) cancelAlignment(id)
  await db.delete()
})

function txt(fileName: string, text: string): ImportedText {
  const paragraphs = text.split('\n\n').map((t, idx) => ({ idx, text: t }))
  return { fileName, format: 'txt', paragraphs, sections: [], words: text.split(/\s+/).length, meta: null }
}

const DE = txt('k.de.txt', 'I.\n\nGregor lachte im Haus. Samsa schlief im Zimmer.\n\nDie Mutter fand vier Wände.\n\nII.\n\nGregor lachte wieder.')
const EN = txt('k.en.txt', 'I.\n\nGregor laughed in the house. Samsa slept in the room.\n\nMother found four walls.\n\nII.\n\nGregor laughed again.')

/** Pretends to be the worker's neural path: classical beads, stats flagged, model stages reported. */
const fakeNeural: Runner = async (request, onProgress, signal) => {
  if (signal.aborted) throw new Error('aborted')
  expect(request.neural).toBe(true)
  onProgress({ stage: 'model', fraction: 0.1 })
  onProgress({ stage: 'embed', fraction: 0.5 })
  const result = alignBook({ ...request, neural: false }, null, (p) => onProgress({ stage: p.stage, fraction: 0.85 + (p.fraction - 0.15) / 8 }))
  return { ...result, stats: { ...result.stats, neural: true } }
}

describe('startAlignment with neural: true', () => {
  it('passes the flag to the runner, keeps the book ready meanwhile, and saves beads flagged as neural', async () => {
    const book = await addBook({ title: 'K', author: '', de: DE, en: EN }, db)
    await startAlignment(book.id, { db, runner: inlineRunner })
    const before = (await db.books.get(book.id))!
    expect(before.alignment?.stats?.neural).toBe(false)

    const statuses: string[] = []
    const seen: AlignmentJob[] = []
    const checking: Runner = async (request, onProgress, signal) => {
      statuses.push((await db.books.get(book.id))!.alignment!.status)
      return fakeNeural(request, onProgress, signal)
    }
    const unsubscribe = subscribeAlignmentJobs((jobs) => {
      const j = jobs.get(book.id)
      if (j !== undefined) seen.push(j)
    })
    await startAlignment(book.id, { db, runner: checking, neural: true })
    unsubscribe()

    expect(statuses).toEqual(['ready'])
    expect(seen[0]).toMatchObject({ stage: 'queued', neural: true })
    expect(seen.map((j) => j.stage)).toEqual(expect.arrayContaining(['model', 'embed', 'pass1', 'saving']))
    const after = (await db.books.get(book.id))!
    expect(after.alignment).toMatchObject({ status: 'ready', stats: { neural: true, beads: 4 } })
    expect(after.alignment?.error).toBeUndefined()
    expect(await db.beads.where('bookId').equals(book.id).count()).toBe(4)
  })

  it('keeps the old alignment and records the error when the model fails, until dismissed', async () => {
    const book = await addBook({ title: 'K', author: '', de: DE, en: EN }, db)
    await startAlignment(book.id, { db, runner: inlineRunner })
    const beadsBefore = await db.beads.where('bookId').equals(book.id).toArray()

    const offline: Runner = () => Promise.reject(new Error('Failed to fetch'))
    await startAlignment(book.id, { db, runner: offline, neural: true })
    const failed = (await db.books.get(book.id))!
    expect(failed.alignment).toMatchObject({ status: 'ready', error: 'Failed to fetch' })
    expect(failed.alignment?.stats?.neural).toBe(false)
    expect(await db.beads.where('bookId').equals(book.id).toArray()).toEqual(beadsBefore)

    await clearAlignmentError(book.id, db)
    const cleared = (await db.books.get(book.id))!
    expect(cleared.alignment?.status).toBe('ready')
    expect(cleared.alignment?.error).toBeUndefined()
  })

  it('still marks a never-aligned book failed when its (neural) run fails', async () => {
    const book = await addBook({ title: 'K', author: '', de: DE, en: EN }, db)
    const broken: Runner = () => Promise.reject(new Error('boom'))
    await startAlignment(book.id, { db, runner: broken, neural: true })
    expect((await db.books.get(book.id))?.alignment).toMatchObject({ status: 'failed', error: 'boom' })
  })

  it('the inline runner refuses a neural request instead of aligning classically', async () => {
    const request: AlignRequest = { de: { paragraphs: DE.paragraphs, sections: [] }, en: { paragraphs: EN.paragraphs, sections: [] }, neural: true }
    await expect(inlineRunner(request, () => undefined, new AbortController().signal)).rejects.toThrow(/worker/)
  })
})
