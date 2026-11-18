// Highlights: snapping a selection, the text it covers, and how a paragraph's tokens find their highlight.
import { describe, expect, it } from 'vitest'
import {
  containingHighlight,
  highlightBookmark,
  overlapping,
  paraHighlights,
  pieces,
  rangeText,
  sanitizeHighlightColour,
  snapRange,
  type TextRange,
} from '../src/bookmarks/highlights.ts'
import { bookmarksMarkdown, ankiNote } from '../src/bookmarks/export.ts'
import { groupBookmarks, kindCounts, matchesSearch, searchTerms } from '../src/bookmarks/list.ts'
import { bookmarkMarks } from '../src/bookmarks/marks.ts'
import type { Book, BookmarkRow } from '../src/store/db.ts'

const paras = ['Als Gregor Samsa erwachte, lag er im Bett.', '  ', 'Was ist geschehen? Es war kein Traum.']
const textOf = (i: number) => paras[i]
const range = (p1: number, o1: number, p2: number, o2: number): TextRange => ({ start: { para: p1, offset: o1 }, end: { para: p2, offset: o2 } })

const row = (id: string, r: TextRange, created = 1, note = '', colour = 'yellow'): BookmarkRow => ({
  id,
  bookId: 'b',
  note,
  created,
  type: 'highlight',
  payload: highlightBookmark(r, rangeText(r, textOf), sanitizeHighlightColour(colour), { chapter: 0, heading: 'I' }),
})

describe('snapRange', () => {
  it('takes a word cut by either end whole', () => {
    // "regor Sam" → "Gregor Samsa"
    expect(snapRange(range(0, 5, 0, 14), textOf)).toEqual(range(0, 4, 0, 16))
  })

  it('keeps punctuation the selection took and drops white space at the ends', () => {
    // " erwachte, " → "erwachte,"
    const snapped = snapRange(range(0, 16, 0, 27), textOf)!
    expect(rangeText(snapped, textOf)).toBe('erwachte,')
  })

  it('puts the ends in reading order', () => {
    expect(snapRange(range(0, 16, 0, 4), textOf)).toEqual(range(0, 4, 0, 16))
  })

  it('moves an end out of an empty stretch into the paragraph that has text', () => {
    // From the end of the first paragraph to the start of the third: nothing but white space.
    expect(snapRange(range(0, paras[0].length, 2, 0), textOf)).toBeNull()
    // From inside the blank paragraph to "Was": starts at the third paragraph.
    expect(snapRange(range(1, 1, 2, 2), textOf)).toEqual(range(2, 0, 2, 3))
    // From "Bett." to the very start of the third paragraph: ends with the first.
    expect(snapRange(range(0, 37, 2, 0), textOf)).toEqual(range(0, 37, 0, paras[0].length))
  })

  it('is null for a collapsed or unknown place', () => {
    expect(snapRange(range(0, 3, 0, 3), textOf)).toBeNull()
    expect(snapRange(range(9, 0, 9, 4), textOf)).toBeNull()
  })
})

describe('rangeText', () => {
  it('joins the paragraphs a range crosses with a line break', () => {
    expect(rangeText(range(0, 30, 2, 18), textOf)).toBe('er im Bett.\nWas ist geschehen?')
  })
})

describe('paraHighlights', () => {
  const across = row('a', range(0, 30, 2, 18), 1)
  const inner = row('b', range(2, 4, 2, 7), 2, 'ist!', 'green')

  it('shows a highlight made inside a longer one, whichever is newer', () => {
    const older = { ...inner, created: 0 }
    expect(paraHighlights([across, older]).get(2)!.map((h) => h.id)).toEqual(['b', 'a'])
    expect(containingHighlight([across, older], range(2, 4, 2, 7))?.id).toBe('b')
  })

  it('gives each paragraph the part of a highlight that lies in it, the inner one first', () => {
    const map = paraHighlights([across, inner])
    expect(map.get(0)).toEqual([{ id: 'a', start: 30, end: Infinity, colour: 'yellow', noted: false }])
    expect(map.get(1)).toEqual([{ id: 'a', start: 0, end: Infinity, colour: 'yellow', noted: false }])
    expect(map.get(2)).toEqual([
      { id: 'b', start: 4, end: 7, colour: 'green', noted: true },
      { id: 'a', start: 0, end: 18, colour: 'yellow', noted: false },
    ])
  })

  it('tells a token which highlight it is under, the newer one where two overlap', () => {
    const list = paraHighlights([across, inner]).get(2)!
    expect(overlapping(list, 0, 3)?.id).toBe('a')
    expect(overlapping(list, 4, 7)?.id).toBe('b')
    expect(overlapping(list, 19, 21)).toBeUndefined()
    // "? " straddles the end of the highlight: the mark is under it, the space is not.
    expect(pieces(list, 17, 19).map((p) => [p.from, p.to, p.highlight?.id])).toEqual([
      [17, 18, 'a'],
      [18, 19, undefined],
    ])
  })

  it('ignores a payload without a range and bookmarks of other kinds', () => {
    const broken = { ...across, id: 'x', payload: { ...across.payload, start: undefined } } as unknown as BookmarkRow
    expect(paraHighlights([broken]).size).toBe(0)
  })
})

describe('containingHighlight', () => {
  it('finds the highlight a selection lies within', () => {
    const rows = [row('a', range(0, 4, 0, 25), 1), row('b', range(0, 4, 0, 16), 2)]
    expect(containingHighlight(rows, range(0, 4, 0, 10))?.id).toBe('b')
    expect(containingHighlight(rows, range(0, 11, 0, 25))?.id).toBe('a')
    expect(containingHighlight(rows, range(0, 0, 0, 10))).toBeUndefined()
  })
})

describe('highlights among the bookmarks', () => {
  const book = { id: 'b', title: 'Die Verwandlung', author: 'Kafka', langs: ['de', 'en'] } as unknown as Book
  const noted = row('a', range(2, 0, 2, 18), 1, 'Die Frage des Buchs')

  it('are counted, searched by text and note, and leave no bookmark tint', () => {
    const groups = groupBookmarks([noted], [book])
    expect(kindCounts(groups)).toEqual({ word: 0, sentence: 0, highlight: 1 })
    expect(matchesSearch(noted, searchTerms('geschehen'), book)).toBe(true)
    expect(matchesSearch(noted, searchTerms('frage buchs'), book)).toBe(true)
    expect(bookmarkMarks([noted], new Map([[0, paras[2]]])).sentences.size).toBe(0)
  })

  it('export as a quote with the note, and as a text / note card', () => {
    const md = bookmarksMarkdown(groupBookmarks([noted], [book]), 0)
    expect(md).toContain('> Was ist geschehen?\n\nDie Frage des Buchs')
    expect(ankiNote(noted)).toEqual(['Was ist geschehen?', 'Die Frage des Buchs'])
  })
})
