/**
 * Dexie database (plan §2). Step 6b uses `books` and `paragraphs`; the remaining tables are
 * declared now so later phases add rows, not schema versions.
 */

import { Dexie, type EntityTable, type Table } from 'dexie'
import type { AlignStats, ChapterMap } from '../align/pipeline.ts'
import type { InducedPair } from '../align/lexicon.ts'
import type { ChapterEdits } from '../align/structure.ts'
import type { TxtLayout } from '../import/txt.ts'
import type { Lang, SectionKind } from '../import/types.ts'

export const DB_NAME = 'interlinear'

/** Two hues (degrees) that define a generated cover's gradient. See `ui/cover.ts`. */
export interface CoverColours {
  hue: number
  hue2: number
}

/** Where one language's text came from, and how its sections lie in `paragraphs`. */
export interface SourceInfo {
  fileName: string
  format: 'txt' | 'epub'
  paragraphs: number
  words: number
  /** EPUB spine items, in order. Empty for plain text (headings are detected at align time). */
  sections: SectionMeta[]
  /**
   * Plain text only: `lines` when the file had one paragraph per line. Two `lines` sources with
   * the same paragraph count are pre-aligned input and skip the aligner (see `align/prealigned.ts`).
   */
  layout?: TxtLayout
}

/** A spine item of an imported EPUB, pointing at its paragraphs by index range. */
export interface SectionMeta {
  idx: number
  href: string
  title: string | null
  heading: string | null
  kind: SectionKind
  linear: boolean
  words: number
  /** Index (`Paragraph.idx`) of the section's first paragraph in `paragraphs`. */
  paraStart: number
  paraCount: number
}

/**
 * Where a book's alignment stands. `pending` right after import, `aligning` while the worker
 * runs (an interrupted run leaves it there and is resumed on the next launch), `ready` once
 * `sentences` and `beads` hold the result, `failed` with the error until the user retries.
 */
export type AlignmentStatus = 'pending' | 'aligning' | 'ready' | 'failed'

export interface AlignmentState {
  status: AlignmentStatus
  /** Unix ms of the last status change. */
  updated: number
  error?: string
  /** Chapters of both editions and how they were paired; set once `ready`. */
  chapters?: ChapterMap
  /** The book-specific lexicon pass two learned; set once `ready`. */
  lexicon?: InducedPair[]
  stats?: AlignStats
}

export interface Book {
  id: string
  title: string
  author: string
  /** Language pair: original first, translation second. */
  langs: [Lang, Lang]
  /** Unix ms. */
  created: number
  cover: CoverColours
  sources: Record<Lang, SourceInfo>
  /** Missing on books imported before step 12; treated as `pending`. */
  alignment?: AlignmentState
  /**
   * The reader's corrections to the chapter structure from the chapter sheet (step 17):
   * sections included or excluded, chapters paired by hand. Applied on every alignment run.
   */
  chapterEdits?: ChapterEdits
}

export interface ParagraphRow {
  bookId: string
  lang: Lang
  idx: number
  text: string
  /** Block class from the EPUB, when it carried a hint (see `import/types.ts`). */
  cls?: string
}

export interface SentenceRow {
  bookId: string
  lang: Lang
  idx: number
  paraIdx: number
  text: string
  charStart: number
  charEnd: number
}

export interface BeadRow {
  bookId: string
  beadIdx: number
  deSentenceIdx: number[]
  enSentenceIdx: number[]
  confidence: number
  manual: boolean
}

export interface BookmarkRow {
  id: string
  bookId: string
  type: 'sentence' | 'word'
  payload: unknown
  note: string
  created: number
}

export interface ProgressRow {
  bookId: string
  sentenceIdx: number
  scrollFraction: number
}

export interface SettingRow {
  key: string
  value: unknown
}

export type InterlinearDB = Dexie & {
  books: EntityTable<Book, 'id'>
  paragraphs: Table<ParagraphRow, [string, Lang, number]>
  sentences: Table<SentenceRow, [string, Lang, number]>
  beads: Table<BeadRow, [string, number]>
  bookmarks: EntityTable<BookmarkRow, 'id'>
  progress: EntityTable<ProgressRow, 'bookId'>
  settings: EntityTable<SettingRow, 'key'>
}

/** Create (or open) the database. Tests pass their own name to get a fresh store each time. */
export function openDatabase(name: string = DB_NAME): InterlinearDB {
  const db = new Dexie(name) as InterlinearDB
  db.version(1).stores({
    books: 'id, title, created',
    paragraphs: '[bookId+lang+idx], bookId, [bookId+lang]',
    sentences: '[bookId+lang+idx], bookId, [bookId+lang], [bookId+lang+paraIdx]',
    beads: '[bookId+beadIdx], bookId',
    bookmarks: 'id, bookId, [bookId+type], created',
    progress: 'bookId',
    settings: 'key',
  })
  return db
}

let shared: InterlinearDB | null = null

/** The app's one database instance, opened lazily. */
export function db(): InterlinearDB {
  if (shared === null) shared = openDatabase()
  return shared
}
