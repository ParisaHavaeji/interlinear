import { describe, expect, it } from 'vitest'
import { FIXTURES, gutenbergUrl, joinParts, stripGutenberg } from '../tools/gutenberg.ts'

const wrap = (body: string, { credits = '', note = '' } = {}) =>
  [
    'The Project Gutenberg eBook of Example',
    '',
    'Title: Example',
    '',
    '*** START OF THE PROJECT GUTENBERG EBOOK EXAMPLE ***',
    '',
    credits,
    '',
    body,
    '',
    note,
    '',
    '*** END OF THE PROJECT GUTENBERG EBOOK EXAMPLE ***',
    '',
    'START: FULL LICENSE',
  ].join('\n')

describe('stripGutenberg', () => {
  it('keeps only the text between the START and END markers', () => {
    const out = stripGutenberg(wrap('I.\n\nErster Satz.\nZweiter Satz.'))
    expect(out).toBe('I.\n\nErster Satz.\nZweiter Satz.\n')
  })

  it('drops a transcriber credit paragraph at the top', () => {
    const out = stripGutenberg(
      wrap('I.\n\nText.', { credits: 'Produced by Someone and the Online\nDistributed Proofreading Team' }),
    )
    expect(out).toBe('I.\n\nText.\n')
  })

  it('drops a closing "end of this e-text" note in German or English', () => {
    const de = stripGutenberg(wrap('Text.', { note: 'Ende dieses Projekt Gutenberg Etextes "Beispiel"\nvon Jemand.' }))
    expect(de).toBe('Text.\n')
    const en = stripGutenberg(wrap('Text.', { note: 'End of the Project Gutenberg EBook of Example' }))
    expect(en).toBe('Text.\n')
  })

  it('cuts the title page away with startAt and keeps everything from the match on', () => {
    const out = stripGutenberg(wrap('  DIE VERWANDLUNG\n\n  VON\n\n  FRANZ KAFKA\n\n\nI.\n\nAls Gregor.'), {
      startAt: /^I\.$/,
    })
    expect(out).toBe('I.\n\nAls Gregor.\n')
  })

  it('matches startAt against the trimmed line but keeps the line itself intact', () => {
    const out = stripGutenberg(wrap('Titel\n\n   Erstes Buch   \n\nAm 4. Mai'), { startAt: /^Erstes Buch$/ })
    expect(out).toBe('   Erstes Buch\n\nAm 4. Mai\n')
  })

  it('normalises BOM and CRLF and trims trailing whitespace per line', () => {
    const raw = '﻿' + wrap('I.  \n\nText. ').replace(/\n/g, '\r\n')
    expect(stripGutenberg(raw)).toBe('I.\n\nText.\n')
  })

  it('keeps blank-line runs inside the body', () => {
    const out = stripGutenberg(wrap('I.\n\n\n\nText.\n\n\nII.\n\nMore.'))
    expect(out).toBe('I.\n\n\n\nText.\n\n\nII.\n\nMore.\n')
  })

  it('throws when markers are missing, out of order, or startAt does not match', () => {
    expect(() => stripGutenberg('no markers here')).toThrow(/START/)
    expect(() => stripGutenberg('*** START OF THE PROJECT GUTENBERG EBOOK X ***\nText')).toThrow(/END/)
    expect(() =>
      stripGutenberg('*** END OF THE PROJECT GUTENBERG EBOOK X ***\n*** START OF THE PROJECT GUTENBERG EBOOK X ***'),
    ).toThrow(/precedes/)
    expect(() => stripGutenberg(wrap('Text.'), { startAt: /^Nope$/ })).toThrow(/startAt/)
  })
})

describe('joinParts', () => {
  it('separates volumes with a wide gap and ends with one newline', () => {
    expect(joinParts(['Erstes Buch\n\nA.\n', 'Zweites Buch\n\nB.\n'])).toBe('Erstes Buch\n\nA.\n\n\nZweites Buch\n\nB.\n')
  })
})

describe('manifest', () => {
  it('builds the plain-text download URL', () => {
    expect(gutenbergUrl(22367)).toBe('https://www.gutenberg.org/cache/epub/22367/pg22367.txt')
  })

  it('lists both pairs with a de and an en side each', () => {
    const stems = new Map<string, Set<string>>()
    for (const f of FIXTURES) {
      const [stem, lang] = f.file.replace(/\.txt$/, '').split('.')
      expect(lang).toBe(f.lang)
      stems.set(stem!, (stems.get(stem!) ?? new Set()).add(lang!))
    }
    expect([...stems.keys()].sort()).toEqual(['goethe-werther', 'kafka-verwandlung'])
    for (const langs of stems.values()) expect([...langs].sort()).toEqual(['de', 'en'])
  })
})
