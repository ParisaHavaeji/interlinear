/**
 * Bookmarks in the `bookmarks` table (plan.md step 25, §1.7): one row per bookmark, the kind
 * and payload of `bookmarks/model.ts`, an empty note for now, the time it was made. A book's
 * bookmarks are few, so the Reader loads them all with one live query and finds the one a card
 * is on in memory (`findSentenceBookmark`, `findWordBookmark`); nothing is indexed beyond the
 * book. `deleteBook` in `store/books.ts` removes them with the book.
 */

import { newId } from '../store/books.ts'
import { db as sharedDb, type BookmarkRow, type InterlinearDB } from '../store/db.ts'
import type { BookmarkEntry } from './model.ts'

/** A book's bookmarks, oldest first. */
export function listBookmarks(bookId: string, db: InterlinearDB = sharedDb()): Promise<BookmarkRow[]> {
  return db.bookmarks.where('bookId').equals(bookId).sortBy('created')
}

/** Store a bookmark and return the row. */
export async function addBookmark(bookId: string, entry: BookmarkEntry, db: InterlinearDB = sharedDb()): Promise<BookmarkRow> {
  const row: BookmarkRow = { id: newId(), bookId, note: '', created: Date.now(), ...entry }
  await db.bookmarks.add(row)
  return row
}

export async function removeBookmark(id: string, db: InterlinearDB = sharedDb()): Promise<void> {
  await db.bookmarks.delete(id)
}
