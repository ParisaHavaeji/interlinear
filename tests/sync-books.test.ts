// Book sync (plan.md step 37): aligned books travel to the account as gzipped bundles and come
// down on other devices on demand. Two devices are two databases over one in-memory server.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inlineRunner, startAlignment } from '../src/align/jobs.ts'
import { addBookmark, listBookmarks } from '../src/bookmarks/store.ts'
import type { ImportedText } from '../src/import/file.ts'
import { addBook, deleteBook } from '../src/store/books.ts'
import { gunzipBundle } from '../src/store/bundle.ts'
import { openDatabase, type Book, type InterlinearDB } from '../src/store/db.ts'
import { getProgress, saveProgress } from '../src/store/progress.ts'
import { SyncEngine, type BundleMeta, type Remote, type RemoteBook, type RemoteHead, type RemoteState } from '../src/sync/engine.ts'
import { bookKey } from '../src/sync/key.ts'

const dbs: InterlinearDB[] = []
let n = 0

function device(): InterlinearDB {
  const db = openDatabase(`sync-books-${n++}`)
  dbs.push(db)
  return db
}

afterEach(async () => {
  for (const db of dbs.splice(0)) await db.delete()
})

function txt(fileName: string, text: string): ImportedText {
  const paragraphs = text.split('\n\n').map((t, idx) => ({ idx, text: t }))
  return { fileName, format: 'txt', paragraphs, sections: [], words: text.split(/\s+/).length, meta: null, layout: 'blocks' }
}

const DE = txt('k.de.txt', 'I.\n\nGregor lachte im Haus. Samsa schlief im Zimmer.\n\nDie Mutter fand vier Wände.\n\nII.\n\nGregor lachte wieder.')
const EN = txt('k.en.txt', 'I.\n\nGregor laughed in the house. Samsa slept in the room.\n\nMother found four walls.\n\nII.\n\nGregor laughed again.')
const DE2 = txt('d.de.txt', 'Ich wollte ja nichts.\n\nNur das.')
const EN2 = txt('d.en.txt', 'I wanted nothing.\n\nOnly that.')

type Server = Remote & {
  rows: Map<string, RemoteState>
  bundles: Map<string, { bytes: Uint8Array<ArrayBuffer>; size: number; at: number }>
  uploads: string[]
  downloads: string[]
}

/** The server in memory: rows as in sync-engine.test.ts plus the bucket, with the trigger's rules for both stamps. */
function fakeServer(): Server {
  const rows = new Map<string, RemoteState>()
  const bundles = new Map<string, { bytes: Uint8Array<ArrayBuffer>; size: number; at: number }>()
  const uploads: string[] = []
  const downloads: string[] = []
  return {
    rows,
    bundles,
    uploads,
    downloads,
    async heads(): Promise<RemoteHead[]> {
      return [...rows.values()].map((r) => {
        const b = bundles.get(r.book_key)
        return { book_key: r.book_key, updated: r.updated, title: r.title, bundle_size: b?.size ?? null, bundle_at: b?.at ?? null }
      })
    },
    async fetch(keys) {
      return keys.map((k) => rows.get(k)).filter((r): r is RemoteState => r !== undefined)
    },
    async upsert(row) {
      const old = rows.get(row.book_key)
      if (old !== undefined && row.updated <= old.updated) return
      rows.set(row.book_key, structuredClone(row))
    },
    async upload(key: string, bytes: Uint8Array<ArrayBuffer>, meta: BundleMeta) {
      uploads.push(key)
      const old = bundles.get(key)
      if (old === undefined || meta.at >= old.at) bundles.set(key, { bytes, size: meta.size, at: meta.at })
      if (!rows.has(key)) rows.set(key, { book_key: key, title: meta.title, langs: meta.langs, progress: null, bookmarks: [], updated: 0 })
    },
    async download(key) {
      downloads.push(key)
      const b = bundles.get(key)
      if (b === undefined) throw new Error('Object not found')
      return b.bytes
    },
    async remove(key) {
      bundles.delete(key)
      rows.delete(key)
    },
  }
}

async function alignedBook(db: InterlinearDB, de = DE, en = EN): Promise<Book> {
  const book = await addBook({ title: 'Die Verwandlung', author: 'Franz Kafka', de, en }, db)
  await startAlignment(book.id, { db, runner: inlineRunner })
  const stored = (await db.books.get(book.id))!
  expect(stored.alignment?.status).toBe('ready')
  return stored
}

/** Make a "repair": pin the first bead and move the alignment stamp, as `align/repair.ts` does. */
async function repair(db: InterlinearDB, bookId: string, at: number): Promise<void> {
  const bead = (await db.beads.where('bookId').equals(bookId).sortBy('beadIdx'))[0]
  await db.beads.put({ ...bead, manual: true, confidence: 1 })
  const book = (await db.books.get(bookId))!
  await db.books.update(bookId, { alignment: { ...book.alignment!, updated: at } })
}

describe('book sync', () => {
  let server: Server
  beforeEach(() => {
    server = fakeServer()
  })

  it('uploads an aligned book once, gzipped, with its size and stamp, and not again until it changes', async () => {
    const db = device()
    const book = await alignedBook(db)
    const engine = new SyncEngine(server, { db })

    await engine.pull()
    const key = await bookKey(book, db)
    expect(server.uploads).toEqual([key])
    const stored = server.bundles.get(key)!
    expect(stored.at).toBe(book.alignment!.updated)
    expect(stored.size).toBe(stored.bytes.length)
    expect([stored.bytes[0], stored.bytes[1]]).toEqual([0x1f, 0x8b])
    expect((await gunzipBundle(stored.bytes)).book.title).toBe('Die Verwandlung')
    expect(server.rows.get(key)).toMatchObject({ title: 'Die Verwandlung', progress: null, updated: 0 })
    expect((await db.sync.get(book.id))?.bundled).toBe(book.alignment!.updated)

    await engine.pull()
    await engine.push()
    expect(server.uploads).toHaveLength(1)
  })

  it('uploads again after a repair, and the other device takes the repaired alignment', async () => {
    const laptop = device()
    const phone = device()
    const book = await alignedBook(laptop)
    const key = await bookKey(book, laptop)
    const onLaptop = new SyncEngine(server, { db: laptop })
    const onPhone = new SyncEngine(server, { db: phone })
    await onLaptop.pull()
    await onPhone.pull()
    const copy = await onPhone.download(key)

    await repair(phone, copy.id, book.alignment!.updated + 1000)
    await onPhone.push()
    expect(server.uploads).toEqual([key, key])
    expect(server.bundles.get(key)!.at).toBe(book.alignment!.updated + 1000)

    await onLaptop.pull()
    const beads = await laptop.beads.where('bookId').equals(book.id).sortBy('beadIdx')
    expect(beads[0]).toMatchObject({ manual: true, confidence: 1 })
    expect((await laptop.books.get(book.id))!.alignment!.updated).toBe(book.alignment!.updated + 1000)
    expect((await laptop.sync.get(book.id))?.bundled).toBe(book.alignment!.updated + 1000)
    // Taking it is not a change of its own: nothing goes back up.
    await onLaptop.pull()
    expect(server.uploads).toHaveLength(2)
  })

  it('never uploads a book that is not aligned yet', async () => {
    const db = device()
    await addBook({ title: 'Pending', author: 'X', de: DE, en: EN }, db)
    const engine = new SyncEngine(server, { db })
    await engine.pull()
    await engine.push()
    expect(server.uploads).toEqual([])
  })

  it('lists the account’s books not on this device, and downloads one aligned at its place with its bookmarks', async () => {
    const laptop = device()
    const phone = device()
    const book = await alignedBook(laptop)
    const key = await bookKey(book, laptop)
    await saveProgress({ bookId: book.id, chapter: 1, para: 0, fraction: 0.5, read: 0.8, updated: 5000 }, laptop)
    await addBookmark(book.id, { type: 'sentence', payload: { sentences: [0], translation: [0], text: 'Gregor', translationText: 'Gregor', chapter: 0, heading: 'I.' } }, laptop)
    await new SyncEngine(server, { db: laptop }).pull()

    const offered: RemoteBook[][] = []
    const onPhone = new SyncEngine(server, { db: phone, onRemoteBooks: (b) => offered.push(b) })
    await onPhone.pull()
    expect(offered.at(-1)).toEqual([{ key, title: 'Die Verwandlung', size: server.bundles.get(key)!.size, at: book.alignment!.updated }])
    expect(await phone.books.count()).toBe(0)

    const copy = await onPhone.download(key)
    expect(copy.id).toBe(book.id)
    expect(copy.key).toBe(key)
    expect(copy.alignment).toMatchObject({ status: 'ready', updated: book.alignment!.updated })
    expect(await phone.beads.where('bookId').equals(copy.id).count()).toBe(await laptop.beads.where('bookId').equals(book.id).count())
    expect(await getProgress(copy.id, phone)).toMatchObject({ chapter: 1, read: 0.8 })
    expect((await listBookmarks(copy.id, phone)).map((b) => b.payload)).toHaveLength(1)
    expect(offered.at(-1)).toEqual([])
    expect(onPhone.remoteBooks).toEqual([])

    // A second download of the same key is the book already here; nothing is fetched or uploaded.
    expect((await onPhone.download(key)).id).toBe(copy.id)
    expect(server.downloads).toHaveLength(1)
    await onPhone.pull()
    await onPhone.push()
    expect(server.uploads).toEqual([key])
  })

  it('a failed download rejects and leaves nothing behind', async () => {
    const phone = device()
    const engine = new SyncEngine(server, { db: phone })
    await expect(engine.download('missing')).rejects.toThrow('Object not found')
    expect(await phone.books.count()).toBe(0)
    // The engine carries on after it.
    await engine.pull()
    expect(engine.current.phase).toBe('idle')
  })

  it('delete everywhere removes the book from the account; the other device drops the tile and keeps its copy to itself', async () => {
    const laptop = device()
    const phone = device()
    const tablet = device()
    const book = await alignedBook(laptop)
    const key = await bookKey(book, laptop)
    const onLaptop = new SyncEngine(server, { db: laptop })
    await onLaptop.pull()
    const onPhone = new SyncEngine(server, { db: phone })
    await onPhone.pull()
    const copy = await onPhone.download(key)
    const onTablet = new SyncEngine(server, { db: tablet })
    await onTablet.pull()
    expect(onTablet.remoteBooks.map((b) => b.key)).toEqual([key])

    await onLaptop.removeFromAccount(book.id)
    await deleteBook(book.id, laptop)
    expect(server.rows.has(key)).toBe(false)
    expect(server.bundles.has(key)).toBe(false)

    await onTablet.pull()
    expect(onTablet.remoteBooks).toEqual([])

    await saveProgress({ bookId: copy.id, chapter: 0, para: 1, fraction: 0, read: 0.2, updated: Date.now() }, phone)
    await onPhone.pull()
    await onPhone.push()
    expect(await phone.books.get(copy.id)).toBeDefined()
    expect((await phone.sync.get(copy.id))?.detached).toBe(true)
    expect(server.rows.has(key)).toBe(false)
    expect(server.bundles.has(key)).toBe(false)
    // Even a repair stays on the phone.
    await repair(phone, copy.id, Date.now() + 1)
    await onPhone.push()
    await onPhone.pull()
    expect(server.bundles.has(key)).toBe(false)
  })

  it('with books off, only the reading state syncs: nothing uploaded, nothing offered', async () => {
    const laptop = device()
    const phone = device()
    const book = await alignedBook(laptop)
    await new SyncEngine(server, { db: laptop }).pull()
    const other = await alignedBook(phone, DE2, EN2)
    await saveProgress({ bookId: other.id, chapter: 0, para: 0, fraction: 0, read: 0.1, updated: 3000 }, phone)

    const onPhone = new SyncEngine(server, { db: phone, books: false })
    await onPhone.pull()
    expect(onPhone.remoteBooks).toEqual([])
    expect(server.uploads).toEqual([await bookKey(book, laptop)])
    expect(server.rows.get(await bookKey(other, phone))?.progress).toMatchObject({ read: 0.1 })

    onPhone.setBookSync(true)
    await onPhone.pull()
    expect(onPhone.remoteBooks.map((b) => b.key)).toEqual([await bookKey(book, laptop)])
    expect(server.uploads).toContain(await bookKey(other, phone))
  })

  it('started, it uploads a book on its own once its alignment finishes', async () => {
    const db = device()
    const book = await addBook({ title: 'Later', author: 'X', de: DE, en: EN }, db)
    const engine = new SyncEngine(server, { db, debounce: 10 })
    engine.start()
    await startAlignment(book.id, { db, runner: inlineRunner })
    const deadline = Date.now() + 3000
    while (server.uploads.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    engine.stop()
    expect(server.uploads).toEqual([await bookKey(book, db)])
  })
})
