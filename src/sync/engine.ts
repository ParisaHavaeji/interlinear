/**
 * Syncing the reading state (plan.md step 36): where each book is being read and its
 * bookmarks, one row per book on the server, keyed by the book's content key so the same book
 * imported on another device finds its state.
 *
 * The rule is last write wins, per book, on the whole state. Every local change stamps the
 * book's `sync` row (`store/sync.ts`); the engine pushes the rows whose stamp the server lacks,
 * a few seconds after the last change, and pulls on launch, on coming back online and when the
 * app is shown again: it reads every row's stamp (a few bytes a book), fetches the rows that are
 * newer than the state here and applies them, and pushes the books that are newer here. The
 * server refuses an update with an older stamp, so two devices pushing at once cannot lose the
 * newer state; the device whose push was refused pulls it on its next look.
 *
 * Step 37 adds the books themselves, unless the reader turned "Sync books" off. A book whose
 * alignment is `ready` travels as its gzipped bundle (`store/bundle.ts`) to the account, with
 * its size and alignment stamp on its `reading_state` row, so the same pull that reads the
 * stamps learns which books the account holds and whether a copy here is out of date. A book is
 * uploaded when the account has no copy or an older one (a repair or chapter edit moved its
 * stamp), its alignment is replaced from the account when the account's copy is newer, and the
 * account's books that are not here are listed for the Library to offer. Downloads happen only
 * when asked: a phone on cellular should not pull a library it did not ask for. A book the
 * account held from here and no longer holds was deleted everywhere from another device; the
 * copy here stays, kept on this device alone.
 *
 * The engine knows the server only through {@link Remote}; {@link supabaseRemote} is the one
 * the app uses, and tests pass a Map.
 */

import { liveQuery } from 'dexie'
import type { BookmarkEntry } from '../bookmarks/model.ts'
import { BUNDLE_SUFFIX, exportBundle, gunzipBundle, gzipBundle, importBundle, replaceAlignment } from '../store/bundle.ts'
import { db as sharedDb, type Book, type BookmarkRow, type InterlinearDB, type ProgressRow, type SyncRow } from '../store/db.ts'
import { listUnsynced, markBundled, markDetached, markPushed } from '../store/sync.ts'
import { bookKey } from './key.ts'
import type { SupabaseClient } from './supabase.ts'

/** A book's reading state as the server holds it; the columns of `reading_state`. */
export interface RemoteState {
  book_key: string
  title: string
  langs: string[]
  progress: Omit<ProgressRow, 'bookId'> | null
  bookmarks: RemoteBookmark[]
  /** The local change stamp of the device that pushed it (Unix ms). */
  updated: number
}

export type RemoteBookmark = Omit<BookmarkRow, 'bookId'>

export interface RemoteHead {
  book_key: string
  updated: number
  title?: string
  /** Step 37: the gzipped bundle's size in bytes and its alignment stamp; null without one. */
  bundle_size?: number | null
  bundle_at?: number | null
}

/** What an upload records about the book on its row (step 37). */
export interface BundleMeta {
  title: string
  langs: string[]
  /** Bytes of the gzipped bundle. */
  size: number
  /** The bundled book's `alignment.updated`. */
  at: number
}

/** A book the account holds that is not on this device (step 37). */
export interface RemoteBook {
  key: string
  title: string
  /** Bytes to download. */
  size: number
  at: number
}

/** What the engine asks of the server. */
export interface Remote {
  /** Every row's key and stamps. */
  heads(): Promise<RemoteHead[]>
  /** The full rows of these keys. */
  fetch(keys: readonly string[]): Promise<RemoteState[]>
  /** Insert or replace a row; the server keeps the row it has when its stamp is not older. */
  upsert(row: RemoteState): Promise<void>
  /** Store a book's gzipped bundle and note it on the book's row, creating the row if needed. */
  upload(key: string, bytes: Uint8Array<ArrayBuffer>, meta: BundleMeta): Promise<void>
  /** The gzipped bundle of a book. */
  download(key: string): Promise<Uint8Array<ArrayBuffer>>
  /** Delete a book from the account: its bundle and its row. */
  remove(key: string): Promise<void>
}

export interface SyncState {
  phase: 'idle' | 'syncing' | 'error'
  /** Unix ms of the last sync that went through, null for none yet. */
  lastSync: number | null
  error: string | null
}

export interface SyncEngineOptions {
  db?: InterlinearDB
  /** Milliseconds between the last local change and its push. */
  debounce?: number
  /** Milliseconds before a failed push is tried again while the app stays open. */
  retryDelay?: number
  onState?: (state: SyncState) => void
  /** Sync the books themselves (step 37); off, only the reading state syncs. Default on. */
  books?: boolean
  /** Called with the account's books that are not here, after every pull and download. */
  onRemoteBooks?: (books: RemoteBook[]) => void
}

const DEFAULT_DEBOUNCE = 2500
const DEFAULT_RETRY = 30_000

/** Keys per request when fetching rows. */
const FETCH_CHUNK = 40

function progressOf(book: Book, state: RemoteState['progress']): ProgressRow | null {
  if (state === null || typeof state !== 'object') return null
  const { chapter, para, fraction, read, updated } = state
  if (![chapter, para, fraction, read, updated].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  return { bookId: book.id, chapter, para, fraction, read, updated }
}

function bookmarkOf(book: Book, b: RemoteBookmark): BookmarkRow | null {
  if (typeof b !== 'object' || b === null) return null
  if (typeof b.id !== 'string' || typeof b.created !== 'number' || typeof b.payload !== 'object' || b.payload === null) return null
  if (b.type !== 'sentence' && b.type !== 'word') return null
  const entry = { type: b.type, payload: b.payload } as BookmarkEntry
  return { id: b.id, bookId: book.id, note: typeof b.note === 'string' ? b.note : '', created: b.created, ...entry }
}

export class SyncEngine {
  private readonly remote: Remote
  private readonly db: InterlinearDB
  private readonly debounce: number
  private readonly retryDelay: number
  private readonly onState: (state: SyncState) => void
  private readonly onRemoteBooks: (books: RemoteBook[]) => void
  private bookSync: boolean
  private remoteList: RemoteBook[] = []
  private state: SyncState = { phase: 'idle', lastSync: null, error: null }
  private queue: Promise<unknown> = Promise.resolve()
  private subscription: { unsubscribe(): void } | null = null
  private bookSubscription: { unsubscribe(): void } | null = null
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(remote: Remote, options: SyncEngineOptions = {}) {
    this.remote = remote
    this.db = options.db ?? sharedDb()
    this.debounce = options.debounce ?? DEFAULT_DEBOUNCE
    this.retryDelay = options.retryDelay ?? DEFAULT_RETRY
    this.onState = options.onState ?? (() => undefined)
    this.onRemoteBooks = options.onRemoteBooks ?? (() => undefined)
    this.bookSync = options.books ?? true
  }

  get current(): SyncState {
    return this.state
  }

  /** The account's books that are not on this device, as of the last pull. */
  get remoteBooks(): readonly RemoteBook[] {
    return this.remoteList
  }

  /** Whether the books themselves sync (step 37). */
  get syncsBooks(): boolean {
    return this.bookSync
  }

  /** Turn the syncing of books on or off. Off, the account's books are no longer offered; on, the next pull catches up. */
  setBookSync(on: boolean): void {
    if (on === this.bookSync) return
    this.bookSync = on
    if (!on) this.setRemoteBooks([])
    if (this.subscription !== null) this.watchBooks()
  }

  private setRemoteBooks(books: RemoteBook[]): void {
    this.remoteList = books
    this.onRemoteBooks(books)
  }

  private setState(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch }
    this.onState(this.state)
  }

  /** Watch for local changes and push them after a pause. */
  start(): void {
    if (this.subscription !== null) return
    this.stopped = false
    this.subscription = liveQuery(() => listUnsynced(this.db)).subscribe({
      next: (rows) => {
        if (rows.length > 0) this.schedulePush()
      },
      error: (err: unknown) => console.error('sync: could not watch the changes', err),
    })
    this.watchBooks()
  }

  /** Push when a book becomes ready to upload: newly aligned, or its alignment changed (step 37). */
  private watchBooks(): void {
    this.bookSubscription?.unsubscribe()
    this.bookSubscription = null
    if (!this.bookSync) return
    this.bookSubscription = liveQuery(() => this.pendingUploads()).subscribe({
      next: (books) => {
        if (books.length > 0) this.schedulePush()
      },
      error: (err: unknown) => console.error('sync: could not watch the books', err),
    })
  }

  /** Ready books whose alignment changed since the account last got them from or gave them to this device. */
  private async pendingUploads(): Promise<Book[]> {
    const [books, rows] = await Promise.all([this.db.books.toArray(), this.db.sync.toArray()])
    const byId = new Map(rows.map((r) => [r.bookId, r]))
    return books.filter((b) => {
      const row = byId.get(b.id)
      return b.alignment?.status === 'ready' && row?.detached !== true && b.alignment.updated > (row?.bundled ?? 0)
    })
  }

  stop(): void {
    this.stopped = true
    this.subscription?.unsubscribe()
    this.subscription = null
    this.bookSubscription?.unsubscribe()
    this.bookSubscription = null
    if (this.pushTimer !== null) clearTimeout(this.pushTimer)
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.pushTimer = null
    this.retryTimer = null
  }

  private schedulePush(): void {
    if (this.pushTimer !== null || this.stopped) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      void this.push()
    }, this.debounce)
  }

  /** One operation at a time; a failure is reported in the state and does not reject. */
  private run(work: () => Promise<void>): Promise<void> {
    const job = this.queue.then(async () => {
      if (this.stopped) return
      this.setState({ phase: 'syncing', error: null })
      try {
        await work()
        this.setState({ phase: 'idle', lastSync: Date.now(), error: null })
      } catch (err) {
        console.warn('sync failed', err)
        this.setState({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
        if (this.retryTimer === null && !this.stopped) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null
            void this.push()
          }, this.retryDelay)
        }
      }
    })
    this.queue = job
    return job
  }

  /** In the same line as {@link run}, but the caller gets the result or the error. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const job = this.queue.then(work)
    this.queue = job.catch(() => undefined)
    return job
  }

  /** Send every book whose state is newer here than the server knows, then the books aligned here since the last look. */
  push(): Promise<void> {
    return this.run(async () => {
      const rows = await listUnsynced(this.db)
      for (const row of rows) {
        const book = await this.db.books.get(row.bookId)
        if (book === undefined) {
          await this.db.sync.delete(row.bookId)
          continue
        }
        if (row.detached === true) {
          await markPushed(book.id, row.changed, this.db)
          continue
        }
        await this.pushBook(book, row.changed)
      }
      if (!this.bookSync) return
      const pending = await this.pendingUploads()
      if (pending.length === 0) return
      const byKey = new Map<string, Book>()
      for (const book of pending) byKey.set(await bookKey(book, this.db), book)
      const heads = new Map((await this.remote.heads()).map((h) => [h.book_key, h]))
      await this.syncBundles(byKey, heads)
    })
  }

  private async pushBook(book: Book, changed: number): Promise<void> {
    const key = await bookKey(book, this.db)
    const [progress, bookmarks] = await Promise.all([
      this.db.progress.get(book.id),
      this.db.bookmarks.where('bookId').equals(book.id).sortBy('created'),
    ])
    await this.remote.upsert({
      book_key: key,
      title: book.title,
      langs: [...book.langs],
      progress: progress === undefined ? null : stripBookId(progress),
      bookmarks: bookmarks.map(stripBookId),
      updated: changed,
    })
    await markPushed(book.id, changed, this.db)
  }

  /**
   * Compare every local book with the server: apply the states that are newer there, push the
   * ones that are newer here; then the books themselves (step 37), and the list of the
   * account's books not here. With books not syncing, rows on the server for books not on this
   * device are left alone, for the day they are imported.
   */
  pull(): Promise<void> {
    return this.run(async () => {
      const books = await this.db.books.toArray()
      const byKey = new Map<string, Book>()
      for (const book of books) byKey.set(await bookKey(book, this.db), book)
      const headList = await this.remote.heads()
      const heads = new Map(headList.map((h) => [h.book_key, h]))
      if (this.bookSync) await this.detachDeleted(byKey, heads)
      const syncRows = new Map((await this.db.sync.toArray()).map((r) => [r.bookId, r]))

      const toFetch: string[] = []
      const toPush: { book: Book; changed: number }[] = []
      for (const [key, book] of byKey) {
        const local: SyncRow = syncRows.get(book.id) ?? { bookId: book.id, changed: 0, pushed: 0 }
        if (local.detached === true) continue
        const remote = heads.get(key)?.updated ?? -1
        if (remote > local.changed) toFetch.push(key)
        else if (local.changed > 0 && (local.changed > local.pushed || local.changed > remote)) toPush.push({ book, changed: local.changed })
      }

      for (let i = 0; i < toFetch.length; i += FETCH_CHUNK) {
        const states = await this.remote.fetch(toFetch.slice(i, i + FETCH_CHUNK))
        for (const state of states) {
          const book = byKey.get(state.book_key)
          if (book !== undefined) await this.apply(book, state)
        }
      }
      for (const { book, changed } of toPush) await this.pushBook(book, changed)

      if (!this.bookSync) return
      await this.syncBundles(byKey, heads)
      this.setRemoteBooks(
        headList
          .filter((h) => typeof h.bundle_at === 'number' && !byKey.has(h.book_key))
          .map((h) => ({ key: h.book_key, title: h.title ?? '', size: h.bundle_size ?? 0, at: h.bundle_at as number }))
          .sort((a, b) => a.title.localeCompare(b.title)),
      )
    })
  }

  /**
   * Books the account held from here and holds no more were deleted everywhere from another
   * device: keep them here alone, so neither their state nor the book goes back up.
   */
  private async detachDeleted(byKey: ReadonlyMap<string, Book>, heads: ReadonlyMap<string, RemoteHead>): Promise<void> {
    for (const [key, book] of byKey) {
      const row = await this.db.sync.get(book.id)
      if (row === undefined || row.detached === true || (row.bundled ?? 0) <= 0) continue
      if (typeof heads.get(key)?.bundle_at !== 'number') await markDetached(book.id, this.db)
    }
  }

  /**
   * Bring each ready book and the account's copy of it together by alignment stamp: upload when
   * the account has none or an older one, take the account's alignment when it is newer.
   */
  private async syncBundles(byKey: ReadonlyMap<string, Book>, heads: ReadonlyMap<string, RemoteHead>): Promise<void> {
    for (const [key, listed] of byKey) {
      const [book, row] = await Promise.all([this.db.books.get(listed.id), this.db.sync.get(listed.id)])
      if (book === undefined || row?.detached === true) continue
      const alignment = book.alignment
      if (alignment?.status !== 'ready') continue
      const at = heads.get(key)?.bundle_at
      if (typeof at !== 'number' || alignment.updated > at) await this.uploadBook(book, key)
      else if (at > alignment.updated) await this.takeAlignment(book, key)
      else if (row?.bundled !== at) await markBundled(book.id, at, this.db)
    }
  }

  private async uploadBook(book: Book, key: string): Promise<void> {
    const bundle = await exportBundle(book.id, this.db)
    const alignment = bundle.book.alignment
    if (alignment?.status !== 'ready') return
    const bytes = await gzipBundle(bundle)
    await this.remote.upload(key, bytes, { title: book.title, langs: [...book.langs], size: bytes.length, at: alignment.updated })
    await markBundled(book.id, alignment.updated, this.db)
  }

  /** Replace a book's alignment with the account's newer one (a repair made on another device). */
  private async takeAlignment(book: Book, key: string): Promise<void> {
    const bundle = await gunzipBundle(await this.remote.download(key))
    await replaceAlignment(book.id, bundle, this.db)
    await markBundled(book.id, bundle.book.alignment!.updated, this.db)
  }

  /**
   * Download a book of the account onto this device (step 37), with its reading state, and
   * return it. A book already here is returned as it is. Rejects on failure.
   */
  download(key: string): Promise<Book> {
    return this.serial(async () => {
      for (const book of await this.db.books.toArray()) if ((await bookKey(book, this.db)) === key) return book
      const bundle = await gunzipBundle(await this.remote.download(key))
      const book = await importBundle(bundle, { synced: { key } }, this.db)
      if (book.alignment?.status === 'ready') await markBundled(book.id, book.alignment.updated, this.db)
      const [state] = await this.remote.fetch([key])
      if (state !== undefined && state.updated > 0) await this.apply(book, state)
      this.setRemoteBooks(this.remoteList.filter((b) => b.key !== key))
      return book
    })
  }

  /**
   * Delete a book from the account (step 37's "Delete everywhere"): its bundle and its reading
   * state. The copy on this device is the caller's to delete. Rejects on failure.
   */
  removeFromAccount(bookId: string): Promise<void> {
    return this.serial(async () => {
      const book = await this.db.books.get(bookId)
      if (book === undefined) return
      await this.remote.remove(await bookKey(book, this.db))
    })
  }

  /** Replace a book's progress and bookmarks with the server's, and record that both agree. */
  private async apply(book: Book, state: RemoteState): Promise<void> {
    const progress = progressOf(book, state.progress)
    const bookmarks = (Array.isArray(state.bookmarks) ? state.bookmarks : []).map((b) => bookmarkOf(book, b)).filter((b) => b !== null)
    await this.db.transaction('rw', [this.db.progress, this.db.bookmarks, this.db.sync], async () => {
      await this.db.bookmarks.where('bookId').equals(book.id).delete()
      if (bookmarks.length > 0) await this.db.bookmarks.bulkAdd(bookmarks)
      if (progress === null) await this.db.progress.delete(book.id)
      else await this.db.progress.put(progress)
      const row = await this.db.sync.get(book.id)
      await this.db.sync.put({ ...row, bookId: book.id, changed: state.updated, pushed: state.updated })
    })
  }
}

function stripBookId<T extends { bookId: string }>(row: T): Omit<T, 'bookId'> {
  const { bookId: _bookId, ...rest } = row
  return rest
}

/** The Storage bucket of the books (step 37, `supabase/schema.sql`). */
export const BOOKS_BUCKET = 'books'

/** Where a user's copy of a book lives in {@link BOOKS_BUCKET}: under their id, by content key. */
export function bundlePath(userId: string, key: string): string {
  return `${userId}/${key}${BUNDLE_SUFFIX}.gz`
}

/** The `reading_state` table through PostgREST and the `books` bucket, as the signed-in user. */
export function supabaseRemote(client: SupabaseClient): Remote {
  const table = 'reading_state'
  const userId = (): string => {
    const user = client.session?.user.id
    if (user === undefined) throw new Error('Not signed in')
    return user
  }
  return {
    heads: () => client.rest<RemoteHead[]>(`${table}?select=book_key,updated,title,bundle_size,bundle_at`).then((rows) => rows ?? []),
    fetch: (keys) =>
      keys.length === 0
        ? Promise.resolve([])
        : client.rest<RemoteState[]>(`${table}?select=book_key,title,langs,progress,bookmarks,updated&book_key=in.(${keys.join(',')})`).then((rows) => rows ?? []),
    upsert: async (row) => {
      await client.rest(table, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: { user_id: userId(), ...row },
      })
    },
    upload: async (key, bytes, meta) => {
      const user = userId()
      await client.upload(BOOKS_BUCKET, bundlePath(user, key), bytes, 'application/gzip')
      // `updated` 0 never replaces a reading state (the trigger keeps the newer one), and makes
      // the row of a book not read yet. Only the columns sent are written on a conflict.
      await client.rest(table, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: { user_id: user, book_key: key, title: meta.title, langs: meta.langs, updated: 0, bundle_size: meta.size, bundle_at: meta.at },
      })
    },
    download: (key) => client.download(BOOKS_BUCKET, bundlePath(userId(), key)),
    remove: async (key) => {
      await client.remove(BOOKS_BUCKET, bundlePath(userId(), key))
      await client.rest(`${table}?book_key=eq.${key}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } })
    },
  }
}
