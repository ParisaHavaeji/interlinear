import { describe, expect, it } from 'vitest'
import { decodeTxt, normaliseText, parseTxt, parseTxtFile } from '../src/import/txt.ts'

describe('normaliseText', () => {
  it('strips a leading BOM', () => {
    expect(normaliseText('\uFEFFHallo')).toBe('Hallo')
  })

  it('leaves a BOM that is not at the start alone', () => {
    expect(normaliseText('a\uFEFFb')).toBe('a\uFEFFb')
  })

  it('normalises CRLF and bare CR to LF', () => {
    expect(normaliseText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })
})

describe('parseTxt', () => {
  it('splits on blank lines and joins wrapped lines with a space', () => {
    const text = 'Als Gregor Samsa eines Morgens\nerwachte, fand er sich.\n\nZweiter Absatz.'
    expect(parseTxt(text)).toEqual([
      { idx: 0, text: 'Als Gregor Samsa eines Morgens erwachte, fand er sich.' },
      { idx: 1, text: 'Zweiter Absatz.' },
    ])
  })

  it('treats whitespace-only lines as blank and ignores multiple blank lines', () => {
    const text = 'Eins\n   \n\t\n\n\nZwei\n \nDrei'
    expect(parseTxt(text).map((p) => p.text)).toEqual(['Eins', 'Zwei', 'Drei'])
  })

  it('handles CRLF input with a BOM', () => {
    const text = '\uFEFFEins\r\n\r\nZwei\r\nzwei\r\n'
    expect(parseTxt(text).map((p) => p.text)).toEqual(['Eins', 'Zwei zwei'])
  })

  it('collapses runs of spaces, tabs and NBSP inside a paragraph', () => {
    expect(parseTxt('a  b\tc\u00a0 d')).toEqual([{ idx: 0, text: 'a b c d' }])
  })

  it('trims leading and trailing whitespace and drops empty output', () => {
    expect(parseTxt('\n\n  \n')).toEqual([])
    expect(parseTxt('   Hallo   \n\n')).toEqual([{ idx: 0, text: 'Hallo' }])
  })

  it('keeps display punctuation untouched (curly quotes, dashes, ß)', () => {
    const text = '„Guten Tag“, sagte er – »wirklich« – und ließ…'
    expect(parseTxt(text)[0].text).toBe(text)
  })

  it('falls back to one paragraph per line when the file has no blank lines', () => {
    const text = 'Erster Absatz.\nZweiter Absatz.\nDritter Absatz.\n'
    expect(parseTxt(text).map((p) => p.text)).toEqual([
      'Erster Absatz.',
      'Zweiter Absatz.',
      'Dritter Absatz.',
    ])
  })

  it('does not apply the per-line fallback to a single wrapped paragraph', () => {
    expect(parseTxt('nur ein\nAbsatz')).toEqual([{ idx: 0, text: 'nur ein Absatz' }])
  })

  it('numbers paragraphs consecutively', () => {
    const ps = parseTxt('a\n\nb\n\n\n\nc')
    expect(ps.map((p) => p.idx)).toEqual([0, 1, 2])
  })
})

describe('decodeTxt', () => {
  it('decodes UTF-8 by default', () => {
    const bytes = new TextEncoder().encode('Straße')
    expect(decodeTxt(bytes)).toBe('Straße')
    expect(decodeTxt(bytes.buffer)).toBe('Straße')
  })

  it('decodes UTF-16 LE and BE when a BOM is present, consuming the BOM', () => {
    const le = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00])
    const be = new Uint8Array([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69])
    expect(decodeTxt(le)).toBe('Hi')
    expect(decodeTxt(be)).toBe('Hi')
    expect(parseTxt(decodeTxt(le))).toEqual([{ idx: 0, text: 'Hi' }])
  })

  it('consumes a UTF-8 BOM too', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x48, 0x69])
    expect(decodeTxt(bytes)).toBe('Hi')
  })
})

describe('parseTxtFile', () => {
  it('reads a Blob end to end', async () => {
    const blob = new Blob(['\uFEFFEins\r\n\r\nZwei'], { type: 'text/plain' })
    expect((await parseTxtFile(blob)).map((p) => p.text)).toEqual(['Eins', 'Zwei'])
  })
})
