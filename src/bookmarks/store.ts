/**
 * Bookmarks in the `bookmarks` table (plan.md step 25, §1.7): one row per bookmark, the kind
 * and payload of `bookmarks/model.ts`, an empty note for now, the time it was made. A book's
 * bookmarks are few, so the Reader loads them all with one live query and finds the one a card
 * is on in memory (`findSentenceBookmark`, `findWordBookmark`); nothing is indexed beyond the
 * book. `deleteBook` in `store/books.ts` removes them with the book.
 */

import { newId } from '../store/books.ts'
import { db as sharedDb, type BookmarkRow, type InterlinearDB } from '../store/db.ts'
import { markChanged } from '../store/sync.ts'
import type { BookmarkEntry } from './model.ts'

/** A book's bookmarks, oldest first. */
export function listBookmarks(bookId: string, db: InterlinearDB = sharedDb()): Promise<BookmarkRow[]> {
  return db.bookmarks.where('bookId').equals(bookId).sortBy('created')
}

/** Store a bookmark and return the row. */
export async function addBookmark(bookId: string, entry: BookmarkEntry, db: InterlinearDB = sharedDb()): Promise<BookmarkRow> {
  const row: BookmarkRow = { id: newId(), bookId, note: '', created: Date.now(), ...entry }
  await db.transaction('rw', [db.bookmarks, db.sync], async () => {
    await db.bookmarks.add(row)
    await markChanged(bookId, row.created, db)
  })
  return row
}

export async function removeBookmark(id: string, db: InterlinearDB = sharedDb()): Promise<void> {
  await db.transaction('rw', [db.bookmarks, db.sync], async () => {
    const row = await db.bookmarks.get(id)
    if (row === undefined) return
    await db.bookmarks.delete(id)
    await markChanged(row.bookId, Date.now(), db)
  })
}
