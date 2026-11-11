/** Reading progress rows (plan.md step 29): one per book, where it was last read. */

import { db as sharedDb, type InterlinearDB, type ProgressRow } from './db.ts'

/** Where a book was last read, or undefined when it has never been opened. */
export function getProgress(bookId: string, db: InterlinearDB = sharedDb()): Promise<ProgressRow | undefined> {
  return db.progress.get(bookId)
}

/** Every book's progress row. */
export function listProgress(db: InterlinearDB = sharedDb()): Promise<ProgressRow[]> {
  return db.progress.toArray()
}

/** Record where a book is being read; replaces the book's row. */
export function saveProgress(row: ProgressRow, db: InterlinearDB = sharedDb()): Promise<void> {
  return db.progress.put(row).then(() => undefined)
}
