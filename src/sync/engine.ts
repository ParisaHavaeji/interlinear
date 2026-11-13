/**
 * Syncing the reading state (plan.md step 36): where each book is being read and its
 * bookmarks, one row per book on the server, keyed by the book's content key so the same book
 * imported on another device finds its state. Books themselves stay on the device: they are the
 * reader's own files, large, and re-imported in a moment.
 *
 * The rule is last write wins, per book, on the whole state. Every local change stamps the
 * book's `sync` row (`store/sync.ts`); the engine pushes the rows whose stamp the server lacks,
 * a few seconds after the last change, and pulls on launch, on coming back online and when the
 * app is shown again: it reads every row's stamp (a few bytes a book), fetches the rows that are
 * newer than the state here and applies them, and pushes the books that are newer here. The
 * server refuses an update with an older stamp, so two devices pushing at once cannot lose the
 * newer state; the device whose push was refused pulls it on its next look.
 *
 * The engine knows the server only through {@link Remote}; {@link supabaseRemote} is the one
 * the app uses, and tests pass a Map.
 */

import { liveQuery } from 'dexie'
import type { BookmarkEntry } from '../bookmarks/model.ts'
import { db as sharedDb, type Book, type BookmarkRow, type InterlinearDB, type ProgressRow } from '../store/db.ts'
import { listUnsynced, markPushed } from '../store/sync.ts'
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
}

/** What the engine asks of the server. */
export interface Remote {
  /** Every row's key and stamp. */
  heads(): Promise<RemoteHead[]>
  /** The full rows of these keys. */
  fetch(keys: readonly string[]): Promise<RemoteState[]>
  /** Insert or replace a row; the server keeps the row it has when its stamp is not older. */
  upsert(row: RemoteState): Promise<void>
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
  private state: SyncState = { phase: 'idle', lastSync: null, error: null }
  private queue: Promise<unknown> = Promise.resolve()
  private subscription: { unsubscribe(): void } | null = null
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(remote: Remote, options: SyncEngineOptions = {}) {
    this.remote = remote
    this.db = options.db ?? sharedDb()
    this.debounce = options.debounce ?? DEFAULT_DEBOUNCE
    this.retryDelay = options.retryDelay ?? DEFAULT_RETRY
    this.onState = options.onState ?? (() => undefined)
  }

  get current(): SyncState {
    return this.state
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
  }

  stop(): void {
    this.stopped = true
    this.subscription?.unsubscribe()
    this.subscription = null
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

  /** Send every book whose state is newer here than the server knows. */
  push(): Promise<void> {
    return this.run(async () => {
      const rows = await listUnsynced(this.db)
      for (const row of rows) {
        const book = await this.db.books.get(row.bookId)
        if (book === undefined) {
          await this.db.sync.delete(row.bookId)
          continue
        }
        await this.pushBook(book, row.changed)
      }
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
   * ones that are newer here. Rows on the server for books not on this device are left alone,
   * for the day they are imported.
   */
  pull(): Promise<void> {
    return this.run(async () => {
      const books = await this.db.books.toArray()
      const byKey = new Map<string, Book>()
      for (const book of books) byKey.set(await bookKey(book, this.db), book)
      const syncRows = new Map((await this.db.sync.toArray()).map((r) => [r.bookId, r]))
      const heads = new Map((await this.remote.heads()).map((h) => [h.book_key, h.updated]))

      const toFetch: string[] = []
      const toPush: { book: Book; changed: number }[] = []
      for (const [key, book] of byKey) {
        const local = syncRows.get(book.id) ?? { changed: 0, pushed: 0 }
        const remote = heads.get(key) ?? -1
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
      await this.db.sync.put({ bookId: book.id, changed: state.updated, pushed: state.updated })
    })
  }
}

function stripBookId<T extends { bookId: string }>(row: T): Omit<T, 'bookId'> {
  const { bookId: _bookId, ...rest } = row
  return rest
}

/** The `reading_state` table through PostgREST, as the signed-in user. */
export function supabaseRemote(client: SupabaseClient): Remote {
  const table = 'reading_state'
  return {
    heads: () => client.rest<RemoteHead[]>(`${table}?select=book_key,updated`).then((rows) => rows ?? []),
    fetch: (keys) =>
      keys.length === 0
        ? Promise.resolve([])
        : client.rest<RemoteState[]>(`${table}?select=book_key,title,langs,progress,bookmarks,updated&book_key=in.(${keys.join(',')})`).then((rows) => rows ?? []),
    upsert: async (row) => {
      const user = client.session?.user.id
      if (user === undefined) throw new Error('Not signed in')
      await client.rest(table, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: { user_id: user, ...row },
      })
    },
  }
}
