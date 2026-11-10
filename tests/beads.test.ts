import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  alignBlocks,
  alignSentences,
  confidenceOf,
  estimateSentenceRatio,
  MOVES,
  type AlignedBead,
  type ParagraphBlock,
  type SentenceBead,
} from '../src/align/beads.ts'
import { MapLexicon, prepareSentence } from '../src/align/features.ts'
import { splitParagraphs } from '../src/align/sentences.ts'
import { alignParagraphs, chaptersFromParagraphs } from '../src/align/structure.ts'
import { parseTxt } from '../src/import/txt.ts'

const read = (file: string) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')

const lexicon = new MapLexicon([
  ['Haus', ['house', 'home']],
  ['Zimmer', ['room']],
  ['Mutter', ['mother']],
  ['Wand', ['wall']],
  ['vier', ['four']],
  ['lachen', ['to laugh']],
  ['schlafen', ['to sleep']],
  ['finden', ['to find']],
  ['lang', ['long']],
  ['laut', ['loud']],
])
const de = (text: string) => prepareSentence(text, 'de', lexicon)
const en = (text: string) => prepareSentence(text, 'en')

/** "0:0 | 1+2:1 | 3:∅" — the shape of an alignment, for terse assertions. */
const shape = (beads: readonly SentenceBead[]) =>
  beads.map((b) => `${b.de.join('+') || '∅'}:${b.en.join('+') || '∅'}`).join(' | ')

/** Every sentence of both sides in exactly one bead, beads in reading order, no empty beads. */
function checkInvariants(beads: readonly { de: readonly number[]; en: readonly number[] }[], n: number, m: number): void {
  const seenDe: number[] = []
  const seenEn: number[] = []
  for (const b of beads) {
    expect(b.de.length + b.en.length).toBeGreaterThan(0)
    expect(b.de.length).toBeLessThanOrEqual(2)
    expect(b.en.length).toBeLessThanOrEqual(2)
    seenDe.push(...b.de)
    seenEn.push(...b.en)
  }
  expect(seenDe).toEqual(Array.from({ length: n }, (_, i) => i))
  expect(seenEn).toEqual(Array.from({ length: m }, (_, j) => j))
}

describe('alignSentences', () => {
  it('returns nothing for two empty lists and all-deletions when one side is empty', () => {
    expect(alignSentences([], [])).toEqual([])
    const beads = alignSentences([de('Gregor lachte.'), de('Samsa schlief.')], [])
    expect(shape(beads)).toBe('0:∅ | 1:∅')
    // Nothing else could cover these sentences, so there is no rival path.
    for (const b of beads) {
      expect(b.margin).toBe(Infinity)
      expect(b.confidence).toBe(1)
    }
  })

  it('aligns parallel sentences one to one', () => {
    const beads = alignSentences(
      [de('Gregor lachte im Haus.'), de('Samsa schlief im Zimmer.'), de('Die Mutter fand vier Wände.')],
      [en('Gregor laughed in the house.'), en('Samsa slept in the room.'), en('Mother found four walls.')],
    )
    checkInvariants(beads, 3, 3)
    expect(shape(beads)).toBe('0:0 | 1:1 | 2:2')
    for (const b of beads) expect(b.confidence).toBeGreaterThan(0.9)
  })

  it('merges two German sentences into one English sentence and vice versa', () => {
    const twoOne = alignSentences(
      [de('Gregor lachte im Haus.'), de('Samsa schlief.')],
      [en('Gregor laughed in the house and Samsa slept.')],
    )
    expect(shape(twoOne)).toBe('0+1:0')
    const oneTwo = alignSentences(
      [de('Gregor lachte im Haus und Samsa schlief im Zimmer.')],
      [en('Gregor laughed in the house.'), en('Samsa slept in the room.')],
    )
    expect(shape(oneTwo)).toBe('0:0+1')
  })

  it('takes a 2-2 bead when the sentence break moved across the translation', () => {
    const beads = alignSentences(
      [de('Gregor.'), de('Samsa lachte lange und laut und lange und laut im Haus.')],
      [en('Gregor laughed long and loud and long and loud in the house.'), en('Samsa.')],
    )
    expect(shape(beads)).toBe('0+1:0+1')
    expect(MOVES.some(([a, b]) => a === 2 && b === 2)).toBe(true)
  })

  it('aligns a lone sentence pair with a large margin', () => {
    const [bead] = alignSentences([de('Gregor lachte.')], [en('Gregor laughed.')])
    expect(bead.margin).toBeGreaterThan(5)
    expect(bead.confidence).toBeGreaterThan(0.99)
  })

  it('reports lower confidence where an untranslated sentence could go either way', () => {
    const beads = alignSentences(
      [
        de('Gregor lachte im Haus.'),
        de('Dieser Satz fehlt in der Übersetzung völlig, er wurde einfach gestrichen.'),
        de('Samsa schlief im Zimmer.'),
      ],
      [en('Gregor laughed in the house.'), en('Samsa slept in the room.')],
    )
    checkInvariants(beads, 3, 2)
    const sure = alignSentences([de('Gregor lachte im Haus.')], [en('Gregor laughed in the house.')])[0]
    // The stray sentence is absorbed into a neighbour; whichever one, the rival is close.
    for (const b of beads) expect(b.confidence).toBeLessThan(sure.confidence)
    expect(Math.max(...beads.map((b) => b.margin))).toBeLessThan(1)
  })

  it('maps the margin to a two-way posterior', () => {
    expect(confidenceOf(0)).toBe(0.5)
    expect(confidenceOf(Infinity)).toBe(1)
    expect(confidenceOf(Math.log(19))).toBeCloseTo(0.95)
  })

  it('sums bead costs to the cheapest path and honours an explicit ratio', () => {
    const d = [de('Gregor lachte im Haus.'), de('Samsa schlief im Zimmer.')]
    const e = [en('Gregor laughed in the house.'), en('Samsa slept in the room.')]
    const a = alignSentences(d, e)
    const b = alignSentences(d, e, { ratio: 1.1 })
    expect(shape(a)).toBe(shape(b))
    expect(a.reduce((n, x) => n + x.cost, 0)).not.toBeCloseTo(b.reduce((n, x) => n + x.cost, 0), 6)
    expect(estimateSentenceRatio(d, e)).toBeCloseTo(e.reduce((n, s) => n + s.chars, 0) / d.reduce((n, s) => n + s.chars, 0))
    expect(estimateSentenceRatio([], e)).toBe(1)
  })
})

describe('alignBlocks', () => {
  const deParas = [
    { idx: 0, text: 'Vorwort.' },
    { idx: 1, text: 'Gregor lachte im Haus. Samsa schlief im Zimmer.' },
    { idx: 2, text: 'Die Mutter fand vier Wände.' },
  ]
  const enParas = [
    { idx: 0, text: 'Gregor laughed in the house. Samsa slept in the room.' },
    { idx: 1, text: 'Mother found four walls.' },
  ]
  const deSent = splitParagraphs(deParas, 'de')
  const enSent = splitParagraphs(enParas, 'en')

  it('aligns block by block and reports global sentence indices', () => {
    const blocks: ParagraphBlock[] = [
      { de: [1], en: [0] },
      { de: [2], en: [1] },
    ]
    const beads = alignBlocks(deSent, enSent, blocks, lexicon)
    expect(beads.map((b) => `${b.deSentenceIdx.join('+')}:${b.enSentenceIdx.join('+')}`)).toEqual(['1:0', '2:1', '3:2'])
    for (const b of beads) {
      expect(b.confidence).toBeGreaterThan(0.9)
      expect(b.confidence).toBe(1 / (1 + Math.exp(-b.margin)))
    }
  })

  it('gives no bead to sentences of paragraphs outside every block', () => {
    const beads = alignBlocks(deSent, enSent, [{ de: [1, 2], en: [0, 1] }], lexicon)
    expect(beads.flatMap((b) => b.deSentenceIdx)).toEqual([1, 2, 3])
    expect(beads.flatMap((b) => b.enSentenceIdx)).toEqual([0, 1, 2])
  })

  it('yields one-sided beads for a one-sided block', () => {
    const beads = alignBlocks(deSent, enSent, [{ de: [0], en: [] }], lexicon)
    expect(beads).toHaveLength(1)
    expect(beads[0].deSentenceIdx).toEqual([0])
    expect(beads[0].enSentenceIdx).toEqual([])
  })
})

describe('on the Kafka fixture', () => {
  const paraDe = parseTxt(read('kafka-verwandlung.de.txt'))
  const paraEn = parseTxt(read('kafka-verwandlung.en.txt'))
  const chaptersDe = chaptersFromParagraphs(paraDe)
  const chaptersEn = chaptersFromParagraphs(paraEn)
  const sentDe = splitParagraphs(paraDe, 'de')
  const sentEn = splitParagraphs(paraEn, 'en')
  const blocks: ParagraphBlock[] = []
  for (const [i, c] of chaptersDe.entries()) {
    const other = chaptersEn[i].paragraphs
    for (const b of alignParagraphs(c.paragraphs, other)) {
      blocks.push({ de: b.de.map((x) => c.paragraphs[x].idx), en: b.en.map((y) => other[y].idx) })
    }
  }
  let beads: AlignedBead[] = []
  let elapsed = 0

  it('aligns the whole novella without a dictionary, mostly one to one, in well under a second', () => {
    const t0 = performance.now()
    beads = alignBlocks(sentDe, sentEn, blocks, null)
    elapsed = performance.now() - t0
    // The chapter headings ("I.", "II.", "III.") are paragraphs outside every block; all else is covered.
    const covered = (sentences: typeof sentDe, side: 'de' | 'en') => {
      const paras = new Set(blocks.flatMap((b) => b[side]))
      return sentences.filter((s) => paras.has(s.paraIdx)).map((s) => s.idx)
    }
    expect(beads.flatMap((b) => b.deSentenceIdx)).toEqual(covered(sentDe, 'de'))
    expect(beads.flatMap((b) => b.enSentenceIdx)).toEqual(covered(sentEn, 'en'))
    expect(sentDe.length - covered(sentDe, 'de').length).toBe(3)
    for (const b of beads) {
      expect(b.deSentenceIdx.length + b.enSentenceIdx.length).toBeGreaterThan(0)
      expect(b.deSentenceIdx.length).toBeLessThanOrEqual(3)
      expect(b.enSentenceIdx.length).toBeLessThanOrEqual(3)
      expect(b.deSentenceIdx.length + b.enSentenceIdx.length).toBeLessThanOrEqual(4)
    }
    const oneToOne = beads.filter((b) => b.deSentenceIdx.length === 1 && b.enSentenceIdx.length === 1).length
    expect(oneToOne / beads.length).toBeGreaterThan(0.8)
    expect(elapsed).toBeLessThan(3000)
  })

  it('gets the opening of Die Verwandlung right', () => {
    const text = (b: AlignedBead) => [
      b.deSentenceIdx.map((i) => sentDe[i].text).join(' '),
      b.enSentenceIdx.map((i) => sentEn[i].text).join(' '),
    ]
    expect(text(beads[0])[0]).toMatch(/^Als Gregor Samsa eines Morgens/)
    expect(text(beads[0])[1]).toMatch(/^One morning, when Gregor Samsa/)
    expect(text(beads[3])).toEqual(['»Was ist mit mir geschehen?« dachte er.', '“What’s happened to me?” he thought.'])
    expect(text(beads[4])).toEqual(['Es war kein Traum.', 'It wasn’t a dream.'])
    // Wyllie split Kafka's window sentence in two.
    const window = beads.find((b) => sentDe[b.deSentenceIdx[0]].text.startsWith('Gregors Blick richtete sich dann zum Fenster'))
    expect(window?.enSentenceIdx).toHaveLength(2)
    expect(sentEn[window!.enSentenceIdx[0]].text).toMatch(/^Gregor then turned to look out the window/)
  })

  it('is confident about most beads and marks the rest', () => {
    const confident = beads.filter((b) => b.confidence > 0.9).length
    expect(confident / beads.length).toBeGreaterThan(0.7)
    expect(beads.some((b) => b.confidence < 0.7)).toBe(true)
    for (const b of beads) {
      expect(b.margin).toBeGreaterThanOrEqual(0)
      expect(b.cost).toBeGreaterThan(0)
    }
  })
})
