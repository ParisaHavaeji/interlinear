// Bookmark export (plan.md step 27): the JSON, Markdown and Anki files built from the grouped rows.
import { describe, expect, it } from 'vitest'
import { ankiField, ankiNote, ANKI_HEADER, bookmarksExport, bookmarksJson, bookmarksMarkdown, bookmarksTsv, exportBookmarks, exportFileName, wordFront, wordGlosses } from '../src/bookmarks/export.ts'
import type { BookmarkGroup } from '../src/bookmarks/list.ts'
import type { WordBookmark } from '../src/bookmarks/model.ts'
import type { Book, BookmarkRow } from '../src/store/db.ts'

const book = (id: string, title: string, author: string): Book => ({
  id,
  title,
  author,
  langs: ['de', 'en'],
  created: 0,
  cover: { hue: 0, hue2: 0 },
  sources: { de: { fileName: '', format: 'txt', paragraphs: 0, words: 0, sections: [] }, en: { fileName: '', format: 'txt', paragraphs: 0, words: 0, sections: [] } },
})

const sentence = (id: string, text: string, translationText: string, heading = 'I.'): BookmarkRow => ({
  id,
  bookId: 'k',
  note: '',
  created: 1_700_000_000_000,
  type: 'sentence',
  payload: { sentences: [1], translation: [1], text, translationText, chapter: 0, heading },
})

const ruecken: WordBookmark = {
  word: { sentence: 1, offset: 15, token: 'Rücken' },
  lemma: 'Rücken',
  entries: [
    { lemma: 'Rücken', articles: [{ text: 'der', gender: 'm' }], pos: 'noun', note: '', plural: 'Rücken', glosses: ['back', 'spine'], src: 'wikt' },
    { lemma: 'Rücken', articles: [], pos: 'verb', note: '', plural: null, glosses: ['to move'], src: 'freedict' },
  ],
  sentenceText: 'Er lag auf dem Rücken.',
  translationText: 'He lay on his back.',
  chapter: 0,
  heading: 'I.',
}
const word = (id: string, payload: WordBookmark): BookmarkRow => ({ id, bookId: 'k', note: '', created: 1_700_000_000_000, type: 'word', payload })
const noEntry: WordBookmark = { word: { sentence: 3, offset: 0, token: 'Zxq' }, lemma: null, entries: [], sentenceText: 'Zxq!', translationText: '', chapter: 1, heading: 'II.' }

const groups: BookmarkGroup[] = [
  { book: book('k', 'Die Verwandlung', 'Franz Kafka'), rows: [sentence('s1', 'Als Gregor Samsa erwachte.', 'One morning Gregor Samsa woke.'), word('w1', ruecken), word('w2', noEntry)], latest: 3 },
  { book: book('h', 'Demian', ''), rows: [sentence('h1', 'Ohne Übersetzung.', '', '')], latest: 1 },
]
const now = Date.UTC(2026, 10, 11, 12, 0, 0)

describe('JSON', () => {
  it('carries every row under its book, with a format and version, and parses back', () => {
    const out = bookmarksExport(groups, now)
    expect(out.format).toBe('interlinear-bookmarks')
    expect(out.version).toBe(1)
    expect(out.exported).toBe('2026-11-11T12:00:00.000Z')
    expect(out.books.map((b) => [b.id, b.title, b.author, b.bookmarks.length])).toEqual([
      ['k', 'Die Verwandlung', 'Franz Kafka', 3],
      ['h', 'Demian', '', 1],
    ])
    expect(out.books[0].bookmarks[1]).toEqual({ id: 'w1', note: '', created: 1_700_000_000_000, type: 'word', payload: ruecken })
    expect('bookId' in out.books[0].bookmarks[0]).toBe(false)
    expect(JSON.parse(bookmarksJson(groups, now))).toEqual(out)
    expect(bookmarksJson(groups, now).endsWith('}\n')).toBe(true)
  })
})

describe('Markdown', () => {
  it('heads each book and chapter, bolds the German, and lists words with their glosses and sentence', () => {
    expect(bookmarksMarkdown(groups, now)).toBe(
      [
        '# Bookmarks',
        '',
        'Exported 2026-11-11 · 4 bookmarks',
        '',
        '## Die Verwandlung — Franz Kafka',
        '',
        '### I.',
        '',
        '**Als Gregor Samsa erwachte.**  ',
        'One morning Gregor Samsa woke.',
        '',
        '**der Rücken** — back; spine · to move  ',
        '*Er lag auf dem Rücken.*  ',
        'He lay on his back.',
        '',
        '### II.',
        '',
        '**Zxq** — no entry  ',
        '*Zxq!*',
        '',
        '## Demian',
        '',
        '**Ohne Übersetzung.**',
        '',
      ].join('\n'),
    )
  })

  it('writes the headword with every article, or the word as printed', () => {
    expect(wordFront(ruecken)).toBe('der Rücken')
    expect(wordFront({ ...ruecken, entries: [{ ...ruecken.entries[0], articles: [{ text: 'der', gender: 'm' }, { text: 'das', gender: 'n' }] }] })).toBe('der/das Rücken')
    expect(wordFront({ ...ruecken, entries: [ruecken.entries[1]] })).toBe('Rücken')
    expect(wordFront(noEntry)).toBe('Zxq')
    expect(wordGlosses(ruecken)).toBe('back; spine · to move')
    expect(wordGlosses(noEntry)).toBe('')
  })
})

describe('Anki', () => {
  it('writes the header and one German<TAB>English line per bookmark', () => {
    const tsv = bookmarksTsv(groups)
    expect(tsv.startsWith(ANKI_HEADER)).toBe(true)
    const lines = tsv.slice(ANKI_HEADER.length).split('\n')
    expect(lines).toEqual([
      'Als Gregor Samsa erwachte.\tOne morning Gregor Samsa woke.',
      'der Rücken\tback; spine · to move<br><i>Er lag auf dem Rücken.</i><br>He lay on his back.',
      'Zxq\t<i>Zxq!</i>',
      'Ohne Übersetzung.\t',
      '',
    ])
    for (const line of lines.slice(0, -1)) expect(line.split('\t')).toHaveLength(2)
  })

  it('escapes HTML, flattens tabs and line breaks, and quotes fields that hold a quote', () => {
    expect(ankiNote(sentence('s', 'a < b & c', 'x\ty'))).toEqual(['a &lt; b &amp; c', 'x\ty'])
    expect(ankiField('x\ty\nz')).toBe('x y<br>z')
    expect(ankiField('He said "hi"')).toBe('"He said ""hi"""')
    expect(ankiField('plain')).toBe('plain')
    const line = bookmarksTsv([{ ...groups[0], rows: [sentence('q', 'Er sagte "ja".', 'He said "yes".')] }]).split('\n')[2]
    expect(line).toBe('"Er sagte ""ja""."\t"He said ""yes""."')
  })
})

describe('files', () => {
  it('names the file after the format, and after the book when there is one', () => {
    expect(exportFileName('json')).toBe('bookmarks.json')
    expect(exportFileName('markdown', { title: 'Die Verwandlung' })).toBe('bookmarks-die-verwandlung.md')
    expect(exportFileName('anki', { title: '???' })).toBe('bookmarks.tsv')
  })

  it('builds the file with its MIME type', () => {
    const file = exportBookmarks(groups, 'anki', now, { title: 'Demian' })
    expect(file).toMatchObject({ name: 'bookmarks-demian.tsv', type: 'text/tab-separated-values' })
    expect(file.text).toBe(bookmarksTsv(groups))
    expect(exportBookmarks(groups, 'json', now).type).toBe('application/json')
    expect(exportBookmarks(groups, 'markdown', now).name).toBe('bookmarks.md')
  })
})
