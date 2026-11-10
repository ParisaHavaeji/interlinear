import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  alignParagraphs,
  chaptersFromParagraphs,
  chaptersFromSections,
  chaptersOf,
  deletionCost,
  estimateRatio,
  lengthCost,
  logErfc,
  type ParagraphBead,
  type SectionRange,
} from '../src/align/structure.ts'
import { parseTxt } from '../src/import/txt.ts'
import type { Paragraph } from '../src/import/types.ts'

const read = (file: string) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')
const paras = (...texts: string[]): Paragraph[] => texts.map((text, idx) => ({ idx, text }))
const prose = (n: number, seed = 'x') => Array.from({ length: n }, (_, i) => `${seed}${i} word`).join(' ') + '.'

describe('chaptersFromParagraphs', () => {
  it('starts a chapter at each heading line and joins consecutive heading lines', () => {
    const ch = chaptersFromParagraphs(paras('Erstes Buch', 'Am 4. Mai 1771', prose(30), prose(20), 'Am 10. Mai', prose(25)))
    expect(ch.map((c) => c.heading)).toEqual(['Erstes Buch: Am 4. Mai 1771', 'Am 10. Mai'])
    expect(ch.map((c) => c.paragraphs.length)).toEqual([2, 1])
    expect(ch.map((c) => c.paraStart)).toEqual([2, 5])
    expect(ch.map((c) => c.idx)).toEqual([0, 1])
    expect(ch[0].sectionIdx).toBeNull()
    expect(ch[0].words).toBe(100)
  })

  it('keeps text before the first heading as a chapter without a heading', () => {
    const ch = chaptersFromParagraphs(paras(prose(10), 'I.', prose(10)))
    expect(ch.map((c) => c.heading)).toEqual([null, 'I.'])
    expect(ch[0].paraStart).toBe(0)
  })

  it('makes a text without headings one chapter', () => {
    const ch = chaptersFromParagraphs(paras(prose(10), prose(12)))
    expect(ch).toHaveLength(1)
    expect(ch[0].heading).toBeNull()
    expect(ch[0].paragraphs).toHaveLength(2)
  })

  it('leaves a closing "THE END" in the last chapter instead of opening an empty one', () => {
    const ch = chaptersFromParagraphs(paras('I', prose(10), 'THE END'))
    expect(ch).toHaveLength(1)
    expect(ch[0].paragraphs.map((p) => p.text)).toEqual([prose(10), 'THE END'])
  })

  it('takes at most three heading lines; a run of short lines after that is body text', () => {
    const ch = chaptersFromParagraphs(paras('Kapitel 1', 'A', 'B', 'C', 'D', prose(10)))
    expect(ch).toHaveLength(1)
    expect(ch[0].heading).toBe('Kapitel 1: A: B')
    expect(ch[0].paragraphs.map((p) => p.text)).toEqual(['C', 'D', prose(10)])
  })

  it('returns nothing for an empty list', () => {
    expect(chaptersFromParagraphs([])).toEqual([])
  })
})

describe('chaptersFromSections', () => {
  const section = (
    idx: number,
    kind: SectionRange['kind'],
    paraStart: number,
    paraCount: number,
    extra: Partial<SectionRange> = {},
  ): SectionRange => ({ idx, title: null, heading: null, kind, linear: true, paraStart, paraCount, ...extra })
  const flat = paras(prose(5, 'a'), prose(5, 'b'), prose(5, 'c'), prose(5, 'd'), prose(5, 'e'))

  it('yields one chapter per linear body section with its heading or nav title', () => {
    const sections = [
      section(0, 'front', 0, 1, { title: 'Copyright' }),
      section(1, 'body', 1, 2, { heading: 'CHAPTER ONE: TWO WORLDS' }),
      section(2, 'body', 3, 1, { title: 'Kain' }),
      section(3, 'body', 4, 1, { linear: false }),
      section(4, 'back', 4, 1),
    ]
    const ch = chaptersFromSections(sections, flat)
    expect(ch.map((c) => c.heading)).toEqual(['CHAPTER ONE: TWO WORLDS', 'Kain'])
    expect(ch.map((c) => c.sectionIdx)).toEqual([1, 2])
    expect(ch.map((c) => c.idx)).toEqual([0, 1])
    expect(ch[0].paragraphs.map((p) => p.text)).toEqual([flat[1].text, flat[2].text])
    expect(ch[0].paraStart).toBe(1)
    expect(ch[1].words).toBe(10)
  })

  it('skips empty sections', () => {
    expect(chaptersFromSections([section(0, 'body', 0, 0)], flat)).toEqual([])
  })
})

describe('chaptersOf', () => {
  it('uses sections when the import has any, else heading lines', () => {
    const paragraphs = paras('I.', prose(5))
    expect(chaptersOf({ paragraphs, sections: [] }).map((c) => c.heading)).toEqual(['I.'])
    const sections: SectionRange[] = [
      { idx: 0, title: 'One', heading: null, kind: 'body', linear: true, paraStart: 0, paraCount: 2 },
    ]
    expect(chaptersOf({ paragraphs, sections }).map((c) => c.heading)).toEqual(['One'])
  })
})

describe('length model', () => {
  it('logErfc matches erfc on known points and keeps going in the tail', () => {
    expect(logErfc(0)).toBeCloseTo(0, 6)
    expect(Math.exp(logErfc(1))).toBeCloseTo(0.1572992, 6)
    expect(Math.exp(logErfc(2))).toBeCloseTo(0.0046777, 6)
    expect(logErfc(10)).toBeLessThan(logErfc(8))
    expect(Number.isFinite(logErfc(40))).toBe(true)
  })

  it('lengthCost is zero for an empty bead, near zero for a perfect match and grows with mismatch', () => {
    expect(lengthCost(0, 0, 1)).toBe(0)
    expect(lengthCost(300, 300, 1)).toBeCloseTo(0, 6)
    expect(lengthCost(300, 330, 1.1)).toBeCloseTo(0, 6)
    expect(lengthCost(300, 360, 1)).toBeGreaterThan(lengthCost(300, 330, 1))
    expect(lengthCost(300, 0, 1)).toBeGreaterThan(lengthCost(300, 150, 1))
    expect(lengthCost(600, 0, 1)).toBeGreaterThan(lengthCost(300, 0, 1))
  })

  it('estimateRatio divides English by German characters and clamps', () => {
    expect(estimateRatio([{ text: 'aaaa' }], [{ text: 'aaaaa' }])).toBe(1.25)
    expect(estimateRatio([{ text: 'a' }], [{ text: 'aaaaaaaaaa' }])).toBe(2)
    expect(estimateRatio([], [{ text: 'a' }])).toBe(1)
  })
})

/** Every index on each side appears exactly once, in order, and each bead is one of the nine moves. */
function checkInvariants(beads: ParagraphBead[], n: number, m: number): void {
  const de = beads.flatMap((b) => b.de)
  const en = beads.flatMap((b) => b.en)
  expect(de).toEqual(Array.from({ length: n }, (_, i) => i))
  expect(en).toEqual(Array.from({ length: m }, (_, i) => i))
  for (const b of beads) {
    expect(`${b.de.length}-${b.en.length}`).toMatch(/^(1-1|1-0|0-1|2-1|1-2|3-1|1-3|4-1|1-4)$/)
    expect(b.cost).toBeGreaterThanOrEqual(0)
  }
}

const shape = (beads: ParagraphBead[]) => beads.map((b) => `${b.de.length}-${b.en.length}`)
const oneToOneShare = (beads: ParagraphBead[]) =>
  beads.filter((b) => b.de.length === 1 && b.en.length === 1).length / beads.length

describe('alignParagraphs', () => {
  it('returns nothing for two empty lists and all-deletions when one side is empty', () => {
    expect(alignParagraphs([], [])).toEqual([])
    const beads = alignParagraphs([{ text: prose(10) }, { text: prose(12) }], [])
    expect(shape(beads)).toEqual(['1-0', '1-0'])
    checkInvariants(beads, 2, 0)
    expect(shape(alignParagraphs([], [{ text: prose(10) }]))).toEqual(['0-1'])
  })

  it('aligns parallel lists one to one', () => {
    const de = [20, 45, 10, 60, 30].map((n) => ({ text: prose(n) }))
    const en = [22, 50, 11, 66, 33].map((n) => ({ text: prose(n) }))
    const beads = alignParagraphs(de, en)
    expect(shape(beads)).toEqual(['1-1', '1-1', '1-1', '1-1', '1-1'])
    checkInvariants(beads, 5, 5)
  })

  it('merges two German paragraphs into one English paragraph and vice versa', () => {
    const de = [40, 25, 25, 40].map((n) => ({ text: prose(n) }))
    const en = [44, 55, 44].map((n) => ({ text: prose(n) }))
    const beads = alignParagraphs(de, en)
    expect(shape(beads)).toEqual(['1-1', '2-1', '1-1'])
    expect(beads[1]).toMatchObject({ de: [1, 2], en: [1] })
    const flipped = alignParagraphs(en, de)
    expect(shape(flipped)).toEqual(['1-1', '1-2', '1-1'])
    expect(flipped[1]).toMatchObject({ de: [1], en: [1, 2] })
  })

  it('drops an unmatched paragraph on either side rather than distorting its neighbours', () => {
    const de = [40, 40, 40].map((n) => ({ text: prose(n) }))
    const en = [44, 44, 30, 44].map((n) => ({ text: prose(n) }))
    const beads = alignParagraphs(de, en, { ratio: 1.1 })
    expect(shape(beads)).toEqual(['1-1', '1-1', '0-1', '1-1'])
    expect(beads[2]).toMatchObject({ de: [], en: [2] })
    const flipped = alignParagraphs(en, de, { ratio: 1 / 1.1 })
    expect(shape(flipped)).toEqual(['1-1', '1-1', '1-0', '1-1'])
    checkInvariants(flipped, 4, 3)
  })

  it('merges a short unmatched paragraph into its neighbour when that fits better', () => {
    const de = [40, 40, 40].map((n) => ({ text: prose(n) }))
    const en = [44, 44, 6, 44].map((n) => ({ text: prose(n) }))
    const beads = alignParagraphs(de, en, { ratio: 1.1 })
    // Either neighbour may absorb it; what matters is that nothing is dropped and the rest stays 1-1.
    const merged = beads.filter((b) => b.de.length === 1 && b.en.length === 2)
    expect(merged).toHaveLength(1)
    expect(merged[0].en).toContain(2)
    expect(beads.filter((b) => b.de.length === 1 && b.en.length === 1)).toHaveLength(2)
  })

  it('prices deletions linearly in length', () => {
    expect(deletionCost(0)).toBe(0)
    expect(deletionCost(300)).toBe(3)
    expect(deletionCost(300, 50)).toBe(6)
    // A dropped 1000-character paragraph stays cheaper than a 1-1 bead that is off by half.
    expect(deletionCost(1000) - Math.log(0.0099)).toBeLessThan(lengthCost(1000, 1650, 1.1) - Math.log(0.89))
  })

  it('honours an explicit ratio', () => {
    const de = [40, 40].map((n) => ({ text: prose(n) }))
    const en = [80, 80].map((n) => ({ text: prose(n) }))
    expect(shape(alignParagraphs(de, en, { ratio: 2 }))).toEqual(['1-1', '1-1'])
  })

  it('reports a small cost for well-matched beads', () => {
    const de = [20, 45].map((n) => ({ text: prose(n) }))
    const en = [22, 50].map((n) => ({ text: prose(n) }))
    for (const b of alignParagraphs(de, en)) expect(b.cost).toBeLessThan(1)
  })
})

describe('on the Gutenberg fixtures', () => {
  const kafkaDe = chaptersFromParagraphs(parseTxt(read('kafka-verwandlung.de.txt')))
  const kafkaEn = chaptersFromParagraphs(parseTxt(read('kafka-verwandlung.en.txt')))
  const wertherDe = chaptersFromParagraphs(parseTxt(read('goethe-werther.de.txt')))
  const wertherEn = chaptersFromParagraphs(parseTxt(read('goethe-werther.en.txt')))

  it('finds the three parts of Die Verwandlung on both sides', () => {
    expect(kafkaDe.map((c) => c.heading)).toEqual(['I.', 'II.', 'III.'])
    expect(kafkaEn.map((c) => c.heading)).toEqual(['I', 'II', 'III'])
    for (const [i, c] of kafkaDe.entries()) {
      const ratio = c.paragraphs.length / kafkaEn[i].paragraphs.length
      expect(ratio, `part ${i}`).toBeGreaterThan(0.8)
      expect(ratio, `part ${i}`).toBeLessThan(1.25)
    }
  })

  it('finds the letters of Werther as chapters, with the book and editor headings', () => {
    expect(wertherDe[0].heading).toBe('Erstes Buch: Am 4. Mai 1771')
    expect(wertherEn[0].heading).toBe('PREFACE')
    expect(wertherEn[1].heading).toBe('BOOK I: MAY 4.')
    expect(wertherDe.some((c) => c.heading?.startsWith('Zweites Buch'))).toBe(true)
    expect(wertherEn.some((c) => c.heading?.startsWith('BOOK II.'))).toBe(true)
    expect(wertherDe.some((c) => c.heading === 'Der Herausgeber an den Leser')).toBe(true)
    expect(wertherEn.some((c) => c.heading === 'THE EDITOR TO THE READER.')).toBe(true)
    // Both editions have ~90 letters; the counts must stay in the same ballpark.
    expect(wertherDe.length).toBeGreaterThan(80)
    expect(Math.abs(wertherDe.length - wertherEn.length)).toBeLessThan(10)
    // No chapter is a stray heading with nothing under it.
    for (const c of [...wertherDe, ...wertherEn]) expect(c.words, c.heading ?? '').toBeGreaterThan(0)
  })

  it('aligns the paragraphs of each Kafka part mostly one to one', () => {
    for (const [i, c] of kafkaDe.entries()) {
      const beads = alignParagraphs(c.paragraphs, kafkaEn[i].paragraphs)
      checkInvariants(beads, c.paragraphs.length, kafkaEn[i].paragraphs.length)
      expect(oneToOneShare(beads), `part ${i}`).toBeGreaterThan(0.85)
    }
  })

  it("sees that Boylan merged the first two paragraphs of Werther's first letter", () => {
    // DE chapter 0 ("Erstes Buch: Am 4. Mai 1771") ↔ EN chapter 1 ("BOOK I: MAY 4.")
    const de = wertherDe[0].paragraphs
    const en = wertherEn[1].paragraphs
    const beads = alignParagraphs(de, en)
    checkInvariants(beads, de.length, en.length)
    expect(shape(beads)).toEqual(['2-1', '1-1', '1-1'])
    expect(beads[0].cost).toBeLessThan(5)
  })

  it('aligns date-matched Werther letters one to one wherever Boylan kept the paragraphs', () => {
    // "Am 10. Mai" ↔ "MAY 10.": pair letters by day and month, ignoring book headings and years.
    const MONTHS: Record<string, number> = {
      januar: 1, january: 1, februar: 2, february: 2, märz: 3, march: 3, april: 4, mai: 5, may: 5,
      junius: 6, june: 6, julius: 7, july: 7, august: 8, september: 9, oktober: 10, october: 10,
      november: 11, dezember: 12, december: 12,
    }
    const names = Object.keys(MONTHS).join('|')
    const DATE = new RegExp(String.raw`(\d{1,2})\.?\s+(${names})\b|\b(${names})\.?\s+(\d{1,2})`)
    const key = (heading: string | null): string | null => {
      const last = heading?.split(': ').pop()?.toLowerCase() ?? ''
      const m = DATE.exec(last)
      if (!m) return null
      const day = m[1] ?? m[4]
      const month = MONTHS[m[2] ?? m[3]]
      return month ? `${month}-${Number(day)}` : null
    }
    const enByKey = new Map<string, (typeof wertherEn)[number]>()
    for (const c of wertherEn) {
      const k = key(c.heading)
      if (k !== null && !enByKey.has(k)) enByKey.set(k, c)
    }
    const all: ParagraphBead[] = []
    const sameCount: ParagraphBead[] = []
    let pairs = 0
    const seen = new Set<string>()
    for (const d of wertherDe) {
      const k = key(d.heading)
      if (k === null || seen.has(k)) continue
      seen.add(k)
      const e = enByKey.get(k)
      if (!e) continue
      pairs++
      const beads = alignParagraphs(d.paragraphs, e.paragraphs)
      checkInvariants(beads, d.paragraphs.length, e.paragraphs.length)
      all.push(...beads)
      if (d.paragraphs.length === e.paragraphs.length) sameCount.push(...beads)
    }
    expect(pairs).toBeGreaterThan(60)
    expect(all.length).toBeGreaterThan(150)
    // Boylan folds German paragraphs together all the time (and once in a while a whole letter
    // into one paragraph), so only ~60% of all beads are 1-1; where both sides have the same
    // number of paragraphs the alignment is one to one nearly throughout.
    expect(oneToOneShare(all)).toBeGreaterThan(0.55)
    expect(sameCount.length).toBeGreaterThan(80)
    expect(oneToOneShare(sameCount)).toBeGreaterThan(0.85)
  })
})
