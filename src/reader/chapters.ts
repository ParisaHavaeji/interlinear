/**
 * The chapter list's model (plan.md step 17, §1.1b): every section of both editions as the
 * sheet lists them, paired rows in reading order with the excluded sections among them, and
 * the edits a tap on the sheet turns into (`ChapterEdits`, which the aligner applies on its
 * next run). DOM-free so it is testable; `ChaptersSheet.tsx` only renders what this builds.
 */

import { LOW_CHAPTER_CONFIDENCE, type ChapterMap, type ChapterMeta } from '../align/pipeline.ts'
import { chapterKey, isBodyByDefault, type ChapterEdits, type PairEdit, type SideEdits } from '../align/structure.ts'
import type { Lang, SectionKind } from '../import/types.ts'
import type { Book } from '../store/db.ts'

/** One section (EPUB) or chapter (plain text) of one side. */
export interface ChapterUnit {
  lang: Lang
  /** What the edits refer to it by (see `chapterKey`). */
  key: number
  title: string
  words: number
  paraStart: number
  /** Position in `ChapterMap[lang]` while included, null while excluded. */
  chapterIdx: number | null
  included: boolean
  /** Whether the aligner would include it without the reader's say-so. */
  defaultIncluded: boolean
  /** Front or back matter as detected; `body` for everything else, plain-text chapters included. */
  kind: SectionKind
}

export type ChapterRow =
  | {
      type: 'pair'
      pairIdx: number
      de: ChapterUnit[]
      en: ChapterUnit[]
      confidence: number | undefined
      /** True for a two-sided pair whose sides disagree in length (see `LOW_CHAPTER_CONFIDENCE`). */
      uncertain: boolean
      manual: boolean
    }
  | { type: 'excluded'; unit: ChapterUnit }

type BookShape = Pick<Book, 'sources' | 'alignment'>

const titleOf = (c: ChapterMeta, fallback: string) => c.heading ?? fallback

/**
 * The excluded sections of one side as chapters: what the map records, or, for books aligned
 * before step 17 whose map has no such list, the EPUB sections that are not chapters.
 */
function excludedOf(book: BookShape, map: ChapterMap, lang: Lang): ChapterMeta[] {
  const listed = map.excluded?.[lang]
  if (listed !== undefined) return listed
  const inChapters = new Set(map[lang].map((c) => c.sectionIdx))
  return book.sources[lang].sections
    .filter((s) => s.paraCount > 0 && !inChapters.has(s.idx))
    .map((s, idx) => ({ idx, heading: s.heading ?? s.title, sectionIdx: s.idx, paraStart: s.paraStart, paraCount: s.paraCount, words: s.words }))
}

/** Every section or chapter of one side, included and excluded, in reading order. */
export function chapterUnits(book: BookShape, map: ChapterMap, lang: Lang): ChapterUnit[] {
  const sections = book.sources[lang].sections
  const unit = (c: ChapterMeta, included: boolean): ChapterUnit => {
    const section = c.sectionIdx === null ? undefined : sections.find((s) => s.idx === c.sectionIdx)
    // Included chapters are named as the reader's page names them; excluded sections by spine position.
    const fallback = included ? `Chapter ${c.idx + 1}` : section !== undefined ? `Section ${section.idx + 1}` : 'Untitled'
    return {
      lang,
      key: chapterKey(c),
      title: titleOf(c, fallback),
      words: c.words,
      paraStart: c.paraStart,
      chapterIdx: included ? c.idx : null,
      included,
      defaultIncluded: section === undefined ? true : isBodyByDefault(section),
      kind: section?.kind ?? 'body',
    }
  }
  const units = [...map[lang].map((c) => unit(c, true)), ...excludedOf(book, map, lang).map((c) => unit(c, false))]
  units.sort((a, b) => a.paraStart - b.paraStart || Number(a.included) - Number(b.included))
  return units
}

/**
 * The rows of the chapter sheet: the chapter pairs in reading order, with every excluded
 * section placed before the first pair that holds a later chapter of its side. Returns an
 * empty list for a book that is not aligned yet.
 */
export function chapterRows(book: BookShape): ChapterRow[] {
  const map = book.alignment?.status === 'ready' ? book.alignment.chapters : undefined
  if (map === undefined) return []
  const units = { de: chapterUnits(book, map, 'de'), en: chapterUnits(book, map, 'en') }
  const byChapter = {
    de: new Map(units.de.filter((u) => u.chapterIdx !== null).map((u) => [u.chapterIdx, u])),
    en: new Map(units.en.filter((u) => u.chapterIdx !== null).map((u) => [u.chapterIdx, u])),
  }
  const pending = { de: units.de.filter((u) => !u.included), en: units.en.filter((u) => !u.included) }
  const rows: ChapterRow[] = []
  const flush = (lang: Lang, before: number) => {
    while (pending[lang].length > 0 && pending[lang][0].paraStart < before) rows.push({ type: 'excluded', unit: pending[lang].shift()! })
  }
  for (const [pairIdx, pair] of map.pairs.entries()) {
    const de = pair.de.map((i) => byChapter.de.get(i)).filter((u): u is ChapterUnit => u !== undefined)
    const en = pair.en.map((j) => byChapter.en.get(j)).filter((u): u is ChapterUnit => u !== undefined)
    if (de.length > 0) flush('de', Math.min(...de.map((u) => u.paraStart)))
    if (en.length > 0) flush('en', Math.min(...en.map((u) => u.paraStart)))
    const twoSided = de.length > 0 && en.length > 0
    rows.push({
      type: 'pair',
      pairIdx,
      de,
      en,
      confidence: pair.confidence,
      uncertain: twoSided && pair.confidence !== undefined && pair.confidence <= LOW_CHAPTER_CONFIDENCE,
      manual: pair.manual === true,
    })
  }
  flush('de', Infinity)
  flush('en', Infinity)
  return rows
}

// ---------------------------------------------------------------------------------------------
// Edits

function sideWithout(side: SideEdits | undefined, key: number): SideEdits {
  const out: SideEdits = {}
  const include = (side?.include ?? []).filter((k) => k !== key)
  const exclude = (side?.exclude ?? []).filter((k) => k !== key)
  if (include.length > 0) out.include = include
  if (exclude.length > 0) out.exclude = exclude
  return out
}

function pairsWithout(pairs: readonly PairEdit[] | undefined, lang: Lang, keys: readonly number[]): PairEdit[] {
  return (pairs ?? []).filter((p) => !p[lang].some((k) => keys.includes(k)))
}

/** `edits` without empty lists, so a book whose corrections were all undone stores `{}`. */
function tidy(edits: ChapterEdits): ChapterEdits {
  const out: ChapterEdits = {}
  if (edits.de !== undefined && (edits.de.include !== undefined || edits.de.exclude !== undefined)) out.de = edits.de
  if (edits.en !== undefined && (edits.en.include !== undefined || edits.en.exclude !== undefined)) out.en = edits.en
  if (edits.pairs !== undefined && edits.pairs.length > 0) out.pairs = edits.pairs
  return out
}

/**
 * The edits after the reader includes or excludes a section. Setting it back to what the
 * aligner would do on its own removes the correction rather than recording it; excluding a
 * chapter also drops any hand-set pair it was in.
 */
export function withInclusion(edits: ChapterEdits | undefined, unit: ChapterUnit, include: boolean): ChapterEdits {
  const side = sideWithout(edits?.[unit.lang], unit.key)
  if (include !== unit.defaultIncluded) {
    if (include) side.include = [...(side.include ?? []), unit.key]
    else side.exclude = [...(side.exclude ?? []), unit.key]
  }
  const pairs = include ? edits?.pairs : pairsWithout(edits?.pairs, unit.lang, [unit.key])
  return tidy({ ...edits, [unit.lang]: side, pairs })
}

/**
 * The edits after the reader pairs a German chapter with an English one by hand. Any
 * hand-set pair either chapter was in is replaced.
 */
export function withPair(edits: ChapterEdits | undefined, de: ChapterUnit, en: ChapterUnit): ChapterEdits {
  const pairs = pairsWithout(pairsWithout(edits?.pairs, 'de', [de.key]), 'en', [en.key])
  return tidy({ ...edits, pairs: [...pairs, { de: [de.key], en: [en.key] }] })
}

/** The edits after the reader hands a pair back to the aligner. */
export function withoutPair(edits: ChapterEdits | undefined, row: { de: ChapterUnit[]; en: ChapterUnit[] }): ChapterEdits {
  const pairs = pairsWithout(
    pairsWithout(
      edits?.pairs,
      'de',
      row.de.map((u) => u.key),
    ),
    'en',
    row.en.map((u) => u.key),
  )
  return tidy({ ...edits, pairs })
}

/** True when the edits hold no correction at all. */
export function isUnedited(edits: ChapterEdits | undefined): boolean {
  return edits === undefined || Object.keys(tidy(edits)).length === 0
}
