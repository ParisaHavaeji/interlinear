// The word card's model (plan.md step 24): articles and their colours, labels, the card view, Copy.
import { describe, expect, it } from 'vitest'
import { INITIAL_DICT_STATE, type DictState } from '../src/dict/download.ts'
import type { DictEntry } from '../src/dict/format.ts'
import type { Headword, LookupResult } from '../src/dict/lookup.ts'
import {
  articleColour,
  articlesOf,
  DEFAULT_ARTICLE_COLOURS,
  dictHint,
  firstGloss,
  lookupErrorMessage,
  MAX_ALTERNATIVES,
  posLabel,
  sameWord,
  sanitizeArticleColours,
  sourcesOf,
  viaNote,
  wordCard,
  wordCopyText,
} from '../src/reader/word.ts'

const entry = (lemma: string, pos: DictEntry['pos'], glosses: string[], extra: Partial<DictEntry> = {}): DictEntry => ({ lemma, pos, glosses, src: 'wikt', ...extra })
const headword = (lemma: string, entries: DictEntry[], via: Headword['via'] = 'exact', extra: Partial<Headword> = {}): Headword => ({ lemma, entries, via, ...extra })
const result = (word: string, headwords: Headword[]): LookupResult => ({ token: word, word, headwords })

const haus = entry('Haus', 'noun', ['house, building', 'home'], { gender: 'n', plural: 'Häuser' })
const tuer = entry('Tür', 'noun', ['door'], { gender: 'f', plural: 'Türen' })

describe('articles', () => {
  it('maps genders to articles, several at once, and nothing for no gender', () => {
    expect(articlesOf('m')).toEqual([{ text: 'der', gender: 'm' }])
    expect(articlesOf('f')).toEqual([{ text: 'die', gender: 'f' }])
    expect(articlesOf('n')).toEqual([{ text: 'das', gender: 'n' }])
    expect(articlesOf('pl')).toEqual([{ text: 'die', gender: 'pl' }])
    expect(articlesOf('m/n')).toEqual([
      { text: 'der', gender: 'm' },
      { text: 'das', gender: 'n' },
    ])
    expect(articlesOf('m/m')).toHaveLength(1)
    expect(articlesOf(undefined)).toEqual([])
    expect(articlesOf('')).toEqual([])
    expect(articlesOf('x')).toEqual([])
  })

  it('colours articles by gender under the reader’s choice, the plural die never', () => {
    expect(articleColour({ text: 'der', gender: 'm' }, DEFAULT_ARTICLE_COLOURS)).toBe('blue')
    expect(articleColour({ text: 'die', gender: 'f' }, DEFAULT_ARTICLE_COLOURS)).toBe('red')
    expect(articleColour({ text: 'das', gender: 'n' }, DEFAULT_ARTICLE_COLOURS)).toBe('green')
    expect(articleColour({ text: 'die', gender: 'pl' }, DEFAULT_ARTICLE_COLOURS)).toBe('none')
    expect(articleColour({ text: 'der', gender: 'm' }, { ...DEFAULT_ARTICLE_COLOURS, m: 'purple' })).toBe('purple')
  })

  it('sanitises a stored colour setting, falling back per article', () => {
    expect(sanitizeArticleColours(undefined)).toEqual(DEFAULT_ARTICLE_COLOURS)
    expect(sanitizeArticleColours('blue')).toEqual(DEFAULT_ARTICLE_COLOURS)
    expect(sanitizeArticleColours({ m: 'teal', f: 'magenta', n: 7 })).toEqual({ m: 'teal', f: 'red', n: 'green' })
    expect(sanitizeArticleColours({ m: 'none', f: 'none', n: 'none' })).toEqual({ m: 'none', f: 'none', n: 'none' })
  })
})

describe('labels', () => {
  it('names parts of speech and sources, leaving FreeDict’s part-less entries blank', () => {
    expect(posLabel('noun')).toBe('noun')
    expect(posLabel('adj')).toBe('adjective')
    expect(posLabel('name')).toBe('proper noun')
    expect(posLabel('other')).toBe('')
    expect(sourcesOf([haus])).toBe('Wiktionary')
    expect(sourcesOf([{ ...haus, src: 'freedict' }])).toBe('FreeDict')
    expect(sourcesOf([haus, { ...tuer, src: 'freedict' }])).toBe('Wiktionary · FreeDict')
    expect(sourcesOf([{ ...haus, src: 'wikt+freedict' }])).toBe('Wiktionary · FreeDict')
    expect(sourcesOf([])).toBe('')
  })

  it('takes the first sense of the first gloss', () => {
    expect(firstGloss([haus])).toBe('house')
    expect(firstGloss([entry('x', 'noun', ['colour; paint'])])).toBe('colour')
    expect(firstGloss([entry('x', 'noun', []), tuer])).toBe('door')
    expect(firstGloss([])).toBe('')
  })

  it('explains an indirect match and says nothing about a direct one', () => {
    expect(viaNote(headword('Haus', [haus]), 'Haus')).toBe('')
    expect(viaNote(headword('Haus', [haus], 'case'), 'haus')).toBe('')
    expect(viaNote(headword('Haus', [haus], 'form'), 'Häusern')).toBe('')
    expect(viaNote(headword('Prokurist', [entry('Prokurist', 'noun', ['signatory'])], 'stem'), 'Prokuristen')).toBe('Best guess from the word’s ending')
    expect(viaNote(headword('anfangen', [entry('anfangen', 'verb', ['to begin'])], 'separable', { particle: 'an' }), 'fing')).toBe('Separable verb: fing … an')
    const compound = headword('Tür', [tuer], 'compound', {
      parts: [
        { text: 'haus', lemma: 'Haus', entries: [haus] },
        { text: 'tür', lemma: 'Tür', entries: [tuer] },
      ],
    })
    expect(viaNote(compound, 'Haustür')).toBe('Compound: Haus (house) + Tür (door)')
  })
})

describe('wordCard', () => {
  const weg = headword('Weg', [entry('Weg', 'noun', ['way, path'], { gender: 'm', plural: 'Wege' })])
  const wegAdv = headword('weg', [entry('weg', 'adv', ['away'])], 'case')
  const lange = headword('Lange', [entry('Lange', 'name', ['a surname'])], 'case')

  it('shows the first headword in full and the rest as alternatives', () => {
    const view = wordCard(result('Weg', [weg, wegAdv, lange]))
    expect(view.word).toBe('Weg')
    expect(view.lemma).toBe('Weg')
    expect(view.entries).toEqual([
      { lemma: 'Weg', articles: [{ text: 'der', gender: 'm' }], pos: 'noun', note: '', plural: 'Wege', glosses: ['way, path'], src: 'wikt' },
    ])
    expect(view.via).toBe('')
    expect(view.sources).toBe('Wiktionary')
    expect(view.alternatives).toEqual([
      { index: 1, lemma: 'weg', articles: [], pos: 'adverb', gloss: 'away' },
      { index: 2, lemma: 'Lange', articles: [], pos: 'proper noun', gloss: 'a surname' },
    ])
  })

  it('switches to the picked headword, clamping the pick', () => {
    const view = wordCard(result('Weg', [weg, wegAdv]), 1)
    expect(view.lemma).toBe('weg')
    expect(view.entries[0].articles).toEqual([])
    expect(view.alternatives.map((a) => a.lemma)).toEqual(['Weg'])
    expect(wordCard(result('Weg', [weg, wegAdv]), 9).lemma).toBe('weg')
    expect(wordCard(result('Weg', [weg, wegAdv]), -3).lemma).toBe('Weg')
  })

  it('marks plural-only nouns and lists every entry of a lemma with glosses', () => {
    const leute = headword('Leute', [entry('Leute', 'noun', ['people'], { gender: 'pl' }), entry('Leute', 'noun', [], { gender: 'pl' })])
    const view = wordCard(result('Leute', [leute]))
    expect(view.entries).toHaveLength(1)
    expect(view.entries[0].note).toBe('plural')
    expect(view.entries[0].articles).toEqual([{ text: 'die', gender: 'pl' }])
  })

  it('has no headword for an empty result or one with no glosses, and caps the alternatives', () => {
    expect(wordCard(result('Xyz', []))).toEqual({ word: 'Xyz', lemma: null, entries: [], via: '', sources: '', alternatives: [] })
    expect(wordCard(result('Xyz', [headword('Xyz', [entry('Xyz', 'noun', [])])])).lemma).toBeNull()
    const many = Array.from({ length: 8 }, (_, i) => headword(`w${i}`, [entry(`w${i}`, 'noun', [`g${i}`])]))
    expect(wordCard(result('w', many)).alternatives).toHaveLength(MAX_ALTERNATIVES)
  })

  it('writes the Copy text as article, lemma, details and glosses, or the word alone', () => {
    const view = wordCard(result('Häusern', [headword('Haus', [haus], 'form'), weg]))
    expect(wordCopyText(view, 'Häusern')).toBe('das Haus (noun, pl. Häuser): house, building; home')
    expect(wordCopyText(wordCard(result('weg', [wegAdv])), 'weg')).toBe('weg (adverb): away')
    expect(wordCopyText(wordCard(result('Xyz', [])), 'Xyz')).toBe('Xyz')
    const two = wordCard(result('Weg', [headword('Weg', [entry('Weg', 'noun', ['way'], { gender: 'm' }), entry('Weg', 'other', ['path'], { src: 'freedict' })])]))
    expect(wordCopyText(two, 'Weg')).toBe('der Weg (noun): way\nWeg: path')
  })
})

describe('hints', () => {
  it('explains a missing entry by the dictionary’s state, nothing when it is complete', () => {
    const state = (phase: DictState['phase']): DictState => ({ ...INITIAL_DICT_STATE, phase })
    expect(dictHint(state('ready'))).toBe('')
    expect(dictHint(state('checking'))).toBe('')
    expect(dictHint({ ...state('downloading'), progress: { doneShards: 1, totalShards: 4, doneBytes: 430, totalBytes: 1000 } })).toBe('The dictionary is still downloading (43%).')
    expect(dictHint(state('waiting'))).toMatch(/not fully downloaded/)
    expect(dictHint(state('failed'))).toMatch(/could not be downloaded/)
    expect(dictHint(state('unavailable'))).toMatch(/could not be downloaded/)
  })

  it('words a failed lookup by whether the device is online', () => {
    expect(lookupErrorMessage(new Error('Failed to fetch'), false)).toMatch(/not on the device yet/)
    expect(lookupErrorMessage(new Error('HTTP 500'), true)).toBe('Could not read the dictionary: HTTP 500')
  })

  it('compares word references by place and text', () => {
    const a = { sentence: 3, offset: 10, token: 'Haus' }
    expect(sameWord(a, { ...a })).toBe(true)
    expect(sameWord(a, { ...a, offset: 11 })).toBe(false)
    expect(sameWord(a, null)).toBe(false)
    expect(sameWord(null, null)).toBe(true)
  })
})
