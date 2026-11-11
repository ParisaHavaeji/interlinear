// Alignment repair (plan.md step 20): block recovery, the repair operations, and persistence.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { alignSentences } from '../src/align/beads.ts'
import { prepareSentence } from '../src/align/features.ts'
import { inlineRunner, startAlignment } from '../src/align/jobs.ts'
import {
  applyRepair,
  BlockIndex,
  describeBead,
  dpRealigner,
  repairBlock,
  repairRatio,
  type Block,
  type BlockSentence,
  type IndexedBead,
  type Realigner,
  type RepairBead,
  type RepairContext,
} from '../src/align/repair.ts'
import type { ImportedText } from '../src/import/file.ts'
import { addBook } from '../src/store/books.ts'
import { openDatabase, type InterlinearDB } from '../src/store/db.ts'

const bead = (beadIdx: number, de: number[], en: number[], manual = false): IndexedBead => ({
  beadIdx,
  deSentenceIdx: de,
  enSentenceIdx: en,
  confidence: manual ? 1 : 0.9,
  manual,
})

/** "∅:0 | 1:1* | 2:∅" — beads in order, a star for a pinned one. */
const shape = (beads: readonly RepairBead[]) =>
  beads.map((b) => `${b.deSentenceIdx.join('+') || '∅'}:${b.enSentenceIdx.join('+') || '∅'}${b.manual ? '*' : ''}`).join(' | ')

const sentences = (paras: Record<number, number[]>): BlockSentence[] =>
  Object.entries(paras).flatMap(([para, ids]) => ids.map((idx) => ({ idx, paraIdx: Number(para) })))

// German paragraphs 0–2 against English 0–2 (paragraph 2 on each side is unaligned text),
// then German paragraphs 3 and 4 translated as one English paragraph 3, then a paragraph pair
// (4 | 4) whose second German sentence has no translation.
const DE = sentences({ 0: [0, 1, 2], 1: [3, 4], 2: [5], 3: [6], 4: [7], 5: [8, 9] })
const EN = sentences({ 0: [0, 1], 1: [2, 3, 4], 2: [5], 3: [6, 7], 4: [8] })
const BEADS: IndexedBead[] = [
  bead(0, [0], [0]),
  bead(1, [1, 2], [1]),
  bead(2, [3], [2, 3]),
  bead(3, [4], [4]),
  bead(4, [6], [6]),
  bead(5, [7], [7]),
  bead(6, [8], [8]),
  bead(7, [9], []),
]

describe('BlockIndex', () => {
  const index = new BlockIndex([...BEADS].reverse(), DE, EN)

  it('recovers a paragraph block from the beads, with its beads in reading order', () => {
    expect(index.blockOf(1)).toEqual({ de: [0, 1, 2], en: [0, 1], beads: [BEADS[0], BEADS[1]], start: 0 })
    expect(index.blockOf(4)).toEqual({ de: [3, 4], en: [2, 3, 4], beads: [BEADS[2], BEADS[3]], start: 2 })
  })

  it('joins paragraphs that beads link, as a 2-1 paragraph bead does', () => {
    expect(index.blockOf(7)).toEqual({ de: [6, 7], en: [6, 7], beads: [BEADS[4], BEADS[5]], start: 4 })
  })

  it('has no block for a sentence in no bead, or an unknown one', () => {
    expect(index.blockOf(5)).toBeNull()
    expect(index.blockOf(99)).toBeNull()
  })
})

describe('describeBead', () => {
  const index = new BlockIndex(BEADS, DE, EN)
  const block = (deIdx: number): Block => index.blockOf(deIdx)!

  it('shows the English neighbours and allows what fits at the start of a block', () => {
    expect(describeBead(block(0), 0)).toEqual({
      bead: BEADS[0],
      before: null,
      after: 1,
      options: { shiftEarlier: false, shiftLater: true, mergePrevious: false, mergeNext: true, split: false, reset: false },
    })
  })

  it('allows a split of a 2-1 bead and nothing past the end of the block', () => {
    expect(describeBead(block(2), 2)).toEqual({
      bead: BEADS[1],
      before: 0,
      after: null,
      options: { shiftEarlier: true, shiftLater: false, mergePrevious: true, mergeNext: false, split: true, reset: false },
    })
  })

  it('places a 1-0 bead between its neighbours', () => {
    expect(describeBead(block(9), 9)).toEqual({
      bead: BEADS[7],
      before: 8,
      after: null,
      options: { shiftEarlier: true, shiftLater: false, mergePrevious: true, mergeNext: false, split: false, reset: false },
    })
  })

  it('offers Reset only for a bead fixed by hand', () => {
    const pinned: Block = { de: [0, 1], en: [0, 1], beads: [bead(0, [0], [0], true), bead(1, [1], [1])], start: 0 }
    expect(describeBead(pinned, 0)!.options.reset).toBe(true)
    expect(describeBead(pinned, 1)!.options.reset).toBe(false)
  })

  it('is null for a sentence in none of the block’s beads', () => {
    expect(describeBead(block(0), 42)).toBeNull()
  })
})

describe('repairBlock', () => {
  /** Pairs the sentences one to one in order, the rest one-sided, and records what it was asked. */
  function recorder() {
    const calls: { de: number[]; en: number[]; maxSize?: number }[] = []
    const realign: Realigner = (de, en, options) => {
      const call: { de: number[]; en: number[]; maxSize?: number } = { de: [...de], en: [...en] }
      if (options?.maxSize !== undefined) call.maxSize = options.maxSize
      calls.push(call)
      const out: RepairBead[] = []
      const n = Math.max(de.length, en.length)
      for (let i = 0; i < n; i++) {
        out.push({ deSentenceIdx: i < de.length ? [de[i]] : [], enSentenceIdx: i < en.length ? [en[i]] : [], confidence: 0.75, manual: false })
      }
      return out
    }
    return { calls, realign }
  }
  const index = new BlockIndex(BEADS, DE, EN)
  const block = (deIdx: number): Block => index.blockOf(deIdx)!

  it('shifts the translation later, pins the bead and re-aligns the free sentences on either side', () => {
    const { calls, realign } = recorder()
    const out = repairBlock(block(0), 0, { kind: 'shift', by: 1 }, realign)
    expect(shape(out)).toBe('∅:0 | 0:1* | 1:∅ | 2:∅')
    expect(out[1].confidence).toBe(1)
    expect(calls).toEqual([
      { de: [], en: [0] },
      { de: [1, 2], en: [] },
    ])
  })

  it('refuses to shift past the ends of the block', () => {
    const { realign } = recorder()
    expect(() => repairBlock(block(0), 0, { kind: 'shift', by: -1 }, realign)).toThrow(/no sentence further/)
    expect(() => repairBlock(block(2), 2, { kind: 'shift', by: 1 }, realign)).toThrow(/no sentence further/)
  })

  it('gives a sentence without translation the English sentence on the side chosen', () => {
    const { realign } = recorder()
    expect(shape(repairBlock(block(9), 9, { kind: 'shift', by: -1 }, realign))).toBe('8:∅ | 9:8*')
    expect(() => repairBlock(block(9), 9, { kind: 'shift', by: 1 }, realign)).toThrow(/no sentence further/)
  })

  it('merges with the next or previous bead, both sides, without re-aligning anything', () => {
    const { calls, realign } = recorder()
    expect(shape(repairBlock(block(0), 0, { kind: 'merge', dir: 1 }, realign))).toBe('0+1+2:0+1*')
    expect(shape(repairBlock(block(4), 4, { kind: 'merge', dir: -1 }, realign))).toBe('3+4:2+3+4*')
    expect(calls).toEqual([])
    expect(() => repairBlock(block(0), 0, { kind: 'merge', dir: -1 }, realign)).toThrow(/first sentence/)
    expect(() => repairBlock(block(2), 2, { kind: 'merge', dir: 1 }, realign)).toThrow(/last sentence/)
  })

  it('splits a bead into single sentences through the aligner and pins the pieces', () => {
    const { calls, realign } = recorder()
    expect(shape(repairBlock(block(1), 1, { kind: 'split' }, realign))).toBe('0:0 | 1:1* | 2:∅*')
    expect(calls[0]).toEqual({ de: [1, 2], en: [1], maxSize: 1 })
    expect(() => repairBlock(block(0), 0, { kind: 'split' }, realign)).toThrow(/single sentence already/)
  })

  it('resets a pinned bead and lets the aligner redo the block', () => {
    const { calls, realign } = recorder()
    const pinned: Block = { de: [0, 1, 2], en: [0, 1], beads: [bead(0, [0], [0], true), bead(1, [1, 2], [1])], start: 0 }
    expect(shape(repairBlock(pinned, 0, { kind: 'reset' }, realign))).toBe('0:0 | 1:1 | 2:∅')
    expect(calls).toEqual([{ de: [0, 1, 2], en: [0, 1] }])
    expect(() => repairBlock(block(0), 0, { kind: 'reset' }, realign)).toThrow(/aligned automatically/)
  })

  it('keeps older pins that the new one leaves alone and drops those it overlaps', () => {
    const three: Block = { de: [0, 1, 2], en: [0, 1, 2], beads: [bead(0, [0], [0], true), bead(1, [1], [1]), bead(2, [2], [2])], start: 0 }
    const { realign } = recorder()
    expect(shape(repairBlock(three, 1, { kind: 'shift', by: 1 }, realign))).toBe('0:0* | ∅:1 | 1:2* | 2:∅')
    expect(shape(repairBlock(three, 1, { kind: 'shift', by: -1 }, realign))).toBe('0:∅ | 1:0* | 2:1 | ∅:2')
  })

  it('refuses a block whose beads do not tile its sentences', () => {
    const broken: Block = { de: [0, 1, 2], en: [0, 1], beads: [bead(0, [0], [0]), bead(1, [2], [1])], start: 0 }
    const { realign } = recorder()
    expect(() => repairBlock(broken, 0, { kind: 'shift', by: 1 }, realign)).toThrow(/inconsistent/)
  })
})

describe('dpRealigner and the bead size cap', () => {
  const texts = {
    de: new Map([
      [10, 'Gregor lachte im Haus.'],
      [11, 'Samsa schlief im Zimmer.'],
      [12, 'Die Mutter fand vier Wände.'],
    ]),
    en: new Map([
      [20, 'Gregor laughed in the house.'],
      [21, 'Samsa slept in the room.'],
      [22, 'Mother found four walls.'],
    ]),
  }
  const text = { de: (i: number) => texts.de.get(i), en: (j: number) => texts.en.get(j) }

  it('runs the sentence DP over the given ids and maps the beads back to them', () => {
    const realign = dpRealigner(text, null, 1)
    const beads = realign([10, 11, 12], [20, 21, 22])
    expect(shape(beads)).toBe('10:20 | 11:21 | 12:22')
    for (const b of beads) expect(b.confidence).toBeGreaterThan(0.5)
    expect(shape(realign([10], []))).toBe('10:∅')
    expect(realign([], [])).toEqual([])
  })

  it('never builds a bead larger than one sentence a side when capped', () => {
    const de = ['Er kam. Er sah.', 'Er siegte, und alle jubelten laut, sehr laut, über ihn.'].map((t) => prepareSentence(t, 'de'))
    const en = ['He came.', 'He saw.', 'He conquered, and everyone cheered loudly, very loudly, about him.'].map((t) => prepareSentence(t, 'en'))
    const capped = alignSentences(de, en, { ratio: 1, maxSize: 1 })
    for (const b of capped) {
      expect(b.de.length).toBeLessThanOrEqual(1)
      expect(b.en.length).toBeLessThanOrEqual(1)
    }
    expect(capped.flatMap((b) => b.de)).toEqual([0, 1])
    expect(capped.flatMap((b) => b.en)).toEqual([0, 1, 2])
    expect(alignSentences(de, en, { ratio: 1 }).some((b) => b.de.length === 1 && b.en.length === 2)).toBe(true)
  })

  it('estimates the length ratio over the aligned text', () => {
    const beads: RepairBead[] = [{ deSentenceIdx: [10, 11], enSentenceIdx: [20, 21], confidence: 1, manual: false }]
    expect(repairRatio(beads, text)).toBeCloseTo((28 + 24) / (22 + 24))
    expect(repairRatio([], text)).toBe(1)
    // Clamped like the pipeline's estimate.
    expect(repairRatio([{ deSentenceIdx: [10], enSentenceIdx: [20, 21, 22], confidence: 1, manual: false }], text)).toBe(2)
  })
})

describe('applyRepair', () => {
  let db: InterlinearDB
  let n = 0
  beforeEach(() => {
    db = openDatabase(`repair-${n++}`)
  })
  afterEach(() => db.delete())

  function txt(fileName: string, body: string): ImportedText {
    const paragraphs = body.split('\n\n').map((t, idx) => ({ idx, text: t }))
    return { fileName, format: 'txt', paragraphs, sections: [], words: body.split(/\s+/).length, meta: null }
  }
  const DE_TEXT = txt('k.de.txt', 'I.\n\nGregor lachte im Haus. Samsa schlief im Zimmer.\n\nDie Mutter fand vier Wände.\n\nII.\n\nGregor lachte wieder.')
  const EN_TEXT = txt('k.en.txt', 'I.\n\nGregor laughed in the house. Samsa slept in the room.\n\nMother found four walls.\n\nII.\n\nGregor laughed again.')

  async function aligned(): Promise<string> {
    const book = await addBook({ title: 'K', author: '', de: DE_TEXT, en: EN_TEXT }, db)
    await startAlignment(book.id, { db, runner: inlineRunner })
    return book.id
  }

  /** The context the Reader would build from its live query. */
  async function contextFor(bookId: string): Promise<RepairContext> {
    const book = (await db.books.get(bookId))!
    const [de, en, beads] = await Promise.all([
      db.sentences.where('[bookId+lang]').equals([bookId, 'de']).toArray(),
      db.sentences.where('[bookId+lang]').equals([bookId, 'en']).toArray(),
      db.beads.where('bookId').equals(bookId).sortBy('beadIdx'),
    ])
    const deText = new Map(de.map((s) => [s.idx, s.text]))
    const enText = new Map(en.map((s) => [s.idx, s.text]))
    return { book, blocks: new BlockIndex(beads, de, en), text: { de: (i) => deText.get(i), en: (j) => enText.get(j) } }
  }

  const stored = async (bookId: string) => {
    const rows = await db.beads.where('bookId').equals(bookId).sortBy('beadIdx')
    return { shape: shape(rows), idx: rows.map((b) => b.beadIdx) }
  }

  it('rewrites the block’s beads, renumbers the rest and refreshes the stats', async () => {
    const bookId = await aligned()
    const before = (await db.books.get(bookId))!.alignment!
    expect((await stored(bookId)).shape).toBe('1:1 | 2:2 | 3:3 | 5:5')

    const fresh = await applyRepair(await contextFor(bookId), 1, { kind: 'shift', by: 1 }, db)
    expect(shape(fresh)).toBe('∅:1 | 1:2* | 2:∅')
    expect(await stored(bookId)).toEqual({ shape: '∅:1 | 1:2* | 2:∅ | 3:3 | 5:5', idx: [0, 1, 2, 3, 4] })

    const after = (await db.books.get(bookId))!.alignment!
    expect(after.status).toBe('ready')
    expect(after.updated).toBeGreaterThanOrEqual(before.updated)
    expect(after.stats).toMatchObject({ beads: 5, oneToOne: 3, pairedChapters: before.stats!.pairedChapters })
    expect(after.chapters).toEqual(before.chapters)
  })

  it('applies repairs one after another, and Reset hands the block back to the aligner', async () => {
    const bookId = await aligned()
    await applyRepair(await contextFor(bookId), 1, { kind: 'shift', by: 1 }, db)
    await applyRepair(await contextFor(bookId), 1, { kind: 'reset' }, db)
    expect(await stored(bookId)).toEqual({ shape: '1:1 | 2:2 | 3:3 | 5:5', idx: [0, 1, 2, 3] })
    await applyRepair(await contextFor(bookId), 2, { kind: 'merge', dir: -1 }, db)
    expect((await stored(bookId)).shape).toBe('1+2:1+2* | 3:3 | 5:5')
    expect((await db.books.get(bookId))!.alignment!.stats).toMatchObject({ beads: 3, oneToOne: 2 })
  })

  it('refuses a repair from stale data, an unaligned sentence, and a book that is not ready', async () => {
    const bookId = await aligned()
    const stale = await contextFor(bookId)
    await applyRepair(await contextFor(bookId), 1, { kind: 'shift', by: 1 }, db)
    await expect(applyRepair(stale, 1, { kind: 'shift', by: 1 }, db)).rejects.toThrow(/changed underneath/)
    expect((await stored(bookId)).shape).toBe('∅:1 | 1:2* | 2:∅ | 3:3 | 5:5')

    await expect(applyRepair(await contextFor(bookId), 0, { kind: 'shift', by: 1 }, db)).rejects.toThrow(/not aligned/)

    const context = await contextFor(bookId)
    await db.books.update(bookId, { alignment: { status: 'aligning', updated: Date.now() } })
    await expect(applyRepair(context, 2, { kind: 'shift', by: -1 }, db)).rejects.toThrow(/not aligned/)
  })
})
