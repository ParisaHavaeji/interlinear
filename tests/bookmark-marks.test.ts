// Bookmarks marked in the text: which sentences and words carry a tint, and the tint setting.
import { describe, expect, it } from 'vitest'
import { bookmarkMarks, DEFAULT_MARK_COLOURS, markStyle, markTint, sanitizeMarkColours } from '../src/bookmarks/marks.ts'
import type { BookmarkRow } from '../src/store/db.ts'

const text = new Map([
  [0, 'Als Gregor Samsa erwachte.'],
  [1, 'Er lag auf dem Rücken.'],
  [2, 'Er sah seinen Bauch.'],
  [3, 'Was ist geschehen?'],
])

const sentenceRow = (sentences: number[], joined: string): BookmarkRow => ({
  id: `s${sentences.join('-')}`,
  bookId: 'b',
  note: '',
  created: 1,
  type: 'sentence',
  payload: { sentences, translation: [], text: joined, translationText: '', chapter: 0, heading: '' },
})

const wordRow = (sentence: number, offset: number, token: string, sentenceText: string): BookmarkRow => ({
  id: `w${sentence}-${offset}`,
  bookId: 'b',
  note: '',
  created: 1,
  type: 'word',
  payload: { word: { sentence, offset, token }, lemma: null, entries: [], sentenceText, translationText: '', chapter: 0, heading: '' },
})

describe('bookmarkMarks', () => {
  it('marks every sentence of a bookmarked bead and each bookmarked word', () => {
    const marks = bookmarkMarks([sentenceRow([1, 2], `${text.get(1)} ${text.get(2)}`), wordRow(0, 11, 'Samsa', text.get(0)!)], text)
    expect([...marks.sentences]).toEqual([1, 2])
    expect([...(marks.words.get(0) ?? [])]).toEqual([11])
    expect(marks.words.has(1)).toBe(false)
  })

  it('follows a bead whose sentences were renumbered', () => {
    const shifted = new Map([[0, 'Vorwort.'], ...[...text].map(([i, t]) => [i + 1, t] as [number, string])])
    const marks = bookmarkMarks([sentenceRow([1, 2], `${text.get(1)} ${text.get(2)}`)], shifted)
    expect([...marks.sentences]).toEqual([2, 3])
  })

  it('finds a word moved within its sentence and drops one no longer there', () => {
    const marks = bookmarkMarks([wordRow(1, 3, 'Rücken', text.get(1)!), wordRow(2, 0, 'Fehlt', text.get(2)!)], text)
    expect([...(marks.words.get(1) ?? [])]).toEqual([15])
    expect(marks.words.has(2)).toBe(false)
  })

  it('marks nothing for a bookmark that cannot be found', () => {
    const marks = bookmarkMarks([sentenceRow([7], 'Nicht mehr da.')], text)
    expect(marks.sentences.size).toBe(0)
  })
})

describe('mark colours', () => {
  it('defaults to a blue word and a grey sentence, and keeps known colours only', () => {
    expect(sanitizeMarkColours(undefined)).toEqual({ word: 'blue', sentence: 'grey' })
    expect(sanitizeMarkColours({ word: 'teal', sentence: 'magenta' })).toEqual({ word: 'teal', sentence: DEFAULT_MARK_COLOURS.sentence })
  })

  it('thins the palette colour to a tint, and Plain to nothing', () => {
    expect(markTint('word', 'blue')).toContain('var(--c-blue)')
    expect(markTint('sentence', 'none')).toBe('transparent')
    expect(markStyle({ word: 'none', sentence: 'grey' })).toMatch(/--mark-word: transparent; --mark-sentence: color-mix\(.*--c-grey/)
  })
})
