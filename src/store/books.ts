/** Book-level operations over the Dexie store: add, list, delete, read paragraphs. */

import type { ImportedText } from '../import/file.ts'
import type { Lang } from '../import/types.ts'
import { coverColours } from '../ui/cover.ts'
import { db as sharedDb, type Book, type InterlinearDB, type ParagraphRow, type SourceInfo } from './db.ts'

export interface NewBook {
  title: string
  author: string
  de: ImportedText
  en: ImportedText
}

/** Random, URL-safe id. `crypto.randomUUID` needs a secure context; fall back for plain http. */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function sourceInfo(text: ImportedText): SourceInfo {
  const info: SourceInfo = {
    fileName: text.fileName,
    format: text.format,
    paragraphs: text.paragraphs.length,
    words: text.words,
    sections: text.sections,
  }
  if (text.layout !== undefined) info.layout = text.layout
  return info
}

function rows(bookId: string, lang: Lang, text: ImportedText): ParagraphRow[] {
  return text.paragraphs.map((p) =>
    p.cls === undefined ? { bookId, lang, idx: p.idx, text: p.text } : { bookId, lang, idx: p.idx, text: p.text, cls: p.cls },
  )
}

/**
 * Persist a book and both languages' paragraphs in one transaction. Title falls back to the
 * German file name; author to "Unknown author". Returns the stored record.
 */
export async function addBook(input: NewBook, db: InterlinearDB = sharedDb()): Promise<Book> {
  const title = input.title.trim() || stripExtension(input.de.fileName) || 'Untitled'
  const author = input.author.trim() || 'Unknown author'
  const book: Book = {
    id: newId(),
    title,
    author,
    langs: ['de', 'en'],
    created: Date.now(),
    cover: coverColours(title),
    sources: { de: sourceInfo(input.de), en: sourceInfo(input.en) },
    alignment: { status: 'pending', updated: Date.now() },
  }
  await db.transaction('rw', [db.books, db.paragraphs], async () => {
    await db.books.add(book)
    await db.paragraphs.bulkAdd(rows(book.id, 'de', input.de))
    await db.paragraphs.bulkAdd(rows(book.id, 'en', input.en))
  })
  return book
}

/** All books, newest first. */
export function listBooks(db: InterlinearDB = sharedDb()): Promise<Book[]> {
  return db.books.orderBy('created').reverse().toArray()
}

/** Remove a book and every row that hangs off it. */
export async function deleteBook(id: string, db: InterlinearDB = sharedDb()): Promise<void> {
  await db.transaction('rw', [db.books, db.paragraphs, db.sentences, db.beads, db.bookmarks, db.progress], async () => {
    await db.books.delete(id)
    await db.paragraphs.where('bookId').equals(id).delete()
    await db.sentences.where('bookId').equals(id).delete()
    await db.beads.where('bookId').equals(id).delete()
    await db.bookmarks.where('bookId').equals(id).delete()
    await db.progress.delete(id)
  })
}

/** One language's paragraphs of a book, in reading order. */
export function getParagraphs(bookId: string, lang: Lang, db: InterlinearDB = sharedDb()): Promise<ParagraphRow[]> {
  return db.paragraphs.where('[bookId+lang]').equals([bookId, lang]).sortBy('idx')
}

function stripExtension(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '').trim()
}
