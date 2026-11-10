// The chapter sheet's model (plan.md step 17): rows of both editions, and the edits taps become.
import { describe, expect, it } from 'vitest'
import type { ChapterMap, ChapterMeta } from '../src/align/pipeline.ts'
import { chapterRows, chapterUnits, isUnedited, withInclusion, withoutPair, withPair, type ChapterUnit } from '../src/reader/chapters.ts'
import type { Book, SectionMeta } from '../src/store/db.ts'

const chapter = (idx: number, heading: string | null, paraStart: number, paraCount: number, sectionIdx: number | null = null): ChapterMeta => ({
  idx,
  heading,
  sectionIdx,
  paraStart,
  paraCount,
  words: paraCount * 100,
})

const section = (idx: number, kind: SectionMeta['kind'], paraStart: number, paraCount: number, title: string | null = null): SectionMeta => ({
  idx,
  href: `s${idx}.xhtml`,
  title,
  heading: null,
  kind,
  linear: true,
  words: paraCount * 100,
  paraStart,
  paraCount,
})

function book(chapters: ChapterMap, sections: { de?: SectionMeta[]; en?: SectionMeta[] } = {}): Pick<Book, 'sources' | 'alignment'> {
  const source = (secs: SectionMeta[]) => ({ fileName: 'x', format: secs.length > 0 ? ('epub' as const) : ('txt' as const), paragraphs: 0, words: 0, sections: secs })
  return {
    sources: { de: source(sections.de ?? []), en: source(sections.en ?? []) },
    alignment: { status: 'ready', updated: 0, chapters },
  }
}

describe('chapterUnits / chapterRows', () => {
  it('lists the pairs in order with excluded sections greyed in their place, and marks uncertain and manual pairs', () => {
    const sectionsDe = [section(0, 'front', 0, 2, 'Impressum'), section(1, 'body', 2, 10), section(2, 'body', 12, 8), section(3, 'back', 20, 3, 'Nachwort')]
    const sectionsEn = [section(0, 'front', 0, 1, 'Copyright'), section(1, 'front', 1, 30, 'Introduction'), section(2, 'body', 31, 11), section(3, 'body', 42, 9)]
    const map: ChapterMap = {
      de: [chapter(0, 'Eins', 2, 10, 1), chapter(1, 'Zwei', 12, 8, 2)],
      en: [chapter(0, 'One', 31, 11, 2), chapter(1, 'Two', 42, 9, 3)],
      pairs: [
        { de: [0], en: [0], confidence: 0.95 },
        { de: [1], en: [1], confidence: 0.5, manual: true },
      ],
      excluded: {
        de: [chapter(0, 'Impressum', 0, 2, 0), chapter(1, 'Nachwort', 20, 3, 3)],
        en: [chapter(0, 'Copyright', 0, 1, 0), chapter(1, 'Introduction', 1, 30, 1)],
      },
    }
    const b = book(map, { de: sectionsDe, en: sectionsEn })
    expect(chapterUnits(b, map, 'de').map((u) => [u.key, u.title, u.included, u.kind])).toEqual([
      [0, 'Impressum', false, 'front'],
      [1, 'Eins', true, 'body'],
      [2, 'Zwei', true, 'body'],
      [3, 'Nachwort', false, 'back'],
    ])
    const rows = chapterRows(b)
    expect(
      rows.map((r) => (r.type === 'pair' ? `${r.de.map((u) => u.title)}|${r.en.map((u) => u.title)}` : `x:${r.unit.lang}:${r.unit.title}`)),
    ).toEqual(['x:de:Impressum', 'x:en:Copyright', 'x:en:Introduction', 'Eins|One', 'Zwei|Two', 'x:de:Nachwort'])
    const pairs = rows.filter((r) => r.type === 'pair')
    expect(pairs.map((r) => (r.type === 'pair' ? [r.uncertain, r.manual] : null))).toEqual([
      [false, false],
      [true, true],
    ])
  })

  it('derives the excluded sections of a book aligned before step 17 from its EPUB sections', () => {
    const sections = [section(0, 'front', 0, 2, 'Title page'), section(1, 'body', 2, 10), section(2, 'back', 12, 0)]
    const map: ChapterMap = { de: [chapter(0, 'Eins', 2, 10, 1)], en: [chapter(0, 'One', 0, 10)], pairs: [{ de: [0], en: [0] }] }
    const rows = chapterRows(book(map, { de: sections }))
    expect(rows.map((r) => r.type)).toEqual(['excluded', 'pair'])
    expect(rows[0]).toMatchObject({ unit: { lang: 'de', key: 0, title: 'Title page', kind: 'front', defaultIncluded: false } })
  })

  it('names plain-text chapters without a heading by position and tells one-sided pairs apart', () => {
    const map: ChapterMap = {
      de: [chapter(0, null, 0, 5), chapter(1, 'II.', 6, 4)],
      en: [chapter(0, 'Preface', 0, 2), chapter(1, 'I.', 3, 5), chapter(2, 'II.', 9, 4)],
      pairs: [
        { de: [], en: [0] },
        { de: [0], en: [1], confidence: 1 },
        { de: [1], en: [2], confidence: 1 },
      ],
      excluded: { de: [], en: [] },
    }
    const rows = chapterRows(book(map))
    expect(rows[0]).toMatchObject({ type: 'pair', de: [], uncertain: false })
    expect(rows[1]).toMatchObject({ type: 'pair', de: [{ title: 'Chapter 1', key: 0, chapterIdx: 0, defaultIncluded: true }] })
  })

  it('is empty for a book that is not aligned', () => {
    expect(chapterRows({ sources: book({ de: [], en: [], pairs: [] }).sources, alignment: { status: 'pending', updated: 0 } })).toEqual([])
  })
})

describe('edits', () => {
  const unit = (lang: 'de' | 'en', key: number, defaultIncluded: boolean, included = defaultIncluded): ChapterUnit => ({
    lang,
    key,
    title: `${lang}${key}`,
    words: 1,
    paraStart: key,
    chapterIdx: included ? key : null,
    included,
    defaultIncluded,
    kind: 'body',
  })

  it('records only departures from what the aligner does on its own', () => {
    const front = unit('de', 0, false)
    const body = unit('de', 1, true)
    expect(withInclusion(undefined, front, true)).toEqual({ de: { include: [0] } })
    expect(withInclusion(undefined, front, false)).toEqual({})
    expect(withInclusion({ de: { include: [0] } }, front, false)).toEqual({})
    expect(withInclusion({ de: { include: [0] } }, body, false)).toEqual({ de: { include: [0], exclude: [1] } })
    expect(isUnedited(withInclusion({ de: { exclude: [1] } }, body, true))).toBe(true)
    expect(isUnedited(undefined)).toBe(true)
  })

  it('pairs by hand, replacing earlier hand-set pairs of either chapter, and drops a pair when a chapter is excluded', () => {
    const d1 = unit('de', 1, true)
    const d2 = unit('de', 2, true)
    const e1 = unit('en', 1, true)
    const e2 = unit('en', 2, true)
    const one = withPair(undefined, d1, e1)
    expect(one).toEqual({ pairs: [{ de: [1], en: [1] }] })
    const two = withPair(one, d2, e2)
    expect(two.pairs).toEqual([
      { de: [1], en: [1] },
      { de: [2], en: [2] },
    ])
    expect(withPair(two, d1, e2).pairs).toEqual([{ de: [1], en: [2] }])
    expect(withoutPair(two, { de: [d2], en: [] })).toEqual({ pairs: [{ de: [1], en: [1] }] })
    expect(withoutPair(one, { de: [d1], en: [e1] })).toEqual({})
    expect(withInclusion(two, e1, false)).toEqual({ en: { exclude: [1] }, pairs: [{ de: [2], en: [2] }] })
  })
})
