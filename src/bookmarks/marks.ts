/**
 * Bookmarks marked in the text: a bookmarked word carries a light tint (blue by default) and a
 * bookmarked sentence a lighter one (grey by default), so the reader sees what they saved where
 * they saved it. Which sentences and words carry a mark is worked out here from the book's
 * bookmarks and its text as it is now, through `locateBookmark`, so a re-alignment that renumbers
 * sentences moves the marks with the text. DOM-free so it can be tested.
 *
 * The two tints are a setting next to the article colours (`MARK_COLOURS_KEY`), drawn from the
 * same palette; Plain turns a mark off.
 */

import { ARTICLE_COLOURS, type ArticleColour } from '../reader/word.ts'
import type { BookmarkRow } from '../store/db.ts'
import { locateBookmark } from './locate.ts'

export interface BookmarkMarks {
  /** Book-wide indices of the sentences of bookmarked beads. */
  sentences: ReadonlySet<number>
  /** Bookmarked words: sentence index → the words' offsets in that sentence. */
  words: ReadonlyMap<number, ReadonlySet<number>>
}

export const NO_MARKS: BookmarkMarks = { sentences: new Set(), words: new Map() }

/**
 * Where `rows` sit in `text` (the shown language's sentences by index). A sentence bookmark
 * marks every sentence of its bead, shifted with its first sentence should that have moved; a
 * word bookmark marks its word, or nothing when the word is no longer in its sentence. A
 * bookmark that cannot be found marks nothing.
 */
export function bookmarkMarks(rows: readonly BookmarkRow[], text: ReadonlyMap<number, string>): BookmarkMarks {
  if (rows.length === 0) return NO_MARKS
  const sentences = new Set<number>()
  const words = new Map<number, Set<number>>()
  for (const row of rows) {
    const place = locateBookmark(row, text)
    if (place === null) continue
    if (row.type === 'sentence') {
      const recorded = row.payload.sentences
      const shift = recorded.length === 0 ? 0 : place.sentence - recorded[0]
      if (recorded.length === 0) sentences.add(place.sentence)
      for (const s of recorded) if (text.has(s + shift)) sentences.add(s + shift)
    } else if (place.word !== undefined) {
      let offsets = words.get(place.sentence)
      if (offsets === undefined) words.set(place.sentence, (offsets = new Set()))
      offsets.add(place.word.offset)
    }
  }
  return { sentences, words }
}

/** The tint of each kind of mark; what Settings edits. */
export interface MarkColours {
  word: ArticleColour
  sentence: ArticleColour
}

/** A word is slightly blue, a sentence slightly grey. */
export const DEFAULT_MARK_COLOURS: MarkColours = { word: 'blue', sentence: 'grey' }

/** `value` with every tint a known colour; unknown or missing ones fall back to the default. */
export function sanitizeMarkColours(value: unknown): MarkColours {
  const out = { ...DEFAULT_MARK_COLOURS }
  if (typeof value !== 'object' || value === null) return out
  const keys = new Set(ARTICLE_COLOURS.map((c) => c.key))
  for (const k of ['word', 'sentence'] as const) {
    const v = (value as Record<string, unknown>)[k]
    if (typeof v === 'string' && keys.has(v as ArticleColour)) out[k] = v as ArticleColour
  }
  return out
}

/** How strongly each mark is tinted: light enough to read through, the sentence lighter than the word. */
const STRENGTH: Record<keyof MarkColours, number> = { word: 24, sentence: 20 }

/** The CSS colour of a mark: the palette colour thinned to a tint, or transparent for Plain. */
export function markTint(kind: keyof MarkColours, colour: ArticleColour): string {
  return colour === 'none' ? 'transparent' : `color-mix(in srgb, var(--c-${colour}) ${STRENGTH[kind]}%, transparent)`
}

/** The custom properties the page's marks are drawn with (`--mark-word`, `--mark-sentence`). */
export function markStyle(colours: MarkColours): string {
  return `--mark-word: ${markTint('word', colours.word)}; --mark-sentence: ${markTint('sentence', colours.sentence)}`
}
