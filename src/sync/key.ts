/**
 * A book's content key (plan.md step 36): the SHA-256 of both texts, so the reading state synced
 * from one device attaches to the same book imported again on another, whatever id, title or
 * file name it got there. Only the paragraphs' text counts: a re-import from the same files, or
 * from a bundle of them, gives the same key; a different edition gives another.
 */

import type { Lang } from '../import/types.ts'
import { getParagraphs } from '../store/books.ts'
import { db as sharedDb, type Book, type InterlinearDB } from '../store/db.ts'

/** The key of two texts, each as its paragraphs in order. */
export async function contentKey(first: readonly string[], second: readonly string[]): Promise<string> {
  const text = `${first.join('\n')}\u0000${second.join('\n')}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A book's key, computed from its paragraphs and stored on the record the first time it is asked for. */
export async function bookKey(book: Book, db: InterlinearDB = sharedDb()): Promise<string> {
  if (book.key !== undefined) return book.key
  const [a, b] = await Promise.all(book.langs.map((lang: Lang) => getParagraphs(book.id, lang, db)))
  const key = await contentKey(
    a.map((p) => p.text),
    b.map((p) => p.text),
  )
  await db.books.update(book.id, { key })
  book.key = key
  return key
}
