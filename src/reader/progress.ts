/**
 * Reading progress (plan.md step 29), kept apart from the DOM so it can be tested: how far into
 * the book a place is, what the Library says about it, and which book is "Reading Now". The
 * place itself is what the Reader's windowed body knows: the chapter, the paragraph at the top
 * of the viewport (by position within the chapter) and how far into that paragraph the viewport
 * starts. It is stored as a `ProgressRow` and restored when the book is opened again.
 */

import type { ChapterMeta } from '../align/pipeline.ts'
import type { Book, ProgressRow } from '../store/db.ts'

/** A place in the book as the Reader sees it. */
export interface ReadingPlace {
  /** 0-based chapter position. */
  chapter: number
  /** Position within the chapter of the paragraph at the top of the viewport; `paraCount` once the chapter's end is on screen. */
  para: number
  /** How far into that paragraph the viewport starts, 0–1. */
  fraction: number
}

/** A read share this close to the end counts as finished. */
const FINISHED = 0.995

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0
}

/**
 * The share of the book's text before `place`, 0–1: the characters of the chapters before it, of
 * the paragraphs of its chapter above the one at the top of the viewport, and that paragraph's
 * share, over the characters of every chapter. `lengths` are the paragraphs' text lengths by
 * position in the book. Paragraphs outside the chapters (excluded front and back matter) are not
 * counted, so a book opens at 0 and reaches 1 at the end of its last chapter.
 */
export function bookFraction(chapters: readonly ChapterMeta[], lengths: readonly number[], place: ReadingPlace): number {
  let total = 0
  let before = 0
  chapters.forEach((c, i) => {
    for (let p = c.paraStart; p < c.paraStart + c.paraCount; p++) {
      const len = lengths[p] ?? 0
      total += len
      if (i < place.chapter) before += len
      else if (i === place.chapter) {
        const pos = p - c.paraStart
        if (pos < place.para) before += len
        else if (pos === place.para) before += len * clamp01(place.fraction)
      }
    }
  })
  return total > 0 ? clamp01(before / total) : 0
}

/** The percentage the Library shows, 0–100. */
export function percentRead(read: number): number {
  return Math.round(clamp01(read) * 100)
}

/** The Library's wording for a read share: "Just started", "n% read", "Finished". */
export function progressLabel(read: number): string {
  if (read >= FINISHED) return 'Finished'
  const percent = percentRead(read)
  if (percent < 1) return 'Just started'
  return `${percent}% read`
}

/** The chapters of the shown language, as the Reader pages through them; empty while the book is not aligned. */
export function chaptersOf(book: Book): readonly ChapterMeta[] {
  const chapters = book.alignment?.status === 'ready' ? book.alignment.chapters?.[book.langs[0]] : undefined
  return chapters ?? []
}

/**
 * What to call the chapter a book is open at, under its title on the "Reading Now" card: the
 * heading, "Chapter n" without one, nothing for a book that is one chapter.
 */
export function chapterLabel(book: Book, chapter: number): string | null {
  const chapters = chaptersOf(book)
  if (chapters.length <= 1) return null
  const c = chapters[Math.min(Math.max(0, chapter), chapters.length - 1)]
  return c.heading ?? `Chapter ${chapter + 1}`
}

export interface ReadingNow {
  book: Book
  progress: ProgressRow
}

/**
 * The book to show as "Reading Now": the aligned book opened most recently, or null when no
 * aligned book has been opened yet. A finished book stays until another is opened.
 */
export function readingNow(books: readonly Book[], progress: ReadonlyMap<string, ProgressRow>): ReadingNow | null {
  let best: ReadingNow | null = null
  for (const book of books) {
    if (book.alignment?.status !== 'ready') continue
    const row = progress.get(book.id)
    if (row === undefined) continue
    if (best === null || row.updated > best.progress.updated) best = { book, progress: row }
  }
  return best
}

/** Two places that would store the same row, so a scroll that settled where it was is not saved again. */
export function samePlace(a: ReadingPlace | null, b: ReadingPlace | null): boolean {
  if (a === null || b === null) return a === b
  return a.chapter === b.chapter && a.para === b.para && Math.round(a.fraction * 1000) === Math.round(b.fraction * 1000)
}
