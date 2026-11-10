import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isAbbreviation, splitParagraphs, splitSentences, type Sentence } from '../src/align/sentences.ts'
import { parseTxt } from '../src/import/txt.ts'
import type { Lang, Paragraph } from '../src/import/types.ts'

const read = (file: string) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')
const texts = (s: Sentence[]) => s.map((x) => x.text)
const de = (text: string) => texts(splitSentences(text, 'de'))
const en = (text: string) => texts(splitSentences(text, 'en'))

/** Every sentence's offsets point at its own text, sentences are in order and never overlap. */
function expectOffsetsConsistent(text: string, sentences: Sentence[]): void {
  let last = 0
  for (const s of sentences) {
    expect(s.charStart).toBeGreaterThanOrEqual(last)
    expect(s.charEnd).toBeGreaterThan(s.charStart)
    expect(text.slice(s.charStart, s.charEnd)).toBe(s.text)
    expect(s.text).toBe(s.text.trim())
    last = s.charEnd
  }
}

/** The gaps between sentences hold only whitespace and dashes: no letter or digit is lost. */
function expectNothingDropped(text: string, sentences: Sentence[]): void {
  let covered = ''
  let pos = 0
  for (const s of sentences) {
    covered += text.slice(pos, s.charStart)
    pos = s.charEnd
  }
  covered += text.slice(pos)
  expect(covered.replace(/[\s\-—–]/gu, '')).toBe('')
}

describe('splitSentences: basics', () => {
  it('splits on . ! ? with offsets into the paragraph', () => {
    const text = 'Gregor erwachte. Was war geschehen? Ein Traum war es nicht!'
    const s = splitSentences(text, 'de')
    expect(texts(s)).toEqual(['Gregor erwachte.', 'Was war geschehen?', 'Ein Traum war es nicht!'])
    expect(s.map((x) => [x.charStart, x.charEnd])).toEqual([
      [0, 16],
      [17, 35],
      [36, 59],
    ])
    expectOffsetsConsistent(text, s)
  })

  it('treats a run of marks as one terminal', () => {
    expect(de('Was?! Nein!! Doch...')).toEqual(['Was?!', 'Nein!!', 'Doch...'])
  })

  it('returns text without a terminal mark as one sentence', () => {
    expect(de('Zwei Welten')).toEqual(['Zwei Welten'])
    expect(de('Er sagte, dass')).toEqual(['Er sagte, dass'])
  })

  it('returns nothing for blank text', () => {
    expect(splitSentences('', 'de')).toEqual([])
    expect(splitSentences('   ', 'en')).toEqual([])
  })

  it('keeps a trailing fragment without terminal mark as a sentence', () => {
    expect(en('He left. She stayed, and then')).toEqual(['He left.', 'She stayed, and then'])
  })

  it('trims surrounding whitespace into the offsets rather than the text', () => {
    const text = '  Er ging.  Sie blieb.  '
    const s = splitSentences(text, 'de')
    expect(texts(s)).toEqual(['Er ging.', 'Sie blieb.'])
    expect(s[0].charStart).toBe(2)
    expectOffsetsConsistent(text, s)
  })
})

describe('splitSentences: quotes', () => {
  it('keeps German »…« closers with the sentence and does not break before a lowercase tail', () => {
    expect(de('»Was ist mit mir geschehen?« dachte er. Es war kein Traum.')).toEqual([
      '»Was ist mit mir geschehen?« dachte er.',
      'Es war kein Traum.',
    ])
  })

  it('breaks after a closer when a capital follows', () => {
    expect(de('»Es ist dreiviertel sieben.« Und er machte sich daran aufzustehen.')).toEqual([
      '»Es ist dreiviertel sieben.«',
      'Und er machte sich daran aufzustehen.',
    ])
  })

  it('handles German „…“ where the closer is the English opener character', () => {
    expect(de('„Es ist sieben.“ Dann ging er. „Komm!“ rief sie.')).toEqual(['„Es ist sieben.“', 'Dann ging er.', '„Komm!“ rief sie.'])
  })

  it('handles English curly quotes and a period after the closing quote', () => {
    expect(en('He said “Good morning, Mr. Samsa”. “He isn’t well.” Then he left.')).toEqual([
      'He said “Good morning, Mr. Samsa”.',
      '“He isn’t well.”',
      'Then he left.',
    ])
  })

  it('handles straight quotes with a lowercase speech tag', () => {
    expect(en('"Oh, sir!" she exclaimed. "Why?" said I. She laughed.')).toEqual(['"Oh, sir!" she exclaimed.', '"Why?" said I.', 'She laughed.'])
  })

  it('does not break on a terminal mark inside a quotation that continues in lowercase', () => {
    expect(en('“Oh, God”, he thought, “what a career! Travelling every day.” He sighed.')).toEqual([
      '“Oh, God”, he thought, “what a career!',
      'Travelling every day.”',
      'He sighed.',
    ])
  })

  it('keeps brackets with the sentence', () => {
    expect(de('Er ging (endlich). (Sie blieb.) Dann kam sie.')).toEqual(['Er ging (endlich).', '(Sie blieb.)', 'Dann kam sie.'])
  })
})

describe('splitSentences: dashes and ellipses', () => {
  it('treats a double hyphen between sentences as a separator belonging to neither', () => {
    const text = `Verdruß gehabt?"--"Ich?" sagt' ich.--"Der Graf hat mich gefragt."`
    const s = splitSentences(text, 'de')
    expect(texts(s)).toEqual(['Verdruß gehabt?"', `"Ich?" sagt' ich.`, '"Der Graf hat mich gefragt."'])
    expectOffsetsConsistent(text, s)
    expectNothingDropped(text, s)
  })

  it('treats an em dash after a terminal mark the same way', () => {
    expect(en('Grete! Grete!” she cried.—“Mother?” He waited. — Nothing.')).toEqual(['Grete!', 'Grete!” she cried.', '“Mother?”', 'He waited.', 'Nothing.'])
  })

  it('does not break at a dash without a terminal mark before it', () => {
    expect(en('“Gregor”, somebody called—it was his mother—“it’s quarter to seven.”')).toEqual([
      '“Gregor”, somebody called—it was his mother—“it’s quarter to seven.”',
    ])
    expect(de('Es klopfte -- es war die Mutter --, »es ist sieben.«')).toEqual(['Es klopfte -- es war die Mutter --, »es ist sieben.«'])
  })

  it('drops a trailing separator instead of making it a sentence', () => {
    const text = 'Er ging.--'
    const s = splitSentences(text, 'de')
    expect(texts(s)).toEqual(['Er ging.'])
    expectNothingDropped(text, s)
  })

  it('breaks after an ellipsis only when a capital follows', () => {
    expect(de('Ich weiß nicht… vielleicht morgen. Dann ging er.')).toEqual(['Ich weiß nicht… vielleicht morgen.', 'Dann ging er.'])
    expect(de('Er zögerte... Dann ging er.')).toEqual(['Er zögerte...', 'Dann ging er.'])
    expect(en('Then . . . He left.')).toEqual(['Then . . .', 'He left.'])
  })
})

describe('splitSentences: abbreviations and numbers', () => {
  it('knows German abbreviations and spaced ones made of single letters', () => {
    expect(de('Das gilt z. B. für Häuser, vgl. Nr. 5 und Dr. Müller, d. h. alle. Dann kam er.')).toEqual([
      'Das gilt z. B. für Häuser, vgl. Nr. 5 und Dr. Müller, d. h. alle.',
      'Dann kam er.',
    ])
    expect(de('Siehe S. 12 bzw. Kap. 3 u. a. Dort steht es.')).toEqual(['Siehe S. 12 bzw. Kap. 3 u. a. Dort steht es.'])
  })

  it('knows English titles and reference abbreviations', () => {
    expect(en('Mr. Samsa met Dr. Brown at St. Paul’s on Sept. 4. Then they left.')).toEqual([
      'Mr. Samsa met Dr. Brown at St. Paul’s on Sept. 4.',
      'Then they left.',
    ])
    expect(en('See vol. 2, ch. 3, pp. 4 ff. The rest follows.')).toEqual(['See vol. 2, ch. 3, pp. 4 ff.', 'The rest follows.'])
  })

  it('lets etc. and usw. end a sentence', () => {
    expect(en('They brought bread, wine, etc. My friend laughed.')).toEqual(['They brought bread, wine, etc.', 'My friend laughed.'])
    expect(de('Er brachte Brot, Wein usw. Dann lachte er.')).toEqual(['Er brachte Brot, Wein usw.', 'Dann lachte er.'])
  })

  it('does not break after initials but does after the English pronoun I', () => {
    expect(de('Ein gewisser N. N. kam vorbei. Ein junger V. Auch er ging.')).toEqual(['Ein gewisser N. N. kam vorbei.', 'Ein junger V. Auch er ging.'])
    expect(en('So did I. Then we left. Mr. J. R. Smith came.')).toEqual(['So did I.', 'Then we left.', 'Mr. J. R. Smith came.'])
  })

  it('treats one- and two-digit numbers with a period as ordinals in German only', () => {
    expect(de('Am 4. Mai kam er. Im 18. Jahrhundert war der 2. Stock teuer. Es geschah 1771. Dann kam der Krieg.')).toEqual([
      'Am 4. Mai kam er.',
      'Im 18. Jahrhundert war der 2. Stock teuer.',
      'Es geschah 1771.',
      'Dann kam der Krieg.',
    ])
    expect(en('He was 4. Then he was 5. It was 1771. War came.')).toEqual(['He was 4.', 'Then he was 5.', 'It was 1771.', 'War came.'])
  })

  it('does not split inside numbers or domains', () => {
    expect(de('Es kostete 3.000 Taler, also 1.5 mehr als www.beispiel.de verlangt. Dann ging er.')).toEqual([
      'Es kostete 3.000 Taler, also 1.5 mehr als www.beispiel.de verlangt.',
      'Dann ging er.',
    ])
  })

  it('treats No. as an abbreviation only before a number', () => {
    expect(en('See No. 5 on the list. He said no. Then he left.')).toEqual(['See No. 5 on the list.', 'He said no.', 'Then he left.'])
  })

  it('lets a closing quote right after an abbreviation end the sentence', () => {
    expect(en('He only ever said "Mr." The rest he swallowed.')).toEqual(['He only ever said "Mr."', 'The rest he swallowed.'])
  })

  it('exposes the abbreviation test', () => {
    const t = 'Dr. Who'
    expect(isAbbreviation(t, 2, 4, 'en')).toBe(true)
    expect(isAbbreviation('said I. She', 6, 8, 'en')).toBe(false)
    expect(isAbbreviation('am 4. Mai', 4, 6, 'de')).toBe(true)
    expect(isAbbreviation('am 4. Mai', 4, 6, 'en')).toBe(false)
    expect(isAbbreviation('Samsa”. He', 6, 8, 'en')).toBe(false)
  })
})

describe('splitParagraphs', () => {
  it('numbers sentences across paragraphs and keeps paragraph indices and offsets', () => {
    const paragraphs: Paragraph[] = [
      { idx: 3, text: 'Er ging. Sie blieb.' },
      { idx: 4, text: 'Zwei Welten' },
      { idx: 5, text: '' },
      { idx: 6, text: 'Dann kam sie.' },
    ]
    const s = splitParagraphs(paragraphs, 'de')
    expect(s.map((x) => [x.idx, x.paraIdx, x.text, x.charStart, x.charEnd])).toEqual([
      [0, 3, 'Er ging.', 0, 8],
      [1, 3, 'Sie blieb.', 9, 19],
      [2, 4, 'Zwei Welten', 0, 11],
      [3, 6, 'Dann kam sie.', 0, 13],
    ])
  })
})

describe('splitSentences on the fixtures', () => {
  const pairs: [string, string][] = [
    ['kafka-verwandlung', 'Kafka'],
    ['goethe-werther', 'Goethe'],
  ]

  for (const [file, name] of pairs) {
    const count = (lang: Lang) => {
      const paragraphs = parseTxt(read(`${file}.${lang}.txt`))
      let n = 0
      for (const p of paragraphs) {
        const s = splitSentences(p.text, lang)
        expectOffsetsConsistent(p.text, s)
        expectNothingDropped(p.text, s)
        n += s.length
      }
      return n
    }

    it(`${name}: offsets are consistent, nothing is dropped, and both sides have similar sentence counts`, () => {
      const nDe = count('de')
      const nEn = count('en')
      expect(nDe).toBeGreaterThan(500)
      expect(nEn).toBeGreaterThan(500)
      // Translators merge and split sentences, but not wholesale: the two sides should land
      // within 15% of each other. A splitter bug on one side (quote style, dash style) shows
      // up here as a much larger gap.
      expect(Math.abs(nDe - nEn) / Math.max(nDe, nEn)).toBeLessThan(0.15)
    })
  }

  it('Kafka: no sentence starts with a lowercase letter or ends in a dash', () => {
    for (const lang of ['de', 'en'] as const) {
      for (const p of parseTxt(read(`kafka-verwandlung.${lang}.txt`))) {
        for (const s of splitSentences(p.text, lang)) {
          expect(s.text).not.toMatch(/^[\p{Ll}]/u)
          expect(s.text).not.toMatch(/[-—–]$/u)
        }
      }
    }
  })
})
