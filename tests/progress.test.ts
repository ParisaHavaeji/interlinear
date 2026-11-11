// Reading progress (plan.md step 29): the share of the book read, its wording, and "Reading Now".
import { describe, expect, it } from 'vitest'
import type { ChapterMeta } from '../src/align/pipeline.ts'
import { bookFraction, chapterLabel, percentRead, progressLabel, readingNow, samePlace } from '../src/reader/progress.ts'
import type { Book, ProgressRow } from '../src/store/db.ts'

const chapter = (idx: number, paraStart: number, paraCount: number, heading: string | null = null): ChapterMeta => ({
  idx,
  heading,
  sectionIdx: null,
  paraStart,
  paraCount,
  words: 0,
})

// Paragraph lengths by position: a title page (excluded), two chapters, a colophon (excluded).
const lengths = [20, 100, 300, 100, 200, 300, 50]
const chapters = [chapter(0, 1, 3, 'I'), chapter(1, 4, 2)]

describe('bookFraction', () => {
  it('counts the text of the chapters before the place and the share of the top paragraph', () => {
    expect(bookFraction(chapters, lengths, { chapter: 0, para: 0, fraction: 0 })).toBe(0)
    expect(bookFraction(chapters, lengths, { chapter: 0, para: 1, fraction: 0 })).toBe(0.1)
    expect(bookFraction(chapters, lengths, { chapter: 0, para: 1, fraction: 0.5 })).toBe(0.25)
    expect(bookFraction(chapters, lengths, { chapter: 1, para: 0, fraction: 0 })).toBe(0.5)
    expect(bookFraction(chapters, lengths, { chapter: 1, para: 1, fraction: 0.5 })).toBe(0.85)
  })

  it('ignores paragraphs outside the chapters and reaches 1 at the end of the last one', () => {
    // The title page and the colophon are not in any chapter: the total is 1000, not 1070.
    expect(bookFraction(chapters, lengths, { chapter: 1, para: 2, fraction: 0 })).toBe(1)
    expect(bookFraction(chapters, lengths, { chapter: 1, para: 1, fraction: 1 })).toBe(1)
  })

  it('stays within 0 and 1 on odd input', () => {
    expect(bookFraction(chapters, lengths, { chapter: 0, para: 0, fraction: 7 })).toBe(0.1)
    expect(bookFraction(chapters, lengths, { chapter: 0, para: 0, fraction: -1 })).toBe(0)
    expect(bookFraction(chapters, lengths, { chapter: 5, para: 0, fraction: 0 })).toBe(1)
    expect(bookFraction([], lengths, { chapter: 0, para: 0, fraction: 0 })).toBe(0)
    expect(bookFraction(chapters, [], { chapter: 0, para: 1, fraction: 0 })).toBe(0)
  })
})

describe('progressLabel', () => {
  it('words the share for the Library', () => {
    expect(progressLabel(0)).toBe('Just started')
    expect(progressLabel(0.004)).toBe('Just started')
    expect(progressLabel(0.006)).toBe('1% read')
    expect(progressLabel(0.5)).toBe('50% read')
    expect(progressLabel(0.994)).toBe('99% read')
    expect(progressLabel(0.996)).toBe('Finished')
    expect(progressLabel(1)).toBe('Finished')
    expect(percentRead(0.333)).toBe(33)
    expect(percentRead(2)).toBe(100)
  })
})

function book(id: string, status: 'ready' | 'pending', chapters?: ChapterMeta[]): Book {
  const b: Book = {
    id,
    title: `Book ${id}`,
    author: 'A',
    langs: ['de', 'en'],
    created: 0,
    cover: { hue: 0, hue2: 0 },
    sources: {} as Book['sources'],
    alignment: { status, updated: 0 },
  }
  if (chapters !== undefined && b.alignment !== undefined) b.alignment.chapters = { de: chapters, en: [], pairs: [] }
  return b
}

const row = (bookId: string, updated: number, chapter = 0): ProgressRow => ({ bookId, chapter, para: 0, fraction: 0, read: 0.2, updated })

describe('readingNow', () => {
  it('picks the aligned book opened most recently', () => {
    const books = [book('a', 'ready'), book('b', 'ready'), book('c', 'pending')]
    const progress = new Map([row('a', 10), row('b', 20), row('c', 30)].map((r) => [r.bookId, r]))
    expect(readingNow(books, progress)?.book.id).toBe('b')
  })

  it('is null without an opened, aligned book', () => {
    expect(readingNow([book('a', 'ready')], new Map())).toBeNull()
    expect(readingNow([book('c', 'pending')], new Map([['c', row('c', 1)]]))).toBeNull()
    // A row whose book is gone counts for nothing.
    expect(readingNow([], new Map([['x', row('x', 1)]]))).toBeNull()
  })
})

describe('chapterLabel', () => {
  it('names the chapter under the title, or nothing for a one-chapter book', () => {
    const b = book('a', 'ready', [chapter(0, 0, 3, 'Erstes Kapitel'), chapter(1, 3, 3)])
    expect(chapterLabel(b, 0)).toBe('Erstes Kapitel')
    expect(chapterLabel(b, 1)).toBe('Chapter 2')
    expect(chapterLabel(b, 9)).toBe('Chapter 10')
    expect(chapterLabel(book('b', 'ready', [chapter(0, 0, 3, 'Only')]), 0)).toBeNull()
    expect(chapterLabel(book('c', 'pending'), 0)).toBeNull()
  })
})

describe('samePlace', () => {
  it('compares places to a thousandth of a paragraph', () => {
    expect(samePlace({ chapter: 1, para: 2, fraction: 0.5 }, { chapter: 1, para: 2, fraction: 0.5004 })).toBe(true)
    expect(samePlace({ chapter: 1, para: 2, fraction: 0.5 }, { chapter: 1, para: 2, fraction: 0.502 })).toBe(false)
    expect(samePlace({ chapter: 1, para: 2, fraction: 0.5 }, { chapter: 1, para: 3, fraction: 0.5 })).toBe(false)
    expect(samePlace(null, null)).toBe(true)
    expect(samePlace(null, { chapter: 0, para: 0, fraction: 0 })).toBe(false)
  })
})
