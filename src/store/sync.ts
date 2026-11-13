/**
 * The `sync` table (plan.md step 36): one row per book that has been read or bookmarked here,
 * saying when its reading state last changed and what the server holds. Writes to progress and
 * bookmarks call {@link markChanged} in their own transaction; `sync/engine.ts` watches the rows
 * whose change is newer than their push and sends them.
 */

import { db as sharedDb, type InterlinearDB, type SyncRow } from './db.ts'

/**
 * Note that a book's progress or bookmarks changed at `at` (Unix ms). The stamp only grows: a
 * change made after a pull always counts as newer than what was pulled, even on a device whose
 * clock is behind the one that pushed it, since the server keeps the newer stamp (`schema.sql`).
 */
export async function markChanged(bookId: string, at: number, db: InterlinearDB = sharedDb()): Promise<void> {
  const row = await db.sync.get(bookId)
  if (row === undefined) await db.sync.put({ bookId, changed: at, pushed: 0 })
  else await db.sync.update(bookId, { changed: Math.max(at, row.changed + 1) })
}

/** The rows whose latest change the server does not have yet. */
export function listUnsynced(db: InterlinearDB = sharedDb()): Promise<SyncRow[]> {
  return db.sync.filter((r) => r.changed > r.pushed).toArray()
}

/** The server now holds the change `changed`; a change that came in since stays unsynced. */
export async function markPushed(bookId: string, changed: number, db: InterlinearDB = sharedDb()): Promise<void> {
  await db.sync
    .where('bookId')
    .equals(bookId)
    .modify((r) => {
      if (changed > r.pushed) r.pushed = changed
    })
}

/** Forget every push: the next account must be sent everything (on sign-out). */
export async function resetPushed(db: InterlinearDB = sharedDb()): Promise<void> {
  await db.sync.toCollection().modify({ pushed: 0 })
}
