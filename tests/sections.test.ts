import { describe, expect, it } from 'vitest'
import type { Block } from '../src/import/markup.ts'
import { assignKinds, countWords, isBodySection, isHeadingLine, splitHeading } from '../src/import/sections.ts'
import type { Paragraph, Section } from '../src/import/types.ts'

const block = (text: string, cls = ''): Block => ({ tag: 'p', cls, text })
const prose = 'Es war einmal ein Satz, der lang genug war, um als Fließtext zu gelten.'
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

describe('isHeadingLine', () => {
  it('accepts short unpunctuated lines and chapter labels', () => {
    for (const t of ['Zwei Welten', 'TWO WORLDS', 'CHAPTER ONE', 'Kapitel 3', 'Kapitel 3.', 'II.', 'XIV', '7', 'Erstes Kapitel']) {
      expect(isHeadingLine(t), t).toBe(true)
    }
  })

  it('accepts all-capitals lines with a trailing period and dated letter headings', () => {
    for (const t of ['THE EDITOR TO THE READER.', 'MAY 4.', 'BOOK II.', 'JANUARY 8, 1772.', 'Am 4. Mai 1771', 'Den 17. Mai', 'May 4.', '4th May, 1771', 'Abends', 'The same evening.']) {
      expect(isHeadingLine(t), t).toBe(true)
    }
  })

  it('rejects prose, dialogue and long lines', () => {
    for (const t of [prose, 'Ja.', 'NEIN!', 'A.', '»Komm!«', '“Really and truly?”', 'Warum war das so sehr schwer?', 'a'.repeat(61), 'Am 4. Mai ging er fort.']) {
      expect(isHeadingLine(t), t).toBe(false)
    }
  })
})

describe('splitHeading', () => {
  it('joins consecutive heading lines with ": " and removes them from the body', () => {
    const { heading, body } = splitHeading([block('CHAPTER ONE'), block('TWO WORLDS'), block(prose)])
    expect(heading).toBe('CHAPTER ONE: TWO WORLDS')
    expect(body.map((b) => b.text)).toEqual([prose])
  })

  it('returns no heading when the first block is prose', () => {
    expect(splitHeading([block(prose), block('Short')])).toEqual({ heading: null, body: [block(prose), block('Short')] })
  })

  it('takes at most three lines and always leaves one block behind', () => {
    const lines = ['A', 'B', 'C', 'D', 'E'].map((t) => block(t))
    const r = splitHeading(lines)
    expect(r.heading).toBe('A: B: C')
    expect(r.body.map((b) => b.text)).toEqual(['D', 'E'])
    expect(splitHeading([block('Only')])).toEqual({ heading: null, body: [block('Only')] })
    expect(splitHeading([block('A'), block('B')]).heading).toBe('A')
  })
})

describe('isBodySection', () => {
  const paras = (n: number): Paragraph[] => [{ idx: 0, text: words(n) }]

  it('is false for an empty section', () => {
    expect(isBodySection(null, null, [], [], 0)).toBe(false)
  })

  it('follows class-name hints on the leading blocks before anything else', () => {
    const fm = [block('Introduction', 'x01-FM-Head'), block(words(300), 'x04-Body-Text')]
    expect(isBodySection('Introduction', null, fm, paras(300), 300)).toBe(false)
    const bm = [block(words(300), 'x13-BM-Biblio')]
    expect(isBodySection(null, null, bm, paras(300), 300)).toBe(false)
    const co = [block(words(50), 'x03-CO-Body-Text')]
    expect(isBodySection(null, 'Preface', co, paras(50), 50)).toBe(true)
    const ch = [block('CHAPTER ONE', 'x03-Chapter-Number'), block(words(10), 'x04-Body-Text')]
    expect(isBodySection('CHAPTER ONE', null, ch, paras(10), 10)).toBe(true)
  })

  it('does not mistake unrelated class names for hints', () => {
    const blocks = [block('Kain', 'calibre5'), block(words(300), 'calibre2')]
    expect(isBodySection('Kain', null, blocks, paras(300), 300)).toBe(true)
  })

  it('treats matter keywords in the heading, nav title or a short first paragraph as matter', () => {
    const blocks = [block(words(300))]
    expect(isBodySection('Introduction', null, blocks, paras(300), 300)).toBe(false)
    expect(isBodySection('Vorwort', null, blocks, paras(300), 300)).toBe(false)
    expect(isBodySection(null, 'Suggestions for Further Reading', blocks, paras(300), 300)).toBe(false)
    expect(isBodySection(null, null, blocks, [{ idx: 0, text: 'Inhalt' }, { idx: 1, text: words(300) }], 301)).toBe(false)
    expect(isBodySection(null, 'Preface', blocks, paras(300), 300)).toBe(true)
    expect(isBodySection(null, 'Prologue', blocks, paras(300), 300)).toBe(true)
  })

  it('treats short sections with copyright boilerplate as matter, but not long chapters', () => {
    const copy = [{ idx: 0, text: 'Copyright © 1919 by S. Fischer Verlag. ISBN 978-3-518-0.' }, { idx: 1, text: words(190) }]
    expect(isBodySection(null, null, [block(copy[0].text)], copy, 200), 'short').toBe(false)
    const long = [{ idx: 0, text: words(1600) }, { idx: 1, text: 'The copyright in this novel is mine.' }]
    expect(isBodySection(null, null, [block(long[0].text)], long, 1607), 'long').toBe(true)
  })

  it('falls back to length: 200 words or more is body', () => {
    expect(isBodySection(null, null, [block(words(199))], paras(199), 199)).toBe(false)
    expect(isBodySection(null, null, [block(words(200))], paras(200), 200)).toBe(true)
  })
})

describe('assignKinds', () => {
  const section = (idx: number): Section => ({
    idx, href: `${idx}.xhtml`, title: null, heading: null, kind: 'front', linear: true, paragraphs: [], words: 0,
  })

  it('labels matter before the first body section front and after the last one back', () => {
    const sections = [0, 1, 2, 3, 4, 5].map(section)
    assignKinds(sections, [false, false, true, false, true, false])
    expect(sections.map((s) => s.kind)).toEqual(['front', 'front', 'body', 'front', 'body', 'back'])
  })

  it('makes a book with no body section all front matter', () => {
    const sections = [0, 1].map(section)
    assignKinds(sections, [false, false])
    expect(sections.map((s) => s.kind)).toEqual(['front', 'front'])
  })
})

describe('countWords', () => {
  it('counts space-separated tokens across paragraphs', () => {
    expect(countWords([{ text: 'a b c' }, { text: 'd' }])).toBe(4)
    expect(countWords([])).toBe(0)
  })
})
