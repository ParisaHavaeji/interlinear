/**
 * Alignment repair (plan.md step 20, §1.2 "Fallbacks & escape hatches"): the last resort when
 * the aligner got a sentence wrong. The reader long-presses a German sentence and fixes its
 * bead by hand: shift the English side one sentence earlier or later, merge the bead with the
 * one before or after, or split it into single sentences. A fix *pins* the bead (`manual`), and
 * Layer C runs again over the free sentences around it, so one fix cascades through the rest of
 * the paragraph instead of leaving every later bead off by one. Pins survive later repairs
 * (unless a new pin overlaps them) and chapter edits (`mergeAlignment` keeps the beads of
 * unchanged chapter pairs); a full re-alignment of the book replaces them.
 *
 * **Blocks.** The sentence DP runs inside a paragraph block (the paragraph beads of Layer A),
 * and the store does not keep those. They are recovered from the beads: paragraphs joined by
 * a bead belong together, so a block is a connected set of paragraphs of both sides, with every
 * sentence of those paragraphs and every bead among them ({@link BlockIndex}). Beads never
 * cross a block, so a block's beads are contiguous in the book's reading order (`beadIdx`) and
 * tile the block's sentences on both sides, which {@link repairBlock} relies on.
 *
 * **Pins.** A repair produces one new pinned bead (or, for a split, several; none for a reset).
 * The block's other manual beads stay pinned unless the new pin shares a sentence with them:
 * the newest pin wins. The pins cut the block into free sub-blocks (the sentences before the
 * first pin, between pins, after the last), each aligned afresh by {@link alignSentences} with
 * the book's stored lexicon and length ratio. The semantic feature of a neural book (step 15)
 * is not available on the main thread, so a repair re-aligns its block classically; the pin
 * itself is what the reader asked for.
 *
 * {@link applyRepair} does the whole thing against Dexie: it checks the stored beads of the
 * block are the ones the repair started from, rewrites the beads from the block's first one
 * on (renumbered), and refreshes the book's stats. The model above it is pure, for the tests.
 */

import { db as sharedDb, type AlignmentState, type BeadRow, type Book, type InterlinearDB } from '../store/db.ts'
import { alignSentences } from './beads.ts'
import { prepareSentence, type Lexicon } from './features.ts'
import { InducedLexicon } from './lexicon.ts'
import { LOW_CONFIDENCE } from './pipeline.ts'
import { ratioOf } from './structure.ts'

// ---------------------------------------------------------------------------------------------
// Blocks

/** The part of a bead row the repair works with. */
export interface RepairBead {
  deSentenceIdx: number[]
  enSentenceIdx: number[]
  confidence: number
  manual: boolean
}

/** A stored bead: {@link RepairBead} with its position in the book's reading order. */
export interface IndexedBead extends RepairBead {
  beadIdx: number
}

/** A sentence as the block index needs it. */
export interface BlockSentence {
  idx: number
  paraIdx: number
}

/** A paragraph block: the sentences of its paragraphs on both sides and the beads among them. */
export interface Block {
  /** German sentence ids, ascending. */
  de: number[]
  /** English sentence ids, ascending. */
  en: number[]
  /** The block's beads in reading order. */
  beads: IndexedBead[]
  /** `beadIdx` of the first bead; the block's beads are contiguous from there. */
  start: number
}

/**
 * The paragraph blocks of a book, recovered from its beads (see the module comment), looked
 * up by German sentence. Built once per load; the reader keeps it with the book's data.
 */
export class BlockIndex {
  private readonly deParaOf = new Map<number, number>()
  /** Component root per paragraph node (`d<para>` / `e<para>`), after union-find. */
  private readonly root = new Map<string, string>()
  private readonly members = new Map<string, { de: Set<number>; en: Set<number>; beads: IndexedBead[] }>()
  private readonly byPara: { de: Map<number, number[]>; en: Map<number, number[]> } = { de: new Map(), en: new Map() }
  /** Every bead of the book, as given. */
  readonly beads: readonly IndexedBead[]

  constructor(beads: readonly IndexedBead[], de: readonly BlockSentence[], en: readonly BlockSentence[]) {
    this.beads = beads
    const enParaOf = new Map<number, number>()
    for (const s of de) {
      this.deParaOf.set(s.idx, s.paraIdx)
      push(this.byPara.de, s.paraIdx, s.idx)
    }
    for (const s of en) {
      enParaOf.set(s.idx, s.paraIdx)
      push(this.byPara.en, s.paraIdx, s.idx)
    }
    for (const list of this.byPara.de.values()) list.sort((a, b) => a - b)
    for (const list of this.byPara.en.values()) list.sort((a, b) => a - b)

    // Union-find over paragraph nodes: every bead joins the paragraphs of all its sentences.
    const parent = new Map<string, string>()
    const find = (x: string): string => {
      let r = x
      while (parent.get(r) !== r) r = parent.get(r)!
      let y = x
      while (y !== r) {
        const next = parent.get(y)!
        parent.set(y, r)
        y = next
      }
      return r
    }
    const node = (x: string) => {
      if (!parent.has(x)) parent.set(x, x)
      return x
    }
    for (const b of beads) {
      const nodes: string[] = []
      for (const i of b.deSentenceIdx) {
        const p = this.deParaOf.get(i)
        if (p !== undefined) nodes.push(node(`d${p}`))
      }
      for (const j of b.enSentenceIdx) {
        const p = enParaOf.get(j)
        if (p !== undefined) nodes.push(node(`e${p}`))
      }
      for (let k = 1; k < nodes.length; k++) {
        const a = find(nodes[0])
        const c = find(nodes[k])
        if (a !== c) parent.set(c, a)
      }
    }
    for (const x of parent.keys()) {
      const r = find(x)
      this.root.set(x, r)
      let m = this.members.get(r)
      if (m === undefined) {
        m = { de: new Set(), en: new Set(), beads: [] }
        this.members.set(r, m)
      }
      if (x[0] === 'd') m.de.add(Number(x.slice(1)))
      else m.en.add(Number(x.slice(1)))
    }
    for (const b of beads) {
      const first = b.deSentenceIdx.length > 0 ? `d${this.deParaOf.get(b.deSentenceIdx[0])}` : `e${enParaOf.get(b.enSentenceIdx[0])}`
      const r = this.root.get(first)
      if (r !== undefined) this.members.get(r)!.beads.push(b)
    }
    for (const m of this.members.values()) m.beads.sort((a, b) => a.beadIdx - b.beadIdx)
  }

  /** The block a German sentence is in; null for a sentence in no bead (unaligned text). */
  blockOf(deIdx: number): Block | null {
    const para = this.deParaOf.get(deIdx)
    if (para === undefined) return null
    const r = this.root.get(`d${para}`)
    if (r === undefined) return null
    const m = this.members.get(r)!
    if (m.beads.length === 0) return null
    const sentencesOf = (paras: Set<number>, byPara: Map<number, number[]>) =>
      [...paras]
        .sort((a, b) => a - b)
        .flatMap((p) => byPara.get(p) ?? [])
    return { de: sentencesOf(m.de, this.byPara.de), en: sentencesOf(m.en, this.byPara.en), beads: m.beads, start: m.beads[0].beadIdx }
  }
}

function push(map: Map<number, number[]>, key: number, value: number): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [value])
  else list.push(value)
}

// ---------------------------------------------------------------------------------------------
// The repair model

export type RepairOp =
  /** Move the bead's English side one sentence earlier (−1) or later (+1); a 1-0 bead takes the sentence on that side. */
  | { kind: 'shift'; by: -1 | 1 }
  /** Join the bead with the one before (−1) or after (+1) it. */
  | { kind: 'merge'; dir: -1 | 1 }
  /** Break the bead into single sentences; the scores pair them up. */
  | { kind: 'split' }
  /** Unpin a bead fixed by hand and let the aligner redo its sentences. */
  | { kind: 'reset' }

/** Which operations a bead allows. */
export interface RepairOptions {
  shiftEarlier: boolean
  shiftLater: boolean
  mergePrevious: boolean
  mergeNext: boolean
  split: boolean
  reset: boolean
}

/** A bead of a block with its position ranges (half-open, into `Block.de` / `Block.en`). */
interface Placed {
  de: [number, number]
  en: [number, number]
  bead: RepairBead
}

/**
 * Give every bead of a block its position ranges, in reading order. Throws when the beads do
 * not tile the block's sentences on both sides, which no alignment of ours produces.
 */
function placeBeads(block: Block, beads: readonly RepairBead[] = block.beads, from: [number, number] = [0, 0]): Placed[] {
  const out: Placed[] = []
  let [cd, ce] = from
  const broken = () => new Error('The alignment of this paragraph is inconsistent; re-align the book to repair it')
  for (const bead of beads) {
    const de = [...bead.deSentenceIdx].sort((a, b) => a - b)
    const en = [...bead.enSentenceIdx].sort((a, b) => a - b)
    for (const [x, idx] of de.entries()) if (block.de[cd + x] !== idx) throw broken()
    for (const [y, idx] of en.entries()) if (block.en[ce + y] !== idx) throw broken()
    out.push({ de: [cd, cd + de.length], en: [ce, ce + en.length], bead })
    cd += de.length
    ce += en.length
  }
  if (beads === block.beads && (cd !== block.de.length || ce !== block.en.length)) throw broken()
  return out
}

/** Which operations the bead of a German sentence allows, and the English sentences around it. */
export interface BeadDescription {
  bead: RepairBead
  /** The English sentence just before the bead's English side (or, for a 1-0 bead, before the gap). */
  before: number | null
  /** The English sentence just after it. */
  after: number | null
  options: RepairOptions
}

/** Describe the bead a German sentence is in. Null when the sentence is in none of the block's beads. */
export function describeBead(block: Block, deIdx: number): BeadDescription | null {
  const placed = placeBeads(block)
  const pos = placed.findIndex((p) => p.bead.deSentenceIdx.includes(deIdx))
  if (pos < 0) return null
  const target = placed[pos]
  const [e0, e1] = target.en
  const empty = e1 === e0
  const bead = target.bead
  return {
    bead,
    before: e0 > 0 ? block.en[e0 - 1] : null,
    after: e1 < block.en.length ? block.en[e1] : null,
    options: {
      shiftEarlier: e0 > 0,
      shiftLater: empty ? e0 < block.en.length : e1 < block.en.length,
      mergePrevious: pos > 0,
      mergeNext: pos < placed.length - 1,
      split: bead.deSentenceIdx.length > 1 || bead.enSentenceIdx.length > 1,
      reset: bead.manual,
    },
  }
}

/**
 * Aligns the given sentences (book-wide ids, ascending) afresh and returns their beads in
 * reading order, with `manual: false`. {@link dpRealigner} is the real one.
 */
export type Realigner = (de: readonly number[], en: readonly number[], options?: { maxSize?: number }) => RepairBead[]

/**
 * Apply an operation to the bead of a German sentence and re-align the rest of the block
 * around the pins (see the module comment). Returns the block's new beads in reading order,
 * ready to replace `block.beads`. Throws when the operation does not apply to the bead.
 */
export function repairBlock(block: Block, deIdx: number, op: RepairOp, realign: Realigner): RepairBead[] {
  const placed = placeBeads(block)
  const pos = placed.findIndex((p) => p.bead.deSentenceIdx.includes(deIdx))
  if (pos < 0) throw new Error('This sentence is not aligned with the translation')
  const target = placed[pos]
  const pin = (de: [number, number], en: [number, number]): Placed => ({
    de,
    en,
    bead: { deSentenceIdx: block.de.slice(de[0], de[1]), enSentenceIdx: block.en.slice(en[0], en[1]), confidence: 1, manual: true },
  })

  let fresh: Placed[]
  switch (op.kind) {
    case 'shift': {
      const [e0, e1] = target.en
      const ne0 = e1 > e0 ? e0 + op.by : op.by > 0 ? e0 : e0 - 1
      const ne1 = e1 > e0 ? e1 + op.by : ne0 + 1
      if (ne0 < 0 || ne1 > block.en.length) throw new Error('The translation has no sentence further that way in this paragraph')
      fresh = [pin(target.de, [ne0, ne1])]
      break
    }
    case 'merge': {
      const other = placed[pos + op.dir]
      if (other === undefined) throw new Error(op.dir < 0 ? 'This is the first sentence of its paragraph' : 'This is the last sentence of its paragraph')
      fresh = [
        pin(
          [Math.min(target.de[0], other.de[0]), Math.max(target.de[1], other.de[1])],
          [Math.min(target.en[0], other.en[0]), Math.max(target.en[1], other.en[1])],
        ),
      ]
      break
    }
    case 'split': {
      if (target.bead.deSentenceIdx.length <= 1 && target.bead.enSentenceIdx.length <= 1) throw new Error('This is a single sentence already')
      const pieces = realign(block.de.slice(target.de[0], target.de[1]), block.en.slice(target.en[0], target.en[1]), { maxSize: 1 })
      fresh = placeBeads(block, pieces, [target.de[0], target.en[0]]).map((p) => ({ ...p, bead: { ...p.bead, confidence: 1, manual: true } }))
      break
    }
    case 'reset': {
      if (!target.bead.manual) throw new Error('This sentence was aligned automatically')
      fresh = []
      break
    }
  }

  // Older pins stay unless the new ones share a sentence with them; the target is replaced.
  const overlaps = (a: Placed, b: Placed) => (a.de[0] < b.de[1] && b.de[0] < a.de[1]) || (a.en[0] < b.en[1] && b.en[0] < a.en[1])
  const kept = placed.filter((p, i) => i !== pos && p.bead.manual && !fresh.some((f) => overlaps(f, p)))
  const pins = [...kept, ...fresh].sort((a, b) => a.de[0] - b.de[0] || a.en[0] - b.en[0])

  // Free sub-blocks between the pins, each aligned afresh.
  const out: RepairBead[] = []
  let cd = 0
  let ce = 0
  const free = (d1: number, e1: number) => {
    if (d1 < cd || e1 < ce) throw new Error('The alignment of this paragraph is inconsistent; re-align the book to repair it')
    if (d1 > cd || e1 > ce) out.push(...realign(block.de.slice(cd, d1), block.en.slice(ce, e1)))
  }
  for (const p of pins) {
    free(p.de[0], p.en[0])
    out.push(p.bead)
    cd = p.de[1]
    ce = p.en[1]
  }
  free(block.de.length, block.en.length)
  return out
}

// ---------------------------------------------------------------------------------------------
// The real aligner and the store

/** Sentence text by book-wide id, for both sides. */
export interface SentenceText {
  de: (idx: number) => string | undefined
  en: (idx: number) => string | undefined
}

/** The lexicon the book's alignment learned (pass two), as Layer C would consult it; null when it learned nothing. */
export function lexiconOf(book: Book): Lexicon | null {
  const pairs = book.alignment?.lexicon ?? []
  return pairs.length === 0 ? null : new InducedLexicon(pairs)
}

/**
 * The book-wide English-to-German character ratio over the aligned text, as the pipeline
 * estimated it over the paired chapters.
 */
export function repairRatio(beads: readonly RepairBead[], text: SentenceText): number {
  let de = 0
  let en = 0
  for (const b of beads) {
    for (const i of b.deSentenceIdx) de += text.de(i)?.length ?? 0
    for (const j of b.enSentenceIdx) en += text.en(j)?.length ?? 0
  }
  return ratioOf(de, en)
}

/** The sentence DP of Layer C over the given sentences, with the book's lexicon and ratio. */
export function dpRealigner(text: SentenceText, lexicon: Lexicon | null, ratio: number): Realigner {
  return (de, en, options) => {
    const prepDe = de.map((i) => prepareSentence(text.de(i) ?? '', 'de', lexicon))
    const prepEn = en.map((j) => prepareSentence(text.en(j) ?? '', 'en'))
    const beads = options?.maxSize === undefined ? alignSentences(prepDe, prepEn, { ratio }) : alignSentences(prepDe, prepEn, { ratio, maxSize: options.maxSize })
    return beads.map((b) => ({
      deSentenceIdx: b.de.map((x) => de[x]),
      enSentenceIdx: b.en.map((y) => en[y]),
      confidence: b.confidence,
      manual: false,
    }))
  }
}

/** What {@link applyRepair} needs from the reader: the book and what it has loaded of it. */
export interface RepairContext {
  book: Book
  blocks: BlockIndex
  text: SentenceText
}

/**
 * Repair the bead of a German sentence and persist the result: the beads from the block's
 * first one on are rewritten (the block's new beads, then the rest renumbered) in one
 * transaction, and the book's stats and `updated` time refreshed. Refuses when the stored
 * beads of the block are not the ones in `context` any more (another write got in first) or
 * when the book is not ready. Returns the block's new beads.
 */
export async function applyRepair(context: RepairContext, deIdx: number, op: RepairOp, db: InterlinearDB = sharedDb()): Promise<RepairBead[]> {
  const block = context.blocks.blockOf(deIdx)
  if (block === null) throw new Error('This sentence is not aligned with the translation')
  const ratio = repairRatio(context.blocks.beads, context.text)
  const fresh = repairBlock(block, deIdx, op, dpRealigner(context.text, lexiconOf(context.book), ratio))
  const bookId = context.book.id

  await db.transaction('rw', [db.books, db.beads], async () => {
    const book = await db.books.get(bookId)
    if (book?.alignment?.status !== 'ready') throw new Error('The book is not aligned')
    const all = await db.beads.where('bookId').equals(bookId).sortBy('beadIdx')
    const at = all.findIndex((b) => b.beadIdx === block.start)
    const stored = at < 0 ? [] : all.slice(at, at + block.beads.length)
    const same =
      all.length === context.blocks.beads.length &&
      stored.length === block.beads.length &&
      stored.every((row, k) => row.beadIdx === block.beads[k].beadIdx && sameSentences(row, block.beads[k]))
    if (!same) throw new Error('The alignment changed underneath this repair; try again')

    const tail: BeadRow[] = [...fresh.map((b) => ({ bookId, beadIdx: 0, ...b })), ...all.slice(at + block.beads.length)].map((b, k) => ({
      ...b,
      beadIdx: block.start + k,
    }))
    await db.beads
      .where('[bookId+beadIdx]')
      .between([bookId, block.start], [bookId, Number.MAX_SAFE_INTEGER], true, true)
      .delete()
    await db.beads.bulkAdd(tail)

    const beads = [...all.slice(0, at), ...tail]
    const alignment: AlignmentState = { ...book.alignment, updated: Date.now() }
    if (alignment.stats !== undefined) {
      alignment.stats = {
        ...alignment.stats,
        beads: beads.length,
        oneToOne: beads.filter((b) => b.deSentenceIdx.length === 1 && b.enSentenceIdx.length === 1).length,
        uncertain: beads.filter((b) => b.confidence <= LOW_CONFIDENCE).length,
      }
    }
    await db.books.update(bookId, { alignment })
  })
  return fresh
}

function sameSentences(a: RepairBead, b: RepairBead): boolean {
  const eq = (x: readonly number[], y: readonly number[]) => x.length === y.length && x.every((v, i) => v === y[i])
  return eq(a.deSentenceIdx, b.deSentenceIdx) && eq(a.enSentenceIdx, b.enSentenceIdx) && a.manual === b.manual
}
