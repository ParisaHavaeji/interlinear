// Pre-aligned input (plan.md step 14): one sentence per line, equal counts, aligner skipped.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inlineRunner, startAlignment, type Runner } from '../src/align/jobs.ts'
import { isPrealignedBook, isPrealignedPair, pairChaptersByPosition, prealignedResult } from '../src/align/prealigned.ts'
import { chaptersFromParagraphs } from '../src/align/structure.ts'
import type { ImportedText } from '../src/import/file.ts'
import { parseTxtLayout } from '../src/import/txt.ts'
import type { Paragraph } from '../src/import/types.ts'
import { addBook } from '../src/store/books.ts'
import { openDatabase, type InterlinearDB } from '../src/store/db.ts'

const paras = (...texts: string[]): Paragraph[] => texts.map((text, idx) => ({ idx, text }))

/** A plain-text import as `importFile` would deliver it. */
function txt(fileName: string, text: string): ImportedText {
  const { paragraphs, layout } = parseTxtLayout(text)
  return { fileName, format: 'txt', paragraphs, sections: [], words: text.split(/\s+/).length, meta: null, layout }
}

const DE_LINES = 'I.\nGregor lachte im Haus.\nSamsa schlief im Zimmer.\nDie Mutter fand vier Wände.\nII.\nGregor lachte wieder.\n'
const EN_LINES = 'I.\nGregor laughed in the house.\nSamsa slept in the room.\nMother found four walls.\nII.\nGregor laughed again.\n'
const DE_BLOCKS = 'I.\n\nGregor lachte im Haus. Samsa schlief im Zimmer.\n\nDie Mutter fand vier Wände.'

describe('parseTxtLayout', () => {
  it('reports blocks for blank-line paragraphs and lines for the one-per-line fallback', () => {
    expect(parseTxtLayout(DE_BLOCKS).layout).toBe('blocks')
    expect(parseTxtLayout(DE_LINES).layout).toBe('lines')
    expect(parseTxtLayout(DE_LINES).paragraphs).toHaveLength(6)
    // A single wrapped paragraph is neither pre-aligned nor one-per-line.
    expect(parseTxtLayout('nur ein\nAbsatz')).toEqual({ paragraphs: paras('nur ein Absatz'), layout: 'blocks' })
  })
})

describe('isPrealignedPair', () => {
  it('needs two line-layout text files with the same count', () => {
    expect(isPrealignedPair(txt('a.txt', DE_LINES), txt('b.txt', EN_LINES))).toBe(true)
    expect(isPrealignedPair(txt('a.txt', DE_BLOCKS), txt('b.txt', EN_LINES))).toBe(false)
    expect(isPrealignedPair(txt('a.txt', DE_LINES), txt('b.txt', EN_LINES + 'One more.\n'))).toBe(false)
    const epub: ImportedText = { ...txt('a.epub', DE_LINES), format: 'epub' }
    expect(isPrealignedPair(epub, txt('b.txt', EN_LINES))).toBe(false)
  })
})

describe('prealignedResult', () => {
  const de = parseTxtLayout(DE_LINES).paragraphs
  const en = parseTxtLayout(EN_LINES).paragraphs

  it('makes one sentence per line and one sure 1-1 bead per line pair, headings included', () => {
    const r = prealignedResult(de, en)
    expect(r.sentences.de.map((s) => s.text)).toEqual(de.map((p) => p.text))
    expect(r.sentences.de[1]).toEqual({ idx: 1, paraIdx: 1, text: 'Gregor lachte im Haus.', charStart: 0, charEnd: 22 })
    expect(r.sentences.en).toHaveLength(6)
    expect(r.beads.map((b) => `${b.deSentenceIdx.join('+')}:${b.enSentenceIdx.join('+')}`)).toEqual(['0:0', '1:1', '2:2', '3:3', '4:4', '5:5'])
    for (const b of r.beads) expect(b.confidence).toBe(1)
    expect(r.lexicon).toEqual([])
    expect(r.stats).toMatchObject({ sentences: { de: 6, en: 6 }, beads: 6, oneToOne: 6, uncertain: 0, learnedPairs: 0, changedBeads: 0, pairedChapters: 2 })
  })

  it('detects the chapters of both sides and pairs them by position', () => {
    const r = prealignedResult(de, en)
    expect(r.chapters.de.map((c) => c.heading)).toEqual(['I.', 'II.'])
    expect(r.chapters.en.map((c) => c.heading)).toEqual(['I.', 'II.'])
    expect(r.chapters.pairs).toEqual([
      { de: [0], en: [0] },
      { de: [1], en: [1] },
    ])
    expect(r.chapters.de[1]).toMatchObject({ idx: 1, paraStart: 5, paraCount: 1 })
  })

  it('refuses unequal counts', () => {
    expect(() => prealignedResult(de, en.slice(1))).toThrow(/equal line counts/)
  })
})

describe('pairChaptersByPosition', () => {
  it('merges a chapter that only one side splits into the pair that covers its lines', () => {
    // German has a heading at line 3 that the English renders as prose: the English chapter 0
    // covers lines 0–5, so German chapters 0 and 1 both belong to it.
    const de = chaptersFromParagraphs(paras('Er kam.', 'Sie ging.', 'Es regnete.', 'Zweites Kapitel', 'Er lachte.', 'Sie weinte.', 'Drittes Kapitel', 'Es schneite.'))
    const en = chaptersFromParagraphs(paras('He came.', 'She went.', 'It rained.', 'The second part begins.', 'He laughed.', 'She cried.', 'Chapter Three', 'It snowed.'))
    expect(de.map((c) => c.heading)).toEqual([null, 'Zweites Kapitel', 'Drittes Kapitel'])
    expect(en.map((c) => c.heading)).toEqual([null, 'Chapter Three'])
    expect(pairChaptersByPosition(de, en)).toEqual([
      { de: [0, 1], en: [0] },
      { de: [2], en: [1] },
    ])
  })

  it('never leaves a chapter without a partner', () => {
    const de = chaptersFromParagraphs(paras('Er kam.', 'Sie ging.', 'Zweites Kapitel', 'Es regnete.'))
    const en = chaptersFromParagraphs(paras('He came.', 'She went.', 'The second part begins.', 'It rained.'))
    expect(de.map((c) => c.heading)).toEqual([null, 'Zweites Kapitel'])
    expect(en.map((c) => c.heading)).toEqual([null])
    expect(pairChaptersByPosition(de, en)).toEqual([{ de: [0, 1], en: [0] }])
    expect(pairChaptersByPosition([], en)).toEqual([{ de: [], en: [0] }])
  })
})

describe('pre-aligned books in the job queue', () => {
  let db: InterlinearDB
  let n = 0
  beforeEach(() => {
    db = openDatabase(`prealigned-${n++}`)
  })
  afterEach(async () => {
    await db.delete()
  })

  it('stores the layout, skips the runner and saves the line beads', async () => {
    const book = await addBook({ title: 'Lines', author: '', de: txt('a.txt', DE_LINES), en: txt('b.txt', EN_LINES) }, db)
    expect(book.sources.de.layout).toBe('lines')
    expect(isPrealignedBook(book)).toBe(true)

    let ran = false
    const spy: Runner = (request, onProgress, signal) => {
      ran = true
      return inlineRunner(request, onProgress, signal)
    }
    await startAlignment(book.id, { db, runner: spy })
    expect(ran).toBe(false)

    const stored = (await db.books.get(book.id))!
    expect(stored.alignment).toMatchObject({ status: 'ready', stats: { beads: 6, oneToOne: 6, uncertain: 0 } })
    const beads = await db.beads.where('bookId').equals(book.id).sortBy('beadIdx')
    expect(beads.map((b) => [b.deSentenceIdx[0], b.enSentenceIdx[0], b.confidence])).toEqual([0, 1, 2, 3, 4, 5].map((i) => [i, i, 1]))
    expect(await db.sentences.where('bookId').equals(book.id).count()).toBe(12)
  })

  it('still runs the aligner when only one side is line-based', async () => {
    const book = await addBook({ title: 'Mixed', author: '', de: txt('a.txt', DE_BLOCKS), en: txt('b.txt', EN_LINES) }, db)
    expect(book.sources.de.layout).toBe('blocks')
    expect(isPrealignedBook(book)).toBe(false)
    let ran = false
    const spy: Runner = (request, onProgress, signal) => {
      ran = true
      return inlineRunner(request, onProgress, signal)
    }
    await startAlignment(book.id, { db, runner: spy })
    expect(ran).toBe(true)
    expect((await db.books.get(book.id))?.alignment?.status).toBe('ready')
  })
})
