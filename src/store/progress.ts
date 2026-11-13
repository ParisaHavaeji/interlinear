/** Reading progress rows (plan.md step 29): one per book, where it was last read. */

import { db as sharedDb, type InterlinearDB, type ProgressRow } from './db.ts'
import { markChanged } from './sync.ts'

/** Where a book was last read, or undefined when it has never been opened. */
export function getProgress(bookId: string, db: InterlinearDB = sharedDb()): Promise<ProgressRow | undefined> {
  return db.progress.get(bookId)
}

/** Every book's progress row. */
export function listProgress(db: InterlinearDB = sharedDb()): Promise<ProgressRow[]> {
  return db.progress.toArray()
}

/** Record where a book is being read; replaces the book's row, and notes the change for the sync (step 36). */
export function saveProgress(row: ProgressRow, db: InterlinearDB = sharedDb()): Promise<void> {
  return db.transaction('rw', [db.progress, db.sync], async () => {
    await db.progress.put(row)
    await markChanged(row.bookId, row.updated, db)
  })
}
