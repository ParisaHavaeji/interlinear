import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { splitParagraphs } from '../src/align/sentences.ts'
import { parseTxt } from '../src/import/txt.ts'
import { runsOf, tokenize, type Token } from '../src/reader/tokenize.ts'

const words = (text: string) => tokenize(text).filter((t) => t.word).map((t) => t.text)
const joined = (tokens: Token[]) => tokens.map((t) => t.text).join('')

describe('tokenize', () => {
  it('splits words from punctuation and whitespace, losing nothing', () => {
    const text = '»Was ist mit mir geschehen?« dachte er.'
    const tokens = tokenize(text)
    expect(joined(tokens)).toBe(text)
    expect(words(text)).toEqual(['Was', 'ist', 'mit', 'mir', 'geschehen', 'dachte', 'er'])
    expect(tokens[0]).toEqual({ text: '»', word: false })
    expect(tokens.at(-1)).toEqual({ text: '.', word: false })
    expect(tokens.filter((t) => !t.word).map((t) => t.text)).toEqual(['»', ' ', ' ', ' ', ' ', '?« ', ' ', '.'])
  })

  it('keeps apostrophes and hyphens inside words but not at their edges', () => {
    expect(words("geht's don’t Schwarz-Weiß")).toEqual(["geht's", 'don’t', 'Schwarz-Weiß'])
    expect(words("'s ist so -- sagte er -")).toEqual(['s', 'ist', 'so', 'sagte', 'er'])
    expect(joined(tokenize("'s ist so -- sagte er -"))).toBe("'s ist so -- sagte er -")
  })

  it('treats digits as words and periods inside numbers as punctuation', () => {
    expect(words('am 4. Mai 1771, 3.000 Taler')).toEqual(['am', '4', 'Mai', '1771', '3', '000', 'Taler'])
  })

  it('handles umlauts, ß, combining marks and dashes', () => {
    expect(words('Übermäßig früh — fast zu früh')).toEqual(['Übermäßig', 'früh', 'fast', 'zu', 'früh'])
    expect(words('Café Tür')).toEqual(['Café', 'Tür'])
  })

  it('returns nothing for the empty string and one token for pure whitespace', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('   ')).toEqual([{ text: '   ', word: false }])
  })
})

describe('runsOf', () => {
  const text = 'Er schlief. Dann -- plötzlich -- erwachte er! Was nun?'
  const at = (part: string) => text.indexOf(part)

  it('cuts a paragraph into sentence runs and the separators between them', () => {
    const runs = runsOf(text, [
      { idx: 7, charStart: 0, charEnd: at('.') + 1 },
      { idx: 8, charStart: at('Dann'), charEnd: at('!') + 1 },
      { idx: 9, charStart: at('Was'), charEnd: text.length },
    ])
    expect(runs).toEqual([
      { text: 'Er schlief.', sentenceIdx: 7 },
      { text: ' ', sentenceIdx: null },
      { text: 'Dann -- plötzlich -- erwachte er!', sentenceIdx: 8 },
      { text: ' ', sentenceIdx: null },
      { text: 'Was nun?', sentenceIdx: 9 },
    ])
    expect(runs.map((r) => r.text).join('')).toBe(text)
  })

  it('keeps leading and trailing text that no sentence covers', () => {
    const runs = runsOf('-- Hallo. --', [{ idx: 0, charStart: 3, charEnd: 9 }])
    expect(runs).toEqual([
      { text: '-- ', sentenceIdx: null },
      { text: 'Hallo.', sentenceIdx: 0 },
      { text: ' --', sentenceIdx: null },
    ])
  })

  it('gives one unassigned run when there are no sentences', () => {
    expect(runsOf('Nur Text.', [])).toEqual([{ text: 'Nur Text.', sentenceIdx: null }])
    expect(runsOf('', [])).toEqual([])
  })

  it('sorts sentences and clamps overlapping or out-of-range spans without losing text', () => {
    const runs = runsOf('Eins. Zwei.', [
      { idx: 2, charStart: 6, charEnd: 99 },
      { idx: 1, charStart: 0, charEnd: 8 },
    ])
    expect(runs).toEqual([
      { text: 'Eins. Zw', sentenceIdx: 1 },
      { text: 'ei.', sentenceIdx: 2 },
    ])
  })

  it('agrees with the splitter over the Kafka fixture: separators carry no words', () => {
    const file = new URL('./fixtures/kafka-verwandlung.de.txt', import.meta.url)
    const paragraphs = parseTxt(readFileSync(file, 'utf8'))
    const byPara = new Map<number, { idx: number; charStart: number; charEnd: number }[]>()
    for (const s of splitParagraphs(paragraphs, 'de')) {
      const list = byPara.get(s.paraIdx) ?? []
      list.push({ idx: s.idx, charStart: s.charStart, charEnd: s.charEnd })
      byPara.set(s.paraIdx, list)
    }
    let sentenceRuns = 0
    for (const p of paragraphs) {
      const runs = runsOf(p.text, byPara.get(p.idx) ?? [])
      expect(runs.map((r) => r.text).join('')).toBe(p.text)
      for (const r of runs) {
        if (r.sentenceIdx === null) expect(words(r.text)).toEqual([])
        else {
          expect(words(r.text).length).toBeGreaterThan(0)
          sentenceRuns++
        }
      }
    }
    expect(sentenceRuns).toBeGreaterThan(600)
  })
})
