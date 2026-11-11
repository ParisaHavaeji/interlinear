/**
 * Bookmark export (plan.md step 27, §1.7), kept apart from the DOM so it can be tested: the
 * three files the bookmarks screen can hand out, built from the grouped rows it shows.
 *
 * - JSON, full fidelity: every row as stored, under its book's id, title, author and languages,
 *   with a format name and version, so a later step can import it back (the book bundle of
 *   step 14 keeps a book's id across devices for this reason).
 * - Markdown, to read: a heading per book, a sub-heading per chapter, the German in bold over
 *   its translation; a word as its headword with the glosses, then the sentence it came from.
 * - Anki, as tab-separated text: one note per bookmark, `German<TAB>English`. A sentence is the
 *   sentence and its translation; a word is "der Rücken" against its glosses with the sentence
 *   and translation beneath. Anki's file header turns on HTML so the line breaks hold, and a
 *   field holding a quote is quoted CSV-style, which Anki's reader unwraps.
 */

import type { Book, BookmarkRow } from '../store/db.ts'
import { titleSlug } from '../store/bundle.ts'
import type { BookmarkGroup } from './list.ts'
import type { WordBookmark } from './model.ts'

export const BOOKMARKS_FORMAT = 'interlinear-bookmarks'
export const BOOKMARKS_VERSION = 1

export type ExportFormat = 'json' | 'markdown' | 'anki'

export interface ExportFormatInfo {
  key: ExportFormat
  label: string
  detail: string
  extension: string
  /** MIME type of the file. */
  type: string
}

export const EXPORT_FORMATS: readonly ExportFormatInfo[] = [
  { key: 'json', label: 'JSON', detail: 'Everything, for keeping or importing again', extension: 'json', type: 'application/json' },
  { key: 'markdown', label: 'Markdown', detail: 'A readable list, by book and chapter', extension: 'md', type: 'text/markdown' },
  { key: 'anki', label: 'Anki', detail: 'Tab-separated notes: German, English', extension: 'tsv', type: 'text/tab-separated-values' },
]

export interface ExportFile {
  name: string
  type: string
  text: string
}

/** The file for `format` from the groups shown; `book` names the file after one book when the screen shows only it. */
export function exportBookmarks(groups: readonly BookmarkGroup[], format: ExportFormat, now: number, book?: Pick<Book, 'title'>): ExportFile {
  const info = EXPORT_FORMATS.find((f) => f.key === format)!
  const text = format === 'json' ? bookmarksJson(groups, now) : format === 'markdown' ? bookmarksMarkdown(groups, now) : bookmarksTsv(groups)
  return { name: exportFileName(format, book), type: info.type, text }
}

/** "bookmarks.json", or "bookmarks-die-verwandlung.json" for one book's. */
export function exportFileName(format: ExportFormat, book?: Pick<Book, 'title'>): string {
  const info = EXPORT_FORMATS.find((f) => f.key === format)!
  const slug = book === undefined ? '' : titleSlug(book.title)
  return `bookmarks${slug === '' ? '' : `-${slug}`}.${info.extension}`
}

// ---------------------------------------------------------------------------------------------
// JSON

export interface BookmarksExport {
  format: typeof BOOKMARKS_FORMAT
  version: typeof BOOKMARKS_VERSION
  /** ISO time of the export. */
  exported: string
  books: {
    id: string
    title: string
    author: string
    langs: Book['langs']
    bookmarks: Omit<BookmarkRow, 'bookId'>[]
  }[]
}

export function bookmarksExport(groups: readonly BookmarkGroup[], now: number): BookmarksExport {
  return {
    format: BOOKMARKS_FORMAT,
    version: BOOKMARKS_VERSION,
    exported: new Date(now).toISOString(),
    books: groups.map((g) => ({
      id: g.book.id,
      title: g.book.title,
      author: g.book.author,
      langs: g.book.langs,
      bookmarks: g.rows.map(({ bookId: _bookId, ...row }) => row),
    })),
  }
}

export function bookmarksJson(groups: readonly BookmarkGroup[], now: number): string {
  return JSON.stringify(bookmarksExport(groups, now), null, 2) + '\n'
}

// ---------------------------------------------------------------------------------------------
// Markdown

/** The headword line of a word bookmark as text: its articles and lemma, or the word as printed. */
export function wordFront(payload: WordBookmark): string {
  const entry = payload.entries[0]
  const lemma = payload.lemma ?? payload.word.token
  if (entry === undefined || entry.articles.length === 0) return lemma
  return `${entry.articles.map((a) => a.text).join('/')} ${lemma}`
}

/** A word bookmark's glosses in one line, each entry's senses joined with "; ", entries with " · ". */
export function wordGlosses(payload: WordBookmark): string {
  return payload.entries
    .map((e) => e.glosses.join('; '))
    .filter((g) => g !== '')
    .join(' · ')
}

export function bookmarksMarkdown(groups: readonly BookmarkGroup[], now: number): string {
  const total = groups.reduce((n, g) => n + g.rows.length, 0)
  const lines: string[] = ['# Bookmarks', '', `Exported ${new Date(now).toISOString().slice(0, 10)} · ${total === 1 ? '1 bookmark' : `${total} bookmarks`}`, '']
  for (const g of groups) {
    lines.push(`## ${g.book.title}${g.book.author === '' ? '' : ` — ${g.book.author}`}`, '')
    let heading: string | null = null
    for (const row of g.rows) {
      if (row.payload.heading !== heading) {
        heading = row.payload.heading
        if (heading !== '') lines.push(`### ${heading}`, '')
      }
      lines.push(...markdownRow(row), '')
    }
  }
  return lines.join('\n')
}

function markdownRow(row: BookmarkRow): string[] {
  if (row.type === 'sentence') {
    const p = row.payload
    return p.translationText === '' ? [`**${p.text}**`] : [`**${p.text}**  `, p.translationText]
  }
  const p = row.payload
  const glosses = wordGlosses(p)
  const out = [`**${wordFront(p)}**${glosses === '' ? (p.lemma === null ? ' — no entry' : '') : ` — ${glosses}`}`]
  if (p.sentenceText !== '') {
    out[0] += '  '
    out.push(p.translationText === '' ? `*${p.sentenceText}*` : `*${p.sentenceText}*  `)
    if (p.translationText !== '') out.push(p.translationText)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Anki

/** Anki's file header: fields separated by tabs, HTML allowed (so `<br>` breaks lines). Older importers skip `#` lines. */
export const ANKI_HEADER = '#separator:tab\n#html:true\n'

export function bookmarksTsv(groups: readonly BookmarkGroup[]): string {
  const lines = [ANKI_HEADER.trimEnd()]
  for (const g of groups) for (const row of g.rows) lines.push(ankiNote(row).map(ankiField).join('\t'))
  return lines.join('\n') + '\n'
}

/** The two fields of a bookmark's note: front (German), back (English), as HTML. */
export function ankiNote(row: BookmarkRow): [front: string, back: string] {
  if (row.type === 'sentence') return [html(row.payload.text), html(row.payload.translationText)]
  const p = row.payload
  const back: string[] = []
  const glosses = wordGlosses(p)
  if (glosses !== '') back.push(html(glosses))
  if (p.sentenceText !== '') back.push(`<i>${html(p.sentenceText)}</i>`)
  if (p.translationText !== '') back.push(html(p.translationText))
  return [html(wordFront(p)), back.join('<br>')]
}

function html(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** A field as it goes into the file: no tabs or line breaks, quoted when it holds a quote. */
export function ankiField(text: string): string {
  const flat = text.replace(/\t/g, ' ').replace(/\r?\n/g, '<br>')
  return flat.includes('"') ? `"${flat.replace(/"/g, '""')}"` : flat
}
