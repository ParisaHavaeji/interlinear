import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addBookmark, listBookmarks, removeBookmark } from '../src/bookmarks/store.ts'
import type { ImportedText } from '../src/import/file.ts'
import { addBook, deleteBook } from '../src/store/books.ts'
import { openDatabase, type Book, type InterlinearDB } from '../src/store/db.ts'
import { getProgress, saveProgress } from '../src/store/progress.ts'
import { listUnsynced, markChanged, resetPushed } from '../src/store/sync.ts'
import { SyncEngine, supabaseRemote, type Remote, type RemoteState, type SyncState } from '../src/sync/engine.ts'
import { bookKey, contentKey } from '../src/sync/key.ts'
import { SupabaseClient, type FetchLike } from '../src/sync/supabase.ts'

let db: InterlinearDB
let n = 0

beforeEach(() => {
  db = openDatabase(`sync-test-${n++}`)
})

afterEach(async () => {
  await db.delete()
})

function txt(fileName: string, text: string): ImportedText {
  const paragraphs = text.split('\n\n').map((t, idx) => ({ idx, text: t }))
  return { fileName, format: 'txt', paragraphs, sections: [], words: text.split(/\s+/).length, meta: null }
}

const DE = txt('k.de.txt', 'Als Gregor Samsa erwachte.\n\nEr lag auf dem Rücken.')
const EN = txt('k.en.txt', 'One morning Gregor Samsa woke.\n\nHe lay on his back.')
const DE2 = txt('d.de.txt', 'Ich wollte ja nichts.\n\nNur das.')
const EN2 = txt('d.en.txt', 'I wanted nothing.\n\nOnly that.')

/** The server in memory, with the trigger of schema.sql: an older or equal stamp is dropped. */
function fakeRemote(): Remote & { rows: Map<string, RemoteState>; upserts: RemoteState[]; fail?: boolean } {
  const rows = new Map<string, RemoteState>()
  const upserts: RemoteState[] = []
  const remote = {
    rows,
    upserts,
    fail: false,
    async heads() {
      if (remote.fail) throw new Error('offline')
      return [...rows.values()].map((r) => ({ book_key: r.book_key, updated: r.updated }))
    },
    async fetch(keys: readonly string[]) {
      if (remote.fail) throw new Error('offline')
      return keys.map((k) => rows.get(k)).filter((r): r is RemoteState => r !== undefined)
    },
    async upsert(row: RemoteState) {
      if (remote.fail) throw new Error('offline')
      upserts.push(row)
      const old = rows.get(row.book_key)
      if (old !== undefined && row.updated <= old.updated) return
      rows.set(row.book_key, structuredClone(row))
    },
  }
  return remote
}

const sentence = (text: string) => ({
  type: 'sentence' as const,
  payload: { sentences: [0], translation: [0], text, translationText: 'x', chapter: 0, heading: 'I' },
})

async function book(de = DE, en = EN): Promise<Book> {
  return addBook({ title: 'Die Verwandlung', author: 'Kafka', de, en }, db)
}

describe('content key', () => {
  it('is the same for the same texts, whatever the id, and differs for other texts', async () => {
    const a = await book()
    const b = await book()
    const c = await book(DE2, EN2)
    expect(a.id).not.toBe(b.id)
    expect(await bookKey(a, db)).toBe(await bookKey(b, db))
    expect(await bookKey(a, db)).not.toBe(await bookKey(c, db))
    expect(await bookKey(a, db)).toMatch(/^[0-9a-f]{64}$/)
    expect(await bookKey(a, db)).toBe(
      await contentKey(
        DE.paragraphs.map((p) => p.text),
        EN.paragraphs.map((p) => p.text),
      ),
    )
  })

  it('is stored on the book once computed', async () => {
    const a = await book()
    expect(a.key).toBeUndefined()
    const key = await bookKey(a, db)
    expect((await db.books.get(a.id))?.key).toBe(key)
  })
})

describe('change stamps', () => {
  it('saving progress and changing bookmarks mark the book unsynced', async () => {
    const a = await book()
    expect(await listUnsynced(db)).toEqual([])
    await saveProgress({ bookId: a.id, chapter: 0, para: 1, fraction: 0.5, read: 0.4, updated: 1000 }, db)
    expect(await listUnsynced(db)).toEqual([{ bookId: a.id, changed: 1000, pushed: 0 }])

    const mark = await addBookmark(a.id, sentence('Als'), db)
    expect((await db.sync.get(a.id))!.changed).toBe(mark.created)

    const before = (await db.sync.get(a.id))!.changed
    await removeBookmark(mark.id, db)
    expect((await db.sync.get(a.id))!.changed).toBeGreaterThan(before)
  })

  it('never moves the stamp back, so a change after a pull is newer than what was pulled', async () => {
    const a = await book()
    await db.sync.put({ bookId: a.id, changed: 5000, pushed: 5000 })
    await markChanged(a.id, 4000, db)
    expect((await db.sync.get(a.id))!.changed).toBe(5001)
  })

  it('deleting a book drops its sync row', async () => {
    const a = await book()
    await markChanged(a.id, 1, db)
    await deleteBook(a.id, db)
    expect(await db.sync.toArray()).toEqual([])
  })
})

describe('SyncEngine', () => {
  it('pushes the unsynced books with their state and records the push', async () => {
    const a = await book()
    await saveProgress({ bookId: a.id, chapter: 1, para: 3, fraction: 0.25, read: 0.6, updated: 2000 }, db)
    const mark = await addBookmark(a.id, sentence('Er lag'), db)
    const remote = fakeRemote()
    const engine = new SyncEngine(remote, { db })

    await engine.push()

    const key = await bookKey(a, db)
    expect(remote.upserts).toHaveLength(1)
    expect(remote.rows.get(key)).toEqual({
      book_key: key,
      title: 'Die Verwandlung',
      langs: ['de', 'en'],
      progress: { chapter: 1, para: 3, fraction: 0.25, read: 0.6, updated: 2000 },
      bookmarks: [{ id: mark.id, note: '', created: mark.created, ...sentence('Er lag') }],
      updated: mark.created,
    })
    expect(await listUnsynced(db)).toEqual([])
    expect(engine.current).toMatchObject({ phase: 'idle', error: null })
    expect(engine.current.lastSync).not.toBeNull()
  })

  it('pull applies a newer state from the server: place and bookmarks replaced, stamps agreed', async () => {
    const a = await book()
    await saveProgress({ bookId: a.id, chapter: 0, para: 0, fraction: 0, read: 0, updated: 1000 }, db)
    // A bookmark is stamped with the clock, so the server's state must be later than now.
    const mine = await addBookmark(a.id, sentence('mine'), db)
    const later = Date.now() + 60_000
    const key = await bookKey(a, db)
    const remote = fakeRemote()
    remote.rows.set(key, {
      book_key: key,
      title: 'Die Verwandlung',
      langs: ['de', 'en'],
      progress: { chapter: 1, para: 2, fraction: 0.5, read: 0.7, updated: later },
      bookmarks: [{ id: 'remote-1', note: 'n', created: 8000, ...sentence('theirs') }],
      updated: later,
    })

    await new SyncEngine(remote, { db }).pull()

    expect(await getProgress(a.id, db)).toEqual({ bookId: a.id, chapter: 1, para: 2, fraction: 0.5, read: 0.7, updated: later })
    const marks = await listBookmarks(a.id, db)
    expect(marks.map((m) => m.id)).toEqual(['remote-1'])
    expect(marks[0]).toMatchObject({ bookId: a.id, note: 'n', created: 8000, type: 'sentence' })
    expect(await db.bookmarks.get(mine.id)).toBeUndefined()
    expect(await db.sync.get(a.id)).toEqual({ bookId: a.id, changed: later, pushed: later })
    expect(remote.upserts).toEqual([])
  })

  it('pull pushes a book that is newer here, and leaves one that agrees alone', async () => {
    const a = await book()
    const b = await book(DE2, EN2)
    await saveProgress({ bookId: a.id, chapter: 0, para: 1, fraction: 0, read: 0.1, updated: 5000 }, db)
    await saveProgress({ bookId: b.id, chapter: 0, para: 1, fraction: 0, read: 0.1, updated: 3000 }, db)
    const keyA = await bookKey(a, db)
    const keyB = await bookKey(b, db)
    const remote = fakeRemote()
    remote.rows.set(keyA, { book_key: keyA, title: '', langs: [], progress: null, bookmarks: [], updated: 4000 })
    remote.rows.set(keyB, { book_key: keyB, title: '', langs: [], progress: null, bookmarks: [], updated: 3000 })
    await db.sync.put({ bookId: b.id, changed: 3000, pushed: 3000 })

    await new SyncEngine(remote, { db }).pull()

    expect(remote.upserts.map((u) => u.book_key)).toEqual([keyA])
    expect(remote.rows.get(keyA)!.updated).toBe(5000)
    expect(await db.sync.get(a.id)).toEqual({ bookId: a.id, changed: 5000, pushed: 5000 })
  })

  it('a row on the server for a book not here waits; importing the same texts picks it up', async () => {
    const key = await contentKey(
      DE.paragraphs.map((p) => p.text),
      EN.paragraphs.map((p) => p.text),
    )
    const remote = fakeRemote()
    remote.rows.set(key, { book_key: key, title: 'Elsewhere', langs: ['de', 'en'], progress: { chapter: 2, para: 0, fraction: 0, read: 0.9, updated: 7000 }, bookmarks: [], updated: 7000 })
    const engine = new SyncEngine(remote, { db })

    await engine.pull()
    expect(await db.progress.toArray()).toEqual([])

    const a = await book()
    await engine.pull()
    expect(await getProgress(a.id, db)).toMatchObject({ chapter: 2, read: 0.9 })
    expect(remote.rows.get(key)!.title).toBe('Elsewhere')
  })

  it('a stale push cannot replace a newer state on the server; the next pull brings it down', async () => {
    const a = await book()
    const key = await bookKey(a, db)
    const remote = fakeRemote()
    remote.rows.set(key, { book_key: key, title: '', langs: [], progress: { chapter: 3, para: 0, fraction: 0, read: 1, updated: 9000 }, bookmarks: [], updated: 9000 })
    await saveProgress({ bookId: a.id, chapter: 0, para: 0, fraction: 0, read: 0, updated: 1000 }, db)
    const engine = new SyncEngine(remote, { db })

    await engine.push()
    expect(remote.rows.get(key)!.updated).toBe(9000)

    await engine.pull()
    expect(await getProgress(a.id, db)).toMatchObject({ chapter: 3, updated: 9000 })
  })

  it('reports a failure in its state, keeps the rows unsynced and recovers on the next try', async () => {
    const a = await book()
    await saveProgress({ bookId: a.id, chapter: 0, para: 0, fraction: 0, read: 0, updated: 1000 }, db)
    const remote = fakeRemote()
    remote.fail = true
    const states: SyncState[] = []
    const engine = new SyncEngine(remote, { db, retryDelay: 60_000, onState: (s) => states.push(s) })

    await engine.push()
    expect(engine.current).toMatchObject({ phase: 'error', error: 'offline', lastSync: null })
    expect(states.map((s) => s.phase)).toEqual(['syncing', 'error'])
    expect(await listUnsynced(db)).toHaveLength(1)

    remote.fail = false
    await engine.push()
    expect(engine.current.phase).toBe('idle')
    expect(await listUnsynced(db)).toEqual([])
    engine.stop()
  })

  it('a book deleted before its push is dropped from the queue', async () => {
    const a = await book()
    await db.sync.put({ bookId: a.id, changed: 10, pushed: 0 })
    await db.books.delete(a.id)
    const remote = fakeRemote()
    await new SyncEngine(remote, { db }).push()
    expect(remote.upserts).toEqual([])
    expect(await db.sync.toArray()).toEqual([])
  })

  it('after the pushes are forgotten (sign-out), the next push sends everything again', async () => {
    const a = await book()
    await saveProgress({ bookId: a.id, chapter: 0, para: 0, fraction: 0, read: 0, updated: 1000 }, db)
    const remote = fakeRemote()
    const engine = new SyncEngine(remote, { db })
    await engine.push()
    await resetPushed(db)
    expect(await listUnsynced(db)).toHaveLength(1)
    const other = fakeRemote()
    await new SyncEngine(other, { db }).push()
    expect(other.upserts).toHaveLength(1)
  })

  it('started, it pushes a change on its own after the pause', async () => {
    const a = await book()
    const remote = fakeRemote()
    const engine = new SyncEngine(remote, { db, debounce: 10 })
    engine.start()
    await saveProgress({ bookId: a.id, chapter: 0, para: 2, fraction: 0, read: 0.3, updated: 1000 }, db)
    const deadline = Date.now() + 3000
    while (remote.upserts.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    engine.stop()
    expect(remote.upserts).toHaveLength(1)
    expect(remote.upserts[0].progress).toMatchObject({ para: 2 })
  })

  it('ignores malformed rows from the server rather than storing them', async () => {
    const a = await book()
    const key = await bookKey(a, db)
    const remote = fakeRemote()
    remote.rows.set(key, {
      book_key: key,
      title: '',
      langs: [],
      progress: { chapter: 'one' } as unknown as RemoteState['progress'],
      bookmarks: [{ id: 'ok', note: '', created: 1, ...sentence('fine') }, { nonsense: true } as unknown as RemoteState['bookmarks'][number]],
      updated: 5,
    })
    await new SyncEngine(remote, { db }).pull()
    expect(await getProgress(a.id, db)).toBeUndefined()
    expect((await listBookmarks(a.id, db)).map((m) => m.id)).toEqual(['ok'])
  })
})

describe('supabaseRemote', () => {
  const session = {
    accessToken: 'tok',
    refreshToken: 'ref',
    expiresAt: 4_000_000_000,
    user: { id: 'user-7', email: null, name: null, avatar: null },
  }

  function client(answer: unknown) {
    const calls: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] = []
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: JSON.parse(init.body) }) })
      return { status: 200, ok: true, text: async () => (answer === undefined ? '' : JSON.stringify(answer)) }
    }
    const map = new Map([['interlinear.session', JSON.stringify(session)]])
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) }
    return { remote: supabaseRemote(new SupabaseClient({ url: 'https://p.supabase.co', anonKey: 'anon' }, { fetch, storage })), calls }
  }

  it('reads the heads and the rows of given keys', async () => {
    const { remote, calls } = client([{ book_key: 'a', updated: 1 }])
    expect(await remote.heads()).toEqual([{ book_key: 'a', updated: 1 }])
    expect(calls[0].url).toBe('https://p.supabase.co/rest/v1/reading_state?select=book_key,updated')
    await remote.fetch(['a', 'b'])
    expect(calls[1].url).toBe('https://p.supabase.co/rest/v1/reading_state?select=book_key,title,langs,progress,bookmarks,updated&book_key=in.(a,b)')
    expect(await remote.fetch([])).toEqual([])
    expect(calls).toHaveLength(2)
  })

  it('upserts as the signed-in user with merge-duplicates', async () => {
    const { remote, calls } = client(undefined)
    const row: RemoteState = { book_key: 'a', title: 't', langs: ['de', 'en'], progress: null, bookmarks: [], updated: 3 }
    await remote.upsert(row)
    expect(calls[0]).toMatchObject({
      url: 'https://p.supabase.co/rest/v1/reading_state',
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal', Authorization: 'Bearer tok' },
      body: { user_id: 'user-7', ...row },
    })
  })
})
