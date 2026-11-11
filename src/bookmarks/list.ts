/**
 * The bookmarks screen's model (plan.md step 26, §1.7), kept apart from the DOM so it can be
 * tested: the rows grouped by book and ordered, what a search matches, and the labels a row
 * carries (the headword of a word bookmark, the date a bookmark was made).
 *
 * Within a book the bookmarks are listed in reading order, as Books lists them, so the screen
 * doubles as a trail through the text; the books themselves come in order of their newest
 * bookmark, so the one being read is on top. A search matches every word of the query against
 * everything the row shows (both texts, the headword and its glosses, the chapter heading) and
 * the book's title and author, ignoring case and accents and treating ß as ss, so "strasse"
 * finds "Straße".
 */

import type { Article } from '../reader/word.ts'
import type { Book, BookmarkRow } from '../store/db.ts'
import type { WordBookmark } from './model.ts'

export interface BookmarkGroup {
  book: Book
  /** The book's bookmarks in reading order. */
  rows: BookmarkRow[]
  /** `created` of the newest row; what the groups are ordered by. */
  latest: number
}

/** Where a bookmark sits in its book: the first sentence it covers, and the word's offset within it. */
export function positionOf(row: BookmarkRow): [number, number] {
  if (row.type === 'word') return [row.payload.word.sentence, row.payload.word.offset]
  const first = row.payload.sentences[0]
  return [first === undefined ? Number.MAX_SAFE_INTEGER : first, -1]
}

function byPosition(a: BookmarkRow, b: BookmarkRow): number {
  const [sa, oa] = positionOf(a)
  const [sb, ob] = positionOf(b)
  return sa - sb || oa - ob || a.created - b.created
}

/**
 * The rows grouped by book: each book that has bookmarks, newest bookmark first, its rows in
 * reading order. Rows of a book that is no longer in the library are left out.
 */
export function groupBookmarks(rows: readonly BookmarkRow[], books: readonly Book[]): BookmarkGroup[] {
  const byBook = new Map<string, BookmarkRow[]>()
  for (const row of rows) {
    const list = byBook.get(row.bookId)
    if (list === undefined) byBook.set(row.bookId, [row])
    else list.push(row)
  }
  const groups: BookmarkGroup[] = []
  for (const book of books) {
    const list = byBook.get(book.id)
    if (list === undefined || list.length === 0) continue
    groups.push({ book, rows: [...list].sort(byPosition), latest: Math.max(...list.map((r) => r.created)) })
  }
  return groups.sort((a, b) => b.latest - a.latest)
}

// ---------------------------------------------------------------------------------------------
// Search

/** Text as the search compares it: lower case, no accents, ß as ss, one space between words. */
export function searchKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The words of a query, each as `searchKey` makes it; empty for a blank query. */
export function searchTerms(query: string): string[] {
  const key = searchKey(query)
  return key === '' ? [] : key.split(' ')
}

/** Everything a row shows, as one searchable string. */
export function searchText(row: BookmarkRow, book?: Pick<Book, 'title' | 'author'>): string {
  const parts: string[] = []
  if (row.type === 'sentence') parts.push(row.payload.text, row.payload.translationText, row.payload.heading)
  else {
    const p = row.payload
    parts.push(p.word.token, p.lemma ?? '', p.sentenceText, p.translationText, p.heading)
    for (const e of p.entries) parts.push(e.lemma, e.plural ?? '', ...e.glosses)
  }
  if (book !== undefined) parts.push(book.title, book.author)
  return searchKey(parts.filter((s) => s !== '').join(' '))
}

/** Whether a row matches every term of a search. */
export function matchesSearch(row: BookmarkRow, terms: readonly string[], book?: Pick<Book, 'title' | 'author'>): boolean {
  if (terms.length === 0) return true
  const text = searchText(row, book)
  return terms.every((t) => text.includes(t))
}

/** The groups with only the rows that match `query`; groups left empty are dropped. */
export function filterGroups(groups: readonly BookmarkGroup[], query: string): BookmarkGroup[] {
  const terms = searchTerms(query)
  if (terms.length === 0) return [...groups]
  const out: BookmarkGroup[] = []
  for (const g of groups) {
    const rows = g.rows.filter((r) => matchesSearch(r, terms, g.book))
    if (rows.length > 0) out.push({ ...g, rows })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Labels

/** The headword line of a word bookmark: its first article, if any, and the lemma (the word as printed when the dictionary had nothing). */
export function wordHeadline(payload: WordBookmark): { article: Article | null; lemma: string } {
  const entry = payload.entries[0]
  return { article: entry?.articles[0] ?? null, lemma: payload.lemma ?? payload.word.token }
}

/** The glosses of a word bookmark's first entry, in one line; empty when the dictionary had nothing. */
export function wordGloss(payload: WordBookmark): string {
  return payload.entries[0]?.glosses.join('; ') ?? ''
}

const DAY = 24 * 60 * 60 * 1000

/** When a bookmark was made, as the row shows it: "Today", "Yesterday", else the date, with the year once it is not this year's. */
export function dateLabel(created: number, now: number): string {
  const day = (t: number) => Math.floor((t - new Date(t).getTimezoneOffset() * 60 * 1000) / DAY)
  const days = day(now) - day(created)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const sameYear = new Date(created).getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat('en-GB', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }).format(created)
}

/** "1 bookmark", "12 bookmarks". */
export function countLabel(n: number): string {
  return n === 1 ? '1 bookmark' : `${n} bookmarks`
}
