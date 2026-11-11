// Bookmarks (plan.md step 25): what a sentence or word bookmark records, which one a card is on, and the store.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findSentenceBookmark, findWordBookmark, sentenceBookmark, wordBookmark, type SentenceBookmark, type WordBookmark } from '../src/bookmarks/model.ts'
import { addBookmark, listBookmarks, removeBookmark } from '../src/bookmarks/store.ts'
import { BeadIndex, sentenceCard, type CardBead } from '../src/reader/card.ts'
import type { WordCardView } from '../src/reader/word.ts'
import { openDatabase, type BookmarkRow, type InterlinearDB } from '../src/store/db.ts'

const bead = (de: number[], en: number[], confidence = 0.99): CardBead => ({ deSentenceIdx: de, enSentenceIdx: en, confidence })
// German 0..4 against English 0..3: a 2-1 bead, a 1-0 bead, a sentence in no bead.
const beads = new BeadIndex([bead([0], [0]), bead([2, 1], [1]), bead([3], []), bead([4], [2, 3], 0.5)])
const de = new Map([
  [0, 'Als Gregor Samsa erwachte.'],
  [1, 'Er lag auf dem Rücken.'],
  [2, 'Er sah seinen Bauch.'],
  [3, 'Was ist geschehen?'],
  [4, 'Es war kein Traum.'],
  [9, 'Ohne Bead.'],
])
const en = new Map([
  [0, 'One morning Gregor Samsa woke.'],
  [1, 'He lay on his back and saw his belly.'],
  [2, 'It was'],
  [3, 'no dream.'],
])
const text = (i: number) => de.get(i)
const translation = (i: number) => en.get(i)
const place = { chapter: 2, heading: 'Erstes Kapitel' }

const view: WordCardView = {
  word: 'rücken',
  lemma: 'Rücken',
  entries: [{ lemma: 'Rücken', articles: [{ text: 'der', gender: 'm' }], pos: 'noun', note: '', plural: 'Rücken', glosses: ['back'], src: 'wikt' }],
  via: '',
  sources: 'Wiktionary',
  alternatives: [{ index: 1, lemma: 'rücken', articles: [], pos: 'verb', gloss: 'to move' }],
}
const word = { sentence: 1, offset: 15, token: 'Rücken' }

describe('sentenceBookmark', () => {
  it('records the bead, both texts joined in order, and the place', () => {
    const card = sentenceCard(beads, 1)
    expect(sentenceBookmark(card, text, translation, place)).toEqual<SentenceBookmark>({
      sentences: [1, 2],
      translation: [1],
      text: 'Er lag auf dem Rücken. Er sah seinen Bauch.',
      translationText: 'He lay on his back and saw his belly.',
      chapter: 2,
      heading: 'Erstes Kapitel',
    })
  })

  it('leaves the translation empty for an unmatched bead and a sentence in no bead', () => {
    expect(sentenceBookmark(sentenceCard(beads, 3), text, translation, place)).toMatchObject({ sentences: [3], translation: [], text: 'Was ist geschehen?', translationText: '' })
    expect(sentenceBookmark(sentenceCard(beads, 9), text, translation, place)).toMatchObject({ sentences: [9], translation: [], text: 'Ohne Bead.', translationText: '' })
  })

  it('skips sentences whose text is gone rather than writing "undefined"', () => {
    expect(sentenceBookmark(sentenceCard(beads, 4), text, () => undefined, place).translationText).toBe('')
    expect(sentenceBookmark(sentenceCard(beads, 4), text, translation, place).translationText).toBe('It was no dream.')
  })
})

describe('wordBookmark', () => {
  it('records the word as tapped, the headword shown, and its sentence with the translation', () => {
    expect(wordBookmark(word, view, de.get(1)!, en.get(1)!, place)).toEqual<WordBookmark>({
      word: { sentence: 1, offset: 15, token: 'Rücken' },
      lemma: 'Rücken',
      entries: view.entries,
      sentenceText: 'Er lag auf dem Rücken.',
      translationText: 'He lay on his back and saw his belly.',
      chapter: 2,
      heading: 'Erstes Kapitel',
    })
  })

  it('records a word the dictionary lacks with no headword', () => {
    const b = wordBookmark({ sentence: 3, offset: 0, token: 'Was' }, null, 'Was ist geschehen?', '', place)
    expect(b.lemma).toBeNull()
    expect(b.entries).toEqual([])
    expect(b.translationText).toBe('')
  })
})

describe('finding the bookmark a card is on', () => {
  const rows: BookmarkRow[] = [
    { id: 's', bookId: 'b', note: '', created: 1, type: 'sentence', payload: sentenceBookmark(sentenceCard(beads, 1), text, translation, place) },
    { id: 'w', bookId: 'b', note: '', created: 2, type: 'word', payload: wordBookmark(word, view, de.get(1)!, en.get(1)!, place) },
  ]

  it('finds a sentence bookmark from any sentence of its bead, and from nothing else', () => {
    expect(findSentenceBookmark(rows, [1, 2])?.id).toBe('s')
    expect(findSentenceBookmark(rows, [2])?.id).toBe('s')
    expect(findSentenceBookmark(rows, [0])).toBeUndefined()
    expect(findSentenceBookmark(rows, [])).toBeUndefined()
  })

  it('finds a word bookmark by sentence and offset only', () => {
    expect(findWordBookmark(rows, word)?.id).toBe('w')
    expect(findWordBookmark(rows, { ...word, token: 'rücken' })?.id).toBe('w')
    expect(findWordBookmark(rows, { ...word, offset: 3 })).toBeUndefined()
    expect(findWordBookmark(rows, { ...word, sentence: 2 })).toBeUndefined()
  })

  it('never confuses the two kinds', () => {
    // The word bookmark is in sentence 1, which the sentence bookmark covers; each finder sees only its kind.
    expect(findSentenceBookmark([rows[1]], [1])).toBeUndefined()
    expect(findWordBookmark([rows[0]], { sentence: 1, offset: 0, token: 'Er' })).toBeUndefined()
  })
})

describe('store', () => {
  let db: InterlinearDB
  let n = 0
  beforeEach(() => {
    db = openDatabase(`bookmarks-${n++}`)
  })
  afterEach(async () => {
    await db.delete()
  })

  it('adds, lists oldest first per book, and removes', async () => {
    const s = await addBookmark('a', { type: 'sentence', payload: sentenceBookmark(sentenceCard(beads, 1), text, translation, place) }, db)
    const w = await addBookmark('a', { type: 'word', payload: wordBookmark(word, view, de.get(1)!, en.get(1)!, place) }, db)
    await addBookmark('other', { type: 'sentence', payload: sentenceBookmark(sentenceCard(beads, 0), text, translation, place) }, db)
    expect(s.note).toBe('')
    expect(s.created).toBeLessThanOrEqual(w.created)

    const rows = await listBookmarks('a', db)
    expect(rows.map((r) => r.id)).toEqual([s.id, w.id])
    expect(rows[0].type).toBe('sentence')
    expect(rows[1].type === 'word' && rows[1].payload.lemma).toBe('Rücken')
    expect(findSentenceBookmark(rows, [2])?.id).toBe(s.id)

    await removeBookmark(s.id, db)
    expect((await listBookmarks('a', db)).map((r) => r.id)).toEqual([w.id])
    expect(await db.bookmarks.count()).toBe(2)
  })

  it('survives reopening', async () => {
    const w = await addBookmark('a', { type: 'word', payload: wordBookmark(word, view, de.get(1)!, en.get(1)!, place) }, db)
    const name = db.name
    db.close()
    const reopened = openDatabase(name)
    const rows = await listBookmarks('a', reopened)
    expect(rows).toEqual([w])
    reopened.close()
    db = openDatabase(name)
  })
})
