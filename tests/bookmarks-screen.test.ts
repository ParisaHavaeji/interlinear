// The bookmarks screen (plan.md step 26): grouping and search, finding a bookmark in the text as it is now, swipe-to-delete arithmetic.
import { describe, expect, it } from 'vitest'
import { countLabel, dateLabel, filterGroups, groupBookmarks, matchesSearch, positionOf, searchKey, searchTerms, wordGloss, wordHeadline } from '../src/bookmarks/list.ts'
import { locateBookmark } from '../src/bookmarks/locate.ts'
import type { SentenceBookmark, WordBookmark } from '../src/bookmarks/model.ts'
import type { Book, BookmarkRow } from '../src/store/db.ts'
import { actionWidthAt, SWIPE_ACTION_WIDTH, swipeOffset, swipeOutcome } from '../src/ui/swipe.ts'

const place = { chapter: 1, heading: 'Erstes Kapitel' }

function sentence(id: string, bookId: string, sentences: number[], text: string, translationText: string, created: number, extra: Partial<SentenceBookmark> = {}): BookmarkRow {
  return { id, bookId, note: '', created, type: 'sentence', payload: { sentences, translation: [], text, translationText, ...place, ...extra } }
}

function word(id: string, bookId: string, ref: { sentence: number; offset: number; token: string }, lemma: string | null, glosses: string[], sentenceText: string, created: number): BookmarkRow {
  const payload: WordBookmark = {
    word: ref,
    lemma,
    entries: lemma === null ? [] : [{ lemma, articles: [{ text: 'der', gender: 'm' }], pos: 'noun', note: '', plural: null, glosses, src: 'wikt' }],
    sentenceText,
    translationText: '',
    ...place,
  }
  return { id, bookId, note: '', created, type: 'word', payload }
}

const book = (id: string, title: string, author: string): Book => ({
  id,
  title,
  author,
  langs: ['de', 'en'],
  created: 0,
  cover: { hue: 0, hue2: 0 },
  sources: { de: { fileName: '', format: 'txt', paragraphs: 0, words: 0, sections: [] }, en: { fileName: '', format: 'txt', paragraphs: 0, words: 0, sections: [] } },
})

const kafka = book('k', 'Die Verwandlung', 'Franz Kafka')
const hesse = book('h', 'Demian', 'Hermann Hesse')

const rows: BookmarkRow[] = [
  sentence('s2', 'k', [12, 13], 'Er lag auf dem Rücken. Er sah seinen Bauch.', 'He lay on his back and saw his belly.', 300),
  word('w1', 'k', { sentence: 12, offset: 15, token: 'Rücken' }, 'Rücken', ['back', 'spine'], 'Er lag auf dem Rücken.', 100),
  sentence('s1', 'k', [3], 'Was ist mit mir geschehen?', 'What has happened to me?', 200),
  sentence('h1', 'h', [40], 'Die Straße war leer.', 'The street was empty.', 250),
  sentence('gone', 'zz', [0], 'Kein Buch mehr.', '', 999),
]

describe('groupBookmarks', () => {
  it('groups by book, newest bookmark first, rows in reading order, and drops books that are gone', () => {
    const groups = groupBookmarks(rows, [hesse, kafka])
    expect(groups.map((g) => g.book.id)).toEqual(['k', 'h'])
    expect(groups[0].rows.map((r) => r.id)).toEqual(['s1', 's2', 'w1'])
    expect(groups[0].latest).toBe(300)
    expect(groups[1].rows.map((r) => r.id)).toEqual(['h1'])
  })

  it('orders the bead that starts at a sentence before a word inside it, and ties by time', () => {
    expect(positionOf(rows[0])).toEqual([12, -1])
    expect(positionOf(rows[1])).toEqual([12, 15])
    const a = sentence('a', 'k', [5], 'A', '', 1)
    const b = sentence('b', 'k', [5], 'B', '', 2)
    expect(groupBookmarks([b, a], [kafka])[0].rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(positionOf(sentence('x', 'k', [], '', '', 1))[0]).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('leaves out books without bookmarks', () => {
    expect(groupBookmarks([], [kafka])).toEqual([])
    expect(groupBookmarks(rows, [book('other', 'X', 'Y')])).toEqual([])
  })
})

describe('search', () => {
  it('normalises case, accents, ß and spacing', () => {
    expect(searchKey('  Die  STRAẞE ')).toBe('die strasse')
    expect(searchKey('Straße')).toBe('strasse')
    expect(searchKey('Rücken')).toBe('rucken')
    expect(searchTerms(' ')).toEqual([])
    expect(searchTerms('Rücken  leer')).toEqual(['rucken', 'leer'])
  })

  it('matches every term against both texts, the headword, glosses, heading, title and author', () => {
    const groups = groupBookmarks(rows, [hesse, kafka])
    const ids = (q: string) => filterGroups(groups, q).flatMap((g) => g.rows.map((r) => r.id))
    expect(ids('')).toEqual(['s1', 's2', 'w1', 'h1'])
    expect(ids('rucken')).toEqual(['s2', 'w1'])
    expect(ids('spine')).toEqual(['w1'])
    expect(ids('strasse')).toEqual(['h1'])
    expect(ids('STREET empty')).toEqual(['h1'])
    expect(ids('kafka back')).toEqual(['s2', 'w1'])
    expect(ids('Erstes Kapitel')).toHaveLength(4)
    expect(ids('nothing like this')).toEqual([])
    expect(matchesSearch(rows[1], ['rucken'])).toBe(true)
    expect(matchesSearch(rows[1], ['kafka'])).toBe(false)
    expect(matchesSearch(rows[1], ['kafka'], kafka)).toBe(true)
  })

  it('keeps the groups the same objects when the query is blank', () => {
    const groups = groupBookmarks(rows, [kafka])
    expect(filterGroups(groups, '  ')[0]).toBe(groups[0])
  })
})

describe('labels', () => {
  it('heads a word row with its article and lemma, or the word as printed when there was no entry', () => {
    expect(wordHeadline(rows[1].payload as WordBookmark)).toEqual({ article: { text: 'der', gender: 'm' }, lemma: 'Rücken' })
    expect(wordGloss(rows[1].payload as WordBookmark)).toBe('back; spine')
    const none = word('n', 'k', { sentence: 1, offset: 0, token: 'Zxq' }, null, [], 'Zxq.', 1).payload as WordBookmark
    expect(wordHeadline(none)).toEqual({ article: null, lemma: 'Zxq' })
    expect(wordGloss(none)).toBe('')
  })

  it('dates a bookmark relative to today, with the year once it differs', () => {
    const now = new Date(2026, 10, 11, 15, 0).getTime()
    expect(dateLabel(new Date(2026, 10, 11, 1, 0).getTime(), now)).toBe('Today')
    expect(dateLabel(new Date(2026, 10, 10, 23, 59).getTime(), now)).toBe('Yesterday')
    expect(dateLabel(new Date(2026, 10, 2).getTime(), now)).toBe('2 Nov')
    expect(dateLabel(new Date(2025, 11, 24).getTime(), now)).toBe('24 Dec 2025')
    expect(countLabel(1)).toBe('1 bookmark')
    expect(countLabel(12)).toBe('12 bookmarks')
  })
})

describe('locateBookmark', () => {
  const text = new Map([
    [10, 'Als Gregor Samsa erwachte.'],
    [11, 'Er lag auf dem Rücken.'],
    [12, 'Er sah seinen Bauch.'],
    [13, 'Was ist geschehen?'],
    [20, 'Er lag auf dem Rücken.'],
  ])

  it('trusts the recorded sentence while its text is the bookmarked text', () => {
    expect(locateBookmark(sentence('s', 'k', [11, 12], 'Er lag auf dem Rücken. Er sah seinen Bauch.', '', 1), text)).toEqual({ sentence: 11 })
    expect(locateBookmark(sentence('s', 'k', [13], 'Was ist geschehen?', '', 1), text)).toEqual({ sentence: 13 })
  })

  it('searches for the text, nearest to where it was, when the sentences were renumbered', () => {
    expect(locateBookmark(sentence('s', 'k', [3], 'Er sah seinen Bauch.', '', 1), text)).toEqual({ sentence: 12 })
    // Two sentences read the same: the one nearer the recorded index wins.
    expect(locateBookmark(sentence('s', 'k', [17], 'Er lag auf dem Rücken. Er sah seinen Bauch.', '', 1), text)).toEqual({ sentence: 20 })
    expect(locateBookmark(sentence('s', 'k', [14], 'Er lag auf dem Rücken.', '', 1), text)).toEqual({ sentence: 11 })
  })

  it('gives up on a sentence that is no longer in the text, and on an empty bookmark whose index is gone', () => {
    expect(locateBookmark(sentence('s', 'k', [11], 'Ganz anderer Satz.', '', 1), text)).toBeNull()
    expect(locateBookmark(sentence('s', 'k', [99], '', '', 1), text)).toBeNull()
    expect(locateBookmark(sentence('s', 'k', [], 'Nirgends.', '', 1), text)).toBeNull()
  })

  it('does not take a sentence that merely begins like the bookmarked one', () => {
    const t = new Map([[1, 'Er lag'], [2, 'Er lag auf dem Rücken.']])
    expect(locateBookmark(sentence('s', 'k', [5], 'Er lag auf dem Rücken.', '', 1), t)).toEqual({ sentence: 2 })
  })

  it('finds a word at its offset, elsewhere in its sentence, or settles for the sentence', () => {
    const at = (ref: { sentence: number; offset: number; token: string }, sentenceText: string) => locateBookmark(word('w', 'k', ref, 'Rücken', [], sentenceText, 1), text)
    expect(at({ sentence: 11, offset: 15, token: 'Rücken' }, 'Er lag auf dem Rücken.')).toEqual({ sentence: 11, word: { offset: 15, token: 'Rücken' } })
    // The sentence moved and the offset is stale: the word is found by its text.
    expect(at({ sentence: 2, offset: 0, token: 'Rücken' }, 'Er lag auf dem Rücken.')).toEqual({ sentence: 11, word: { offset: 15, token: 'Rücken' } })
    // The sentence is there but the word is not in it any more.
    expect(at({ sentence: 13, offset: 0, token: 'Wer' }, 'Was ist geschehen?')).toEqual({ sentence: 13 })
    // "Er" at offset 0, not the "er" inside "erwachte".
    expect(locateBookmark(word('w', 'k', { sentence: 11, offset: 0, token: 'Er' }, null, [], 'Er lag auf dem Rücken.', 1), text)).toEqual({ sentence: 11, word: { offset: 0, token: 'Er' } })
    expect(at({ sentence: 11, offset: 15, token: 'Rücken' }, 'Ein Satz, den es nicht gibt.')).toBeNull()
  })
})

describe('swipe', () => {
  it('follows the finger to the left and resists to the right', () => {
    expect(swipeOffset(-30, 0)).toBe(-30)
    expect(swipeOffset(-200, 0)).toBe(-200)
    expect(swipeOffset(-30, -SWIPE_ACTION_WIDTH)).toBe(-SWIPE_ACTION_WIDTH - 30)
    expect(swipeOffset(0, 0)).toBe(0)
    const right = swipeOffset(60, 0)
    expect(right).toBeGreaterThan(0)
    expect(right).toBeLessThan(24)
    expect(swipeOffset(SWIPE_ACTION_WIDTH + 10, -SWIPE_ACTION_WIDTH)).toBeLessThan(10)
  })

  it('settles on the nearer side, follows a flick, and deletes after a long drag', () => {
    expect(swipeOutcome(-20, 0, 360)).toBe('closed')
    expect(swipeOutcome(-60, 0, 360)).toBe('open')
    expect(swipeOutcome(-20, -0.5, 360)).toBe('open')
    expect(swipeOutcome(-80, 0.5, 360)).toBe('closed')
    expect(swipeOutcome(-220, 0, 360)).toBe('delete')
    expect(swipeOutcome(-220, 0.5, 360)).toBe('delete')
    // No row width known: never a full-swipe delete.
    expect(swipeOutcome(-220, 0, 0)).toBe('open')
  })

  it('stretches the button once the row has gone past it', () => {
    expect(actionWidthAt(0)).toBe(SWIPE_ACTION_WIDTH)
    expect(actionWidthAt(-SWIPE_ACTION_WIDTH)).toBe(SWIPE_ACTION_WIDTH)
    expect(actionWidthAt(-150)).toBe(150)
  })
})
