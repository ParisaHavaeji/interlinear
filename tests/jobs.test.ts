import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AlignmentCancelled,
  applyChapterEdits,
  cancelAlignment,
  getAlignmentJobs,
  inlineRunner,
  needsAlignment,
  requestFor,
  resumeAlignments,
  saveAlignment,
  startAlignment,
  subscribeAlignmentJobs,
  type AlignmentJob,
  type Runner,
} from '../src/align/jobs.ts'
import { alignBook, pairKey, type AlignRequest, type AlignResult } from '../src/align/pipeline.ts'
import type { ImportedText } from '../src/import/file.ts'
import { parseTxt } from '../src/import/txt.ts'
import { addBook, deleteBook } from '../src/store/books.ts'
import { openDatabase, type InterlinearDB } from '../src/store/db.ts'

let db: InterlinearDB
let n = 0

beforeEach(() => {
  db = openDatabase(`jobs-${n++}`)
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

const read = (file: string) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')

/** A fixture as the importer would deliver it. */
function fixture(file: string): ImportedText {
  const paragraphs = parseTxt(read(file))
  return { fileName: file, format: 'txt', paragraphs, sections: [], words: 0, meta: null }
}

/** Resolves on the next macrotask, so queued promise chains get to run. */
const tick = () => new Promise((r) => setTimeout(r, 0))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

/** Rejects with {@link AlignmentCancelled} once the signal aborts, as a well-behaved runner must. */
const aborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new AlignmentCancelled())
    else signal.addEventListener('abort', () => reject(new AlignmentCancelled()))
  })

describe('startAlignment', () => {
  it('marks a new book pending, aligns it through the runner and stores sentences, beads and stats', async () => {
    const book = await addBook({ title: 'K', author: '', de: DE, en: EN }, db)
    expect(book.alignment).toMatchObject({ status: 'pending' })
    expect(needsAlignment(book)).toBe(true)

    const seen: AlignmentJob[][] = []
    const unsubscribe = subscribeAlignmentJobs((jobs) => seen.push([...jobs.values()]))
    await startAlignment(book.id, { db, runner: inlineRunner })
    unsubscribe()

    const stored = (await db.books.get(book.id))!
    expect(stored.alignment).toMatchObject({ status: 'ready', stats: { beads: 4, oneToOne: 4, pairedChapters: 2 } })
    expect(stored.alignment?.chapters?.pairs).toMatchObject([
      { de: [0], en: [0] },
      { de: [1], en: [1] },
    ])
    expect(stored.alignment?.lexicon).toEqual([])
    expect(needsAlignment(stored)).toBe(false)

    const sentences = await db.sentences.where('[bookId+lang]').equals([book.id, 'de']).sortBy('idx')
    expect(sentences.map((s) => s.text)).toEqual([
      'I.',
      'Gregor lachte im Haus.',
      'Samsa schlief im Zimmer.',
      'Die Mutter fand vier Wände.',
      'II.',
      'Gregor lachte wieder.',
    ])
    expect(sentences[1]).toMatchObject({ paraIdx: 1, charStart: 0, charEnd: 22 })
    expect(await db.sentences.where('[bookId+lang]').equals([book.id, 'en']).count()).toBe(6)

    const beads = await db.beads.where('bookId').equals(book.id).sortBy('beadIdx')
    expect(beads.map((b) => b.beadIdx)).toEqual([0, 1, 2, 3])
    expect(beads.map((b) => `${b.deSentenceIdx.join('+')}:${b.enSentenceIdx.join('+')}`)).toEqual(['1:1', '2:2', '3:3', '5:5'])
    for (const b of beads) {
      expect(b.manual).toBe(false)
      expect(b.confidence).toBeGreaterThan(0.5)
    }

    // The live job went queued → stages → saving → 100% → gone, never backwards.
    const mine = seen.map((jobs) => jobs.find((j) => j.bookId === book.id))
    expect(mine[0]).toMatchObject({ stage: 'queued', fraction: 0 })
    expect(mine.some((j) => j?.stage === 'pass1')).toBe(true)
    expect(mine.some((j) => j?.stage === 'saving')).toBe(true)
    expect(mine.at(-1)).toBeUndefined()
    const fractions = mine.filter((j): j is AlignmentJob => j !== undefined).map((j) => j.fraction)
    for (let i = 1; i < fractions.length; i++) expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1])
    expect(getAlignmentJobs().size).toBe(0)
  })

  it('returns the same promise while a book is queued or running, and runs books one at a time', async () => {
    let running = 0
    let maxRunning = 0
    const slow: Runner = async (request, onProgress, signal) => {
      running++
      maxRunning = Math.max(maxRunning, running)
      await tick()
      running--
      return inlineRunner(request, onProgress, signal)
    }
    const a = await addBook({ title: 'A', author: '', de: DE, en: EN }, db)
    const b = await addBook({ title: 'B', author: '', de: DE, en: EN }, db)
    const p1 = startAlignment(a.id, { db, runner: slow })
    const p2 = startAlignment(a.id, { db, runner: slow })
    const p3 = startAlignment(b.id, { db, runner: slow })
    expect(p2).toBe(p1)
    expect(getAlignmentJobs().get(b.id)).toMatchObject({ stage: 'queued' })
    await Promise.all([p1, p3])
    expect(maxRunning).toBe(1)
    expect((await db.books.get(a.id))?.alignment?.status).toBe('ready')
    expect((await db.books.get(b.id))?.alignment?.status).toBe('ready')
  })

  it('records a failure on the book instead of rejecting, and Retry (startAlignment) can fix it', async () => {
    const book = await addBook({ title: 'F', author: '', de: DE, en: EN }, db)
    const broken: Runner = () => Promise.reject(new Error('boom'))
    await expect(startAlignment(book.id, { db, runner: broken })).resolves.toBeUndefined()
    const failed = (await db.books.get(book.id))!
    expect(failed.alignment).toMatchObject({ status: 'failed', error: 'boom' })
    expect(needsAlignment(failed)).toBe(true)
    expect(await db.sentences.where('bookId').equals(book.id).count()).toBe(0)

    await startAlignment(book.id, { db, runner: inlineRunner })
    const fixed = (await db.books.get(book.id))!
    expect(fixed.alignment?.status).toBe('ready')
    expect(fixed.alignment?.error).toBeUndefined()
  })

  it('writes nothing for a book deleted while it was aligning', async () => {
    const book = await addBook({ title: 'D', author: '', de: DE, en: EN }, db)
    const gate = deferred()
    const started = deferred()
    const held: Runner = async (request, onProgress, signal) => {
      started.resolve()
      await Promise.race([gate.promise, aborted(signal)])
      return inlineRunner(request, onProgress, signal)
    }
    const done = startAlignment(book.id, { db, runner: held })
    await started.promise
    expect((await db.books.get(book.id))?.alignment?.status).toBe('aligning')
    await deleteBook(book.id, db)
    gate.resolve()
    await done
    expect(await db.books.count()).toBe(0)
    expect(await db.sentences.count()).toBe(0)
    expect(await db.beads.count()).toBe(0)
  })

  it('cancelAlignment aborts the runner and leaves the book as it was', async () => {
    const book = await addBook({ title: 'C', author: '', de: DE, en: EN }, db)
    const started = deferred()
    const abortable: Runner = (_request, _onProgress, signal) => {
      started.resolve()
      return aborted(signal)
    }
    const done = startAlignment(book.id, { db, runner: abortable })
    await started.promise
    cancelAlignment(book.id)
    await done
    expect(getAlignmentJobs().size).toBe(0)
    expect((await db.books.get(book.id))?.alignment?.status).toBe('aligning')
    expect(await db.sentences.count()).toBe(0)
  })
})

describe('saveAlignment', () => {
  it('replaces an earlier result rather than adding to it', async () => {
    const book = await addBook({ title: 'R', author: '', de: DE, en: EN }, db)
    const result = alignBook(await requestFor(book, db))
    expect(await saveAlignment(book.id, result, db)).toBe(true)
    expect(await saveAlignment(book.id, result, db)).toBe(true)
    expect(await db.sentences.where('bookId').equals(book.id).count()).toBe(12)
    expect(await db.beads.where('bookId').equals(book.id).count()).toBe(4)
  })

  it('returns false and writes nothing for an unknown book', async () => {
    const book = await addBook({ title: 'R', author: '', de: DE, en: EN }, db)
    const result: AlignResult = alignBook(await requestFor(book, db))
    expect(await saveAlignment('nope', result, db)).toBe(false)
    expect(await db.sentences.count()).toBe(0)
  })
})

describe('resumeAlignments', () => {
  it('queues pending and interrupted books, skips ready and failed ones', async () => {
    const pending = await addBook({ title: 'P', author: '', de: DE, en: EN }, db)
    const interrupted = await addBook({ title: 'I', author: '', de: DE, en: EN }, db)
    const ready = await addBook({ title: 'R', author: '', de: DE, en: EN }, db)
    const failed = await addBook({ title: 'F', author: '', de: DE, en: EN }, db)
    const legacy = await addBook({ title: 'L', author: '', de: DE, en: EN }, db)
    await db.books.update(interrupted.id, { alignment: { status: 'aligning', updated: 1 } })
    await db.books.update(failed.id, { alignment: { status: 'failed', updated: 1, error: 'x' } })
    await db.books.update(legacy.id, { alignment: undefined })
    await startAlignment(ready.id, { db, runner: inlineRunner })

    const ran: string[] = []
    const spy: Runner = (request, onProgress, signal) => {
      ran.push(request.de.paragraphs[1].text)
      return inlineRunner(request, onProgress, signal)
    }
    await resumeAlignments({ db, runner: spy })
    expect(ran).toHaveLength(3)
    for (const b of [pending, interrupted, legacy]) expect((await db.books.get(b.id))?.alignment?.status).toBe('ready')
    expect((await db.books.get(failed.id))?.alignment?.status).toBe('failed')
  })
})

describe('applyChapterEdits (step 17)', () => {
  // Three chapters on both sides, the third twice as long as the others, so the length DP
  // pairs them one to one and, with one side's third chapter gone, drops the other's.
  const DE3 = txt(
    'k.de.txt',
    'I.\n\nGregor lachte im Haus. Samsa schlief im Zimmer.\n\nII.\n\nDie Mutter fand vier Wände. Der Vater las die Zeitung.\n\nIII.\n\nGregor lachte wieder laut und lange. Grete spielte Geige im Zimmer. Alle hörten ihr gerne zu.',
  )
  const EN3 = txt(
    'k.en.txt',
    'I.\n\nGregor laughed in the house. Samsa slept in the room.\n\nII.\n\nMother found four walls. Father read the newspaper.\n\nIII.\n\nGregor laughed again loudly and long. Grete played violin in the room. Everyone liked listening to her.',
  )
  const shape = (beads: { deSentenceIdx: number[]; enSentenceIdx: number[] }[]) => beads.map((b) => `${b.deSentenceIdx}:${b.enSentenceIdx}`)

  /** The inline runner, remembering what it was asked and what it produced. */
  function recording() {
    const calls: { request: AlignRequest; result: AlignResult }[] = []
    const runner: Runner = async (request, onProgress, signal) => {
      const result = await inlineRunner(request, onProgress, signal)
      calls.push({ request, result })
      return result
    }
    return { calls, runner }
  }

  it('excludes a chapter, keeping the other chapters’ beads untouched, and brings it back', async () => {
    const book = await addBook({ title: 'K', author: '', de: DE3, en: EN3 }, db)
    await startAlignment(book.id, { db, runner: inlineRunner })
    const before = await db.beads.where('bookId').equals(book.id).sortBy('beadIdx')
    expect(shape(before)).toEqual(['1:1', '2:2', '4:4', '5:5', '7:7', '8:8', '9:9'])
    await db.beads.update([book.id, 0], { manual: true })
    const { calls, runner } = recording()

    // Chapter III of the German side is keyed by its first paragraph, 5.
    await applyChapterEdits(book.id, { de: { exclude: [5] } }, { db, runner })
    const edited = (await db.books.get(book.id))!
    expect(edited.chapterEdits).toEqual({ de: { exclude: [5] } })
    expect(edited.alignment?.status).toBe('ready')
    expect(edited.alignment?.chapters?.de.map((c) => c.heading)).toEqual(['I.', 'II.'])
    expect(edited.alignment?.chapters?.excluded?.de.map((c) => c.heading)).toEqual(['III.'])
    expect(edited.alignment?.chapters?.pairs.map((p) => `${p.de}|${p.en}`)).toEqual(['0|0', '1|1', '|2'])
    const after = await db.beads.where('bookId').equals(book.id).sortBy('beadIdx')
    expect(shape(after)).toEqual(['1:1', '2:2', '4:4', '5:5'])
    expect(after.map((b) => b.manual)).toEqual([true, false, false, false])
    expect(after.map((b) => b.confidence)).toEqual(before.slice(0, 4).map((b) => b.confidence))
    expect(edited.alignment?.stats).toMatchObject({ beads: 4, pairedChapters: 2, sentences: { de: 10, en: 10 } })
    // Both remaining pairs were reused; the runner had nothing to align.
    expect(calls).toHaveLength(1)
    expect(calls[0].request.reuse).toHaveLength(2)
    expect(calls[0].request.lexicon).toEqual([])
    expect(calls[0].result.beads).toEqual([])
    expect(await db.sentences.where('bookId').equals(book.id).count()).toBe(20)

    // Undoing the edit aligns chapter III afresh and keeps the rest once more.
    await applyChapterEdits(book.id, {}, { db, runner })
    const restored = (await db.books.get(book.id))!
    expect(restored.alignment?.chapters?.pairs.map((p) => `${p.de}|${p.en}`)).toEqual(['0|0', '1|1', '2|2'])
    const again = await db.beads.where('bookId').equals(book.id).sortBy('beadIdx')
    expect(shape(again)).toEqual(['1:1', '2:2', '4:4', '5:5', '7:7', '8:8', '9:9'])
    expect(again.map((b) => b.manual)).toEqual([true, false, false, false, false, false, false])
    expect(calls[1].request.reuse).toHaveLength(2)
    expect(shape(calls[1].result.beads)).toEqual(['7:7', '8:8', '9:9'])
    expect(restored.alignment?.stats?.beads).toBe(7)
  })

  it('pairs two chapters by hand and re-aligns only the pairs that changed', async () => {
    const book = await addBook({ title: 'K', author: '', de: DE3, en: EN3 }, db)
    await startAlignment(book.id, { db, runner: inlineRunner })
    const { calls, runner } = recording()
    await applyChapterEdits(book.id, { pairs: [{ de: [5], en: [3] }] }, { db, runner })
    const edited = (await db.books.get(book.id))!
    const pairs = edited.alignment!.chapters!.pairs
    expect(pairs.map((p) => `${p.de}|${p.en}${p.manual ? '*' : ''}`)).toEqual(['0|0', '1|2', '2|1*'])
    const beads = await db.beads.where('bookId').equals(book.id).sortBy('beadIdx')
    // Pair one is kept as it was; the two re-paired chapters are aligned afresh, in pair order.
    expect(shape(beads.slice(0, 2))).toEqual(['1:1', '2:2'])
    const rest = beads.slice(2)
    expect(rest.flatMap((b) => b.deSentenceIdx)).toEqual([4, 5, 7, 8, 9])
    expect(rest.flatMap((b) => b.enSentenceIdx)).toEqual([7, 8, 9, 4, 5])
    expect(calls[0].request.reuse).toEqual([pairKey(pairs[0], edited.alignment!.chapters!)])
    expect(calls[0].result.beads).toHaveLength(rest.length)
    expect(edited.alignment?.stats).toMatchObject({ beads: beads.length, pairedChapters: 3 })
  })

  it('does nothing for a pre-aligned book, and aligns in full when the book is not ready', async () => {
    const lines = (file: string, text: string): ImportedText => ({ ...txt(file, text.replace(/\n/g, '\n\n')), layout: 'lines' })
    const pre = await addBook({ title: 'P', author: '', de: lines('p.de.txt', 'Eins.\nZwei.'), en: lines('p.en.txt', 'One.\nTwo.') }, db)
    await startAlignment(pre.id, { db, runner: inlineRunner })
    await applyChapterEdits(pre.id, { de: { exclude: [0] } }, { db, runner: inlineRunner })
    expect((await db.books.get(pre.id))?.chapterEdits).toBeUndefined()

    const fresh = await addBook({ title: 'F', author: '', de: DE3, en: EN3 }, db)
    const { calls, runner } = recording()
    await applyChapterEdits(fresh.id, { de: { exclude: [5] } }, { db, runner })
    expect(calls[0].request.reuse).toBeUndefined()
    expect(calls[0].request.edits).toEqual({ de: { exclude: [5] } })
    const stored = (await db.books.get(fresh.id))!
    expect(stored.alignment?.status).toBe('ready')
    expect(stored.alignment?.chapters?.de.map((c) => c.heading)).toEqual(['I.', 'II.'])
    expect(shape(await db.beads.where('bookId').equals(fresh.id).sortBy('beadIdx'))).toEqual(['1:1', '2:2', '4:4', '5:5'])
  })
})

describe('end to end on the Kafka fixture', () => {
  it('imports, aligns and stores the novella in a few seconds', async () => {
    const book = await addBook(
      { title: 'Die Verwandlung', author: 'Kafka', de: fixture('kafka-verwandlung.de.txt'), en: fixture('kafka-verwandlung.en.txt') },
      db,
    )
    const t0 = performance.now()
    await startAlignment(book.id, { db, runner: inlineRunner })
    const elapsed = performance.now() - t0
    const stored = (await db.books.get(book.id))!
    expect(stored.alignment?.status).toBe('ready')
    expect(stored.alignment?.stats?.beads).toBeGreaterThan(600)
    expect(stored.alignment?.chapters?.de.map((c) => c.heading)).toEqual(['I.', 'II.', 'III.'])
    expect(await db.beads.where('bookId').equals(book.id).count()).toBe(stored.alignment?.stats?.beads)
    expect(await db.sentences.where('bookId').equals(book.id).count()).toBe(
      stored.alignment!.stats!.sentences.de + stored.alignment!.stats!.sentences.en,
    )
    expect(elapsed).toBeLessThan(15_000)
  }, 30_000)
})
