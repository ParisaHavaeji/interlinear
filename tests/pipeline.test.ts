import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ParagraphBlock } from '../src/align/beads.ts'
import { alignTwoPass } from '../src/align/lexicon.ts'
import {
  alignBook,
  LOW_CHAPTER_CONFIDENCE,
  LOW_CONFIDENCE,
  pairChapters,
  pairChaptersEdited,
  pairKey,
  planChapters,
  type AlignProgress,
  type AlignStage,
} from '../src/align/pipeline.ts'
import { splitParagraphs } from '../src/align/sentences.ts'
import { alignParagraphs, chaptersFromParagraphs, type Chapter } from '../src/align/structure.ts'
import { parseTxt } from '../src/import/txt.ts'
import type { Paragraph } from '../src/import/types.ts'

const read = (file: string) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')
const paras = (...texts: string[]): Paragraph[] => texts.map((text, idx) => ({ idx, text }))
const prose = (n: number, seed = 'x') => Array.from({ length: n }, (_, i) => `${seed}${i} word`).join(' ') + '.'

/** A chapter of `words` words with a heading, for pairing tests. */
function chapter(idx: number, words: number, heading: string | null = `Chapter ${idx}`): Chapter {
  const paragraphs = paras(prose(words))
  return { idx, heading, sectionIdx: null, paraStart: idx * 10, paragraphs, words }
}

describe('pairChapters', () => {
  it('pairs chapters of matching relative length by position, whatever the translation ratio', () => {
    const de = [chapter(0, 50), chapter(1, 500), chapter(2, 400)]
    const en = [chapter(0, 65), chapter(1, 540), chapter(2, 470)]
    expect(pairChapters(de, en)).toEqual([
      { de: [0], en: [0] },
      { de: [1], en: [1] },
      { de: [2], en: [2] },
    ])
  })

  it('does not trust equal counts: a preface on one side and a split chapter on the other still shift', () => {
    // Werther in miniature: the English has a preface the German lacks, and the German splits
    // the last letter in two, so both sides have ten chapters, offset by one.
    const de = [500, 300, 450, 350, 600, 400, 320, 480, 200, 150].map((w, i) => chapter(i, w))
    const en = [60, 550, 330, 500, 385, 660, 440, 350, 530, 385].map((w, i) => chapter(i, w, i === 0 ? 'Preface' : `Chapter ${i}`))
    const pairs = pairChapters(de, en)
    // The preface is either dropped or folded into the first pair (the paragraph DP then
    // drops its paragraphs); either way every chapter after it lands one position over.
    const [first, ...rest] = pairs
    expect(first.en).toContain(0)
    expect(first.de.length).toBeLessThanOrEqual(1)
    const tail = first.de.length === 0 ? rest : [{ de: first.de, en: first.en.filter((j) => j !== 0) }, ...rest]
    expect(tail).toEqual([
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ de: [i], en: [i + 1] })),
      { de: [8, 9], en: [9] },
    ])
  })

  it('drops a long introduction that only one edition has, instead of shifting every chapter', () => {
    const de = [chapter(0, 100, 'Prolog'), chapter(1, 500), chapter(2, 600), chapter(3, 450), chapter(4, 700)]
    const en = [chapter(0, 1200, 'Introduction'), chapter(1, 110, 'Prologue'), chapter(2, 560), chapter(3, 660), chapter(4, 500), chapter(5, 770)]
    expect(pairChapters(de, en)).toEqual([
      { de: [], en: [0] },
      { de: [0], en: [1] },
      { de: [1], en: [2] },
      { de: [2], en: [3] },
      { de: [3], en: [4] },
      { de: [4], en: [5] },
    ])
  })

  it('returns one-sided pairs when one edition has no chapters at all', () => {
    expect(pairChapters([chapter(0, 100)], [])).toEqual([{ de: [0], en: [] }])
    expect(pairChapters([], [])).toEqual([])
  })
})

describe('pairChaptersEdited', () => {
  const de = [chapter(0, 500), chapter(1, 300), chapter(2, 450), chapter(3, 350)]
  const en = [chapter(0, 550), chapter(1, 330), chapter(2, 500), chapter(3, 385)]

  it('without edits is pairChapters with a confidence on every two-sided pair', () => {
    const pairs = pairChaptersEdited(de, en)
    expect(pairs).toMatchObject([0, 1, 2, 3].map((i) => ({ de: [i], en: [i] })))
    for (const p of pairs) {
      expect(p.confidence).toBeGreaterThan(LOW_CHAPTER_CONFIDENCE)
      expect(p.confidence).toBeLessThanOrEqual(1)
      expect(p.manual).toBeUndefined()
    }
    const [lone] = pairChaptersEdited([chapter(0, 100)], [])
    expect(lone.confidence).toBeUndefined()
  })

  it('rates a pair whose sides disagree in length as uncertain', () => {
    const pairs = pairChaptersEdited([chapter(0, 500), chapter(1, 200)], [chapter(0, 500), chapter(1, 400)])
    expect(pairs[1].confidence).toBeLessThanOrEqual(LOW_CHAPTER_CONFIDENCE)
  })

  it('pins the hand-set pairs, pairs the free chapters among themselves and keeps reading order', () => {
    // Chapter keys are paraStart here: 0, 10, 20, 30.
    const pairs = pairChaptersEdited(de, en, [{ de: [20], en: [30] }])
    expect(pairs.map((p) => `${p.de}|${p.en}${p.manual ? '*' : ''}`)).toEqual(['0|0', '1|1', '2|3*', '3|2'])
    expect(pairs[2].confidence).toBeDefined()
  })

  it('ignores a hand-set pair that names an unknown chapter or one already pinned', () => {
    const pairs = pairChaptersEdited(de, en, [
      { de: [20], en: [99] },
      { de: [10], en: [10] },
      { de: [10], en: [20] },
    ])
    expect(pairs.map((p) => `${p.de}|${p.en}${p.manual ? '*' : ''}`)).toEqual(['0|0', '1|1*', '2|2', '3|3'])
  })
})

describe('planChapters / pairKey', () => {
  const text = (...chapters: string[][]) => ({
    paragraphs: paras(...chapters.flat()),
    sections: [],
  })

  it('applies the edits, lists what was excluded and keys pairs by paragraph ranges', () => {
    // A preface longer than any chapter, which only the German has: dropped, not folded in.
    const de = text(['Vorwort', prose(60)], ['I.', prose(40)], ['II.', prose(30)], ['III.', prose(35)])
    const en = text(['I.', prose(40)], ['II.', prose(30)], ['III.', prose(35)])
    const plain = planChapters({ de, en })
    expect(plain.de.map((c) => c.heading)).toEqual(['Vorwort', 'I.', 'II.', 'III.'])
    expect(plain.excluded).toEqual({ de: [], en: [] })
    expect(plain.pairs.map((p) => `${p.de}|${p.en}`)).toEqual(['0|', '1|0', '2|1', '3|2'])

    const edited = planChapters({ de, en, edits: { de: { exclude: [1] } } })
    expect(edited.de.map((c) => c.heading)).toEqual(['I.', 'II.', 'III.'])
    expect(edited.excluded?.de.map((c) => c.heading)).toEqual(['Vorwort'])
    expect(edited.pairs.map((p) => `${p.de}|${p.en}`)).toEqual(['0|0', '1|1', '2|2'])
    // The same chapters make the same key whatever their positions.
    expect(pairKey(plain.pairs[1], plain)).toBe(pairKey(edited.pairs[0], edited))
    expect(pairKey(plain.pairs[0], plain)).toBe('1+1|')
  })
})

describe('alignBook', () => {
  const de = {
    paragraphs: paras('I.', 'Gregor lachte im Haus. Samsa schlief im Zimmer.', 'Die Mutter fand vier Wände.', 'II.', 'Gregor lachte wieder.'),
    sections: [],
  }
  const en = {
    paragraphs: paras('I.', 'Gregor laughed in the house. Samsa slept in the room.', 'Mother found four walls.', 'II.', 'Gregor laughed again.'),
    sections: [],
  }

  it('splits every paragraph into sentences and beads the paired chapters', () => {
    const result = alignBook({ de, en })
    expect(result.sentences.de.map((s) => s.text)).toEqual([
      'I.',
      'Gregor lachte im Haus.',
      'Samsa schlief im Zimmer.',
      'Die Mutter fand vier Wände.',
      'II.',
      'Gregor lachte wieder.',
    ])
    expect(result.sentences.de.map((s) => s.idx)).toEqual([0, 1, 2, 3, 4, 5])
    expect(result.sentences.en).toHaveLength(6)
    // Heading lines are chapter headings, not prose: no bead covers them.
    expect(result.beads.map((b) => `${b.deSentenceIdx.join('+')}:${b.enSentenceIdx.join('+')}`)).toEqual(['1:1', '2:2', '3:3', '5:5'])
    expect(result.chapters.de.map((c) => c.heading)).toEqual(['I.', 'II.'])
    expect(result.chapters.en.map((c) => c.heading)).toEqual(['I.', 'II.'])
    expect(result.chapters.pairs).toMatchObject([
      { de: [0], en: [0] },
      { de: [1], en: [1] },
    ])
    expect(result.chapters.de[0]).toMatchObject({ idx: 0, sectionIdx: null, paraStart: 1, paraCount: 2 })
    expect(result.stats).toMatchObject({
      sentences: { de: 6, en: 6 },
      beads: 4,
      oneToOne: 4,
      pairedChapters: 2,
      learnedPairs: 0,
      changedBeads: 0,
    })
    expect(result.stats.uncertain).toBe(result.beads.filter((b) => b.confidence <= LOW_CONFIDENCE).length)
    expect(result.lexicon).toEqual([])
  })

  it('skips the pairs it may reuse and takes the lexicon it is given (partial runs, step 17)', () => {
    const full = alignBook({ de, en })
    const first = pairKey(full.chapters.pairs[0], full.chapters)
    const seen: AlignStage[] = []
    const partial = alignBook({ de, en, reuse: [first], lexicon: [{ de: 'mutter', en: 'mother', count: 3, dice: 1 }] }, null, (p) => seen.push(p.stage))
    expect(partial.chapters).toEqual(full.chapters)
    expect(partial.sentences).toEqual(full.sentences)
    expect(partial.beads.map((b) => `${b.deSentenceIdx}:${b.enSentenceIdx}`)).toEqual(['5:5'])
    expect(partial.lexicon).toEqual([{ de: 'mutter', en: 'mother', count: 3, dice: 1 }])
    expect(partial.stats).toMatchObject({ beads: 1, pairedChapters: 1, learnedPairs: 1 })
    expect(seen).toContain('pass2')
    // Reusing everything plans the book but aligns nothing.
    const nothing = alignBook({ de, en, reuse: full.chapters.pairs.map((p) => pairKey(p, full.chapters)) })
    expect(nothing.beads).toEqual([])
    expect(nothing.chapters).toEqual(full.chapters)
  })

  it('copes with an empty side: sentences on the other side, no beads', () => {
    const result = alignBook({ de, en: { paragraphs: [], sections: [] } })
    expect(result.sentences.de).toHaveLength(6)
    expect(result.sentences.en).toHaveLength(0)
    expect(result.beads).toEqual([])
    expect(result.chapters.pairs).toMatchObject([
      { de: [0], en: [] },
      { de: [1], en: [] },
    ])
    expect(result.stats.pairedChapters).toBe(0)
  })

  it('reports progress that starts at zero, only grows, walks the stages in order and ends at 95%', () => {
    const seen: AlignProgress[] = []
    alignBook({ de, en }, null, (p) => seen.push(p))
    expect(seen[0]).toEqual({ stage: 'structure', fraction: 0 })
    expect(seen.at(-1)).toEqual({ stage: 'pass2', fraction: 0.95 })
    for (let i = 1; i < seen.length; i++) expect(seen[i].fraction).toBeGreaterThanOrEqual(seen[i - 1].fraction)
    const order: AlignStage[] = ['structure', 'sentences', 'pass1', 'pass2']
    const stages = seen.map((p) => p.stage)
    expect([...new Set(stages)]).toEqual(order)
    expect(stages.map((s) => order.indexOf(s))).toEqual([...stages.map((s) => order.indexOf(s))].sort((a, b) => a - b))
  })
})

describe('alignBook on the Kafka fixture', () => {
  const paraDe = parseTxt(read('kafka-verwandlung.de.txt'))
  const paraEn = parseTxt(read('kafka-verwandlung.en.txt'))
  const seen: AlignProgress[] = []
  const result = alignBook({ de: { paragraphs: paraDe, sections: [] }, en: { paragraphs: paraEn, sections: [] } }, null, (p) => seen.push(p))

  it('pairs the three chapters and covers every prose sentence exactly once', () => {
    expect(result.chapters.de.map((c) => c.heading)).toEqual(['I.', 'II.', 'III.'])
    expect(result.chapters.pairs).toMatchObject([
      { de: [0], en: [0] },
      { de: [1], en: [1] },
      { de: [2], en: [2] },
    ])
    const prose = (side: 'de' | 'en') => {
      const chapters = result.chapters[side]
      return result.sentences[side].filter((s) => chapters.some((c) => s.paraIdx >= c.paraStart && s.paraIdx < c.paraStart + c.paraCount))
    }
    expect(result.beads.flatMap((b) => b.deSentenceIdx)).toEqual(prose('de').map((s) => s.idx))
    expect(result.beads.flatMap((b) => b.enSentenceIdx)).toEqual(prose('en').map((s) => s.idx))
    expect(result.sentences.de).toEqual(splitParagraphs(paraDe, 'de'))
  })

  it('gives the same beads as alignTwoPass over the same blocks and ratio', () => {
    const chaptersDe = chaptersFromParagraphs(paraDe)
    const chaptersEn = chaptersFromParagraphs(paraEn)
    const blocks: ParagraphBlock[] = []
    for (const [i, c] of chaptersDe.entries()) {
      const other = chaptersEn[i].paragraphs
      for (const b of alignParagraphs(c.paragraphs, other)) {
        blocks.push({ de: b.de.map((x) => c.paragraphs[x].idx), en: b.en.map((y) => other[y].idx) })
      }
    }
    const chars = (ps: readonly { text: string }[]) => ps.reduce((n, p) => n + p.text.length, 0)
    const inChapters = (sentences: ReturnType<typeof splitParagraphs>, chapters: Chapter[]) =>
      sentences.filter((s) => chapters.some((c) => c.paragraphs.some((p) => p.idx === s.paraIdx)))
    const sentDe = splitParagraphs(paraDe, 'de')
    const sentEn = splitParagraphs(paraEn, 'en')
    const ratio = chars(inChapters(sentEn, chaptersEn)) / chars(inChapters(sentDe, chaptersDe))
    const reference = alignTwoPass(sentDe, sentEn, blocks, null, { ratio })
    expect(result.beads).toEqual(reference.beads)
    expect(result.lexicon).toEqual([...reference.lexicon.pairs])
    expect(result.stats.learnedPairs).toBe(reference.lexicon.pairs.length)
  })

  it('reports plausible stats and moves the bar through both passes', () => {
    expect(result.stats.beads).toBeGreaterThan(600)
    expect(result.stats.oneToOne / result.stats.beads).toBeGreaterThan(0.8)
    expect(result.stats.learnedPairs).toBeGreaterThan(100)
    expect(result.stats.pairedChapters).toBe(3)
    expect(result.stats.elapsedMs).toBeLessThan(10_000)
    expect(seen.filter((p) => p.stage === 'pass1').length).toBeGreaterThanOrEqual(4)
    expect(seen.filter((p) => p.stage === 'pass2').length).toBeGreaterThanOrEqual(4)
  })
})
