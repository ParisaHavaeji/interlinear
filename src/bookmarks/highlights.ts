/**
 * Highlights: any stretch of the text the reader selected (by holding on the page and dragging,
 * as in Books), kept in a colour with an optional note. A highlight is a third kind of bookmark
 * row, so it is stored, synced, listed and exported with the others; this is its model, DOM-free
 * so it can be tested.
 *
 * A highlight is a range of the shown language's text between two {@link TextPoint}s, each a
 * paragraph and a character offset into it. Paragraphs are fixed at import, so unlike sentence
 * indices these places never move. A selection is snapped before it is kept ({@link snapRange}):
 * a word cut by either end is taken whole, and the white space at the ends is dropped.
 *
 * The page draws highlights paragraph by paragraph: {@link paraHighlights} gives each paragraph
 * the spans that cross it, {@link overlapping} and {@link pieces} tell a token which highlight
 * it is under. Where two overlap, the inner one shows (the one that starts later).
 */

import { tokenize } from '../reader/tokenize.ts'
import type { BookmarkRow } from '../store/db.ts'
import type { HighlightBookmark, Place, TextPoint } from './model.ts'

/** The highlighter's colours, in the order the card offers them. */
export const HIGHLIGHT_COLOURS = ['yellow', 'green', 'blue', 'pink', 'purple'] as const
export type HighlightColour = (typeof HIGHLIGHT_COLOURS)[number]
export const DEFAULT_HIGHLIGHT_COLOUR: HighlightColour = 'yellow'

/** `value` when it is one of the colours, else the default. */
export function sanitizeHighlightColour(value: unknown): HighlightColour {
  return HIGHLIGHT_COLOURS.includes(value as HighlightColour) ? (value as HighlightColour) : DEFAULT_HIGHLIGHT_COLOUR
}

/** A stretch of text from `start` up to but not including `end`. */
export interface TextRange {
  start: TextPoint
  end: TextPoint
}

export type HighlightRow = Extract<BookmarkRow, { type: 'highlight' }>

/** Reading order of two points: negative when `a` comes first. */
export function comparePoints(a: TextPoint, b: TextPoint): number {
  return a.para - b.para || a.offset - b.offset
}

/** A highlight never spans more paragraphs than this; a longer selection is cut short. */
const MAX_PARAGRAPHS = 200

/**
 * The range a selection is kept as: its ends put in reading order, a word cut by either end
 * taken whole, white space at the ends dropped (across paragraph breaks too). Null when nothing
 * but white space is left. `textOf` gives a paragraph's text by `Paragraph.idx`.
 */
export function snapRange(range: TextRange, textOf: (para: number) => string | undefined): TextRange | null {
  let [start, end] = comparePoints(range.start, range.end) <= 0 ? [range.start, range.end] : [range.end, range.start]
  if (end.para - start.para > MAX_PARAGRAPHS) end = { para: start.para + MAX_PARAGRAPHS, offset: Number.MAX_SAFE_INTEGER }

  // The start: back to the beginning of a word it is inside, then past white space, on into the
  // next paragraph when this one has nothing left.
  let s = { ...start }
  for (;;) {
    const text = textOf(s.para)
    if (text === undefined) return null
    let offset = Math.min(Math.max(0, s.offset), text.length)
    const word = wordAround(text, offset)
    if (word !== null && word[0] < offset && offset < word[1]) offset = word[0]
    while (offset < text.length && /\s/.test(text[offset])) offset++
    s = { para: s.para, offset }
    if (offset < text.length || s.para >= end.para) break
    s = { para: s.para + 1, offset: 0 }
  }

  // The end: on to the end of a word it is inside, then back over white space, into the
  // paragraph before when it ends at the very start of one.
  let e = { ...end }
  for (;;) {
    const text = textOf(e.para)
    if (text === undefined) {
      if (e.para <= s.para) return null
      e = { para: e.para - 1, offset: Number.MAX_SAFE_INTEGER }
      continue
    }
    let offset = Math.min(Math.max(0, e.offset), text.length)
    const word = wordAround(text, offset)
    if (word !== null && word[0] < offset && offset < word[1]) offset = word[1]
    while (offset > 0 && /\s/.test(text[offset - 1])) offset--
    e = { para: e.para, offset }
    if (offset > 0 || e.para <= s.para) break
    e = { para: e.para - 1, offset: Number.MAX_SAFE_INTEGER }
  }

  return comparePoints(s, e) < 0 ? { start: s, end: e } : null
}

/** The word of `text` that `offset` touches (its start and end), or null between words. */
function wordAround(text: string, offset: number): [number, number] | null {
  let pos = 0
  for (const t of tokenize(text)) {
    const start = pos
    pos += t.text.length
    if (start > offset) return null
    if (t.word && offset <= pos) return [start, pos]
  }
  return null
}

/** The text of a range, paragraphs joined with a line break. */
export function rangeText(range: TextRange, textOf: (para: number) => string | undefined): string {
  const parts: string[] = []
  for (let para = range.start.para; para <= range.end.para; para++) {
    const text = textOf(para)
    if (text === undefined) continue
    const from = para === range.start.para ? range.start.offset : 0
    const to = para === range.end.para ? range.end.offset : text.length
    const part = text.slice(from, to).trim()
    if (part !== '') parts.push(part)
  }
  return parts.join('\n')
}

/** The highlight for a snapped range, as the row's payload. */
export function highlightBookmark(range: TextRange, text: string, colour: HighlightColour, place: Place): HighlightBookmark {
  return { start: { ...range.start }, end: { ...range.end }, text, colour, chapter: place.chapter, heading: place.heading }
}

/** The range a stored highlight covers; null for a payload that does not hold one. */
export function highlightRange(payload: HighlightBookmark): TextRange | null {
  const ok = (p: unknown): p is TextPoint =>
    typeof p === 'object' && p !== null && Number.isInteger((p as TextPoint).para) && Number.isInteger((p as TextPoint).offset)
  if (!ok(payload.start) || !ok(payload.end) || comparePoints(payload.start, payload.end) >= 0) return null
  return { start: payload.start, end: payload.end }
}

/** The highlight rows among a book's bookmarks. */
export function highlightRows(rows: readonly BookmarkRow[]): HighlightRow[] {
  return rows.filter((r): r is HighlightRow => r.type === 'highlight')
}

/** The highlight that covers the whole of `range`, if there is one (the innermost of several): a selection inside a highlight is that highlight. */
export function containingHighlight(rows: readonly BookmarkRow[], range: TextRange): HighlightRow | undefined {
  return highlightRows(rows)
    .sort(byPrecedence)
    .find((row) => {
      const r = highlightRange(row.payload)
      return r !== null && comparePoints(r.start, range.start) <= 0 && comparePoints(r.end, range.end) >= 0
    })
}

/** The part of a highlight that lies in one paragraph, in that paragraph's character offsets. */
export interface ParaHighlight {
  id: string
  start: number
  /** Exclusive; `Infinity` when the highlight runs on into the next paragraph. */
  end: number
  colour: HighlightColour
  /** The highlight has a note. */
  noted: boolean
}

/**
 * Which of two highlights shows where they overlap: the one that starts later, then the one
 * that ends sooner, then the newer. So a highlight made inside a longer one stays visible.
 */
function byPrecedence(a: HighlightRow, b: HighlightRow): number {
  const ra = highlightRange(a.payload)
  const rb = highlightRange(b.payload)
  if (ra === null || rb === null) return 0
  return comparePoints(rb.start, ra.start) || comparePoints(ra.end, rb.end) || b.created - a.created
}

/** Every paragraph's highlights by `Paragraph.idx`, the one that shows where two overlap first. */
export function paraHighlights(rows: readonly BookmarkRow[]): Map<number, ParaHighlight[]> {
  const out = new Map<number, ParaHighlight[]>()
  for (const row of highlightRows(rows).sort(byPrecedence)) {
    const r = highlightRange(row.payload)
    if (r === null) continue
    const last = Math.min(r.end.para, r.start.para + MAX_PARAGRAPHS)
    for (let para = r.start.para; para <= last; para++) {
      const start = para === r.start.para ? r.start.offset : 0
      const end = para === r.end.para ? r.end.offset : Infinity
      if (end <= start) continue
      const item: ParaHighlight = { id: row.id, start, end, colour: sanitizeHighlightColour(row.payload.colour), noted: row.note.trim() !== '' }
      const list = out.get(para)
      if (list === undefined) out.set(para, [item])
      else list.push(item)
    }
  }
  return out
}

/** The first of `highlights` that covers any of the characters `from`–`to` of its paragraph. */
export function overlapping(highlights: readonly ParaHighlight[], from: number, to: number): ParaHighlight | undefined {
  return highlights.find((h) => h.start < to && h.end > from)
}

/** The characters `from`–`to` cut wherever a highlight starts or ends, each piece with the highlight it is under. */
export function pieces(highlights: readonly ParaHighlight[], from: number, to: number): { from: number; to: number; highlight: ParaHighlight | undefined }[] {
  const cuts = new Set([from, to])
  for (const h of highlights) {
    if (h.start > from && h.start < to) cuts.add(h.start)
    if (h.end > from && h.end < to) cuts.add(h.end)
  }
  const sorted = [...cuts].sort((a, b) => a - b)
  const out: { from: number; to: number; highlight: ParaHighlight | undefined }[] = []
  for (let i = 0; i + 1 < sorted.length; i++) {
    const highlight = overlapping(highlights, sorted[i], sorted[i + 1])
    const prev = out[out.length - 1]
    if (prev !== undefined && prev.highlight === highlight) prev.to = sorted[i + 1]
    else out.push({ from: sorted[i], to: sorted[i + 1], highlight })
  }
  return out
}
