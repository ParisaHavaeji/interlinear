/**
 * The sentence card's model (plan.md step 19, §1.5), kept apart from the DOM so it can be
 * tested: which bead a tapped sentence belongs to, what the card shows for it, how Previous /
 * Next step through a chapter, and how far the page must scroll to keep the highlighted
 * sentence above the card.
 *
 * A tap lands on one German sentence; the card is about the *bead* that sentence is in (plan
 * §1.2): one to three German sentences and the zero to three English sentences they were aligned
 * with. The whole bead is highlighted, since the translation shown belongs to all of it. A bead
 * at or below `LOW_CONFIDENCE` is uncertain: the DP found a near-equally good alternative, which
 * in practice means the translation may sit one sentence to either side, so the card also shows
 * the English sentences just before and after as context. A German sentence the aligner matched
 * with nothing (a 1-0 bead) shows the same neighbours in place of a translation.
 */

import { LOW_CONFIDENCE } from '../align/pipeline.ts'

/** The part of a `BeadRow` the card needs. */
export interface CardBead {
  deSentenceIdx: number[]
  enSentenceIdx: number[]
  confidence: number
}

/** The beads of a book, looked up by the German sentence tapped and in reading order. */
export class BeadIndex {
  private readonly byDe = new Map<number, CardBead>()
  /** Beads with a German side, in order of their first German sentence. */
  private readonly ordered: CardBead[]
  /** The English sentence ids that are in some bead, ascending (for finding neighbours). */
  private readonly enIds: number[]

  constructor(beads: readonly CardBead[]) {
    const en = new Set<number>()
    for (const b of beads) {
      for (const idx of b.deSentenceIdx) this.byDe.set(idx, b)
      for (const idx of b.enSentenceIdx) en.add(idx)
    }
    this.ordered = beads.filter((b) => b.deSentenceIdx.length > 0).sort((a, b) => a.deSentenceIdx[0] - b.deSentenceIdx[0])
    this.enIds = [...en].sort((a, b) => a - b)
  }

  /** The bead a German sentence is in, or null for a sentence outside every bead (an unaligned chapter). */
  beadOf(deIdx: number): CardBead | null {
    return this.byDe.get(deIdx) ?? null
  }

  /** Whether a German sentence is in an uncertain bead (confidence at or below `LOW_CONFIDENCE`). */
  isUncertain(deIdx: number): boolean {
    const bead = this.byDe.get(deIdx)
    return bead !== undefined && bead.confidence <= LOW_CONFIDENCE
  }

  /** The German sentence ids of every uncertain bead; what the page underlines. */
  uncertainSentences(): Set<number> {
    const out = new Set<number>()
    for (const b of this.ordered) if (b.confidence <= LOW_CONFIDENCE) for (const idx of b.deSentenceIdx) out.add(idx)
    return out
  }

  /**
   * The English sentences around a bead: the last one before its English side and the first
   * one after it. For a bead with no English side, the English text that the beads before and
   * after it in reading order end and start with, so a sentence the aligner left out still shows
   * where in the translation the reader is.
   */
  neighbours(bead: CardBead): { before: number | null; after: number | null } {
    if (bead.enSentenceIdx.length > 0) {
      const first = Math.min(...bead.enSentenceIdx)
      const last = Math.max(...bead.enSentenceIdx)
      return { before: this.enBefore(first), after: this.enAfter(last) }
    }
    const pos = this.ordered.indexOf(bead)
    if (pos < 0) return { before: null, after: null }
    let before: number | null = null
    for (let i = pos - 1; i >= 0 && before === null; i--) {
      const en = this.ordered[i].enSentenceIdx
      if (en.length > 0) before = Math.max(...en)
    }
    let after: number | null = null
    for (let i = pos + 1; i < this.ordered.length && after === null; i++) {
      const en = this.ordered[i].enSentenceIdx
      if (en.length > 0) after = Math.min(...en)
    }
    return { before, after }
  }

  private enBefore(idx: number): number | null {
    // Largest aligned English id below idx.
    let lo = 0
    let hi = this.enIds.length - 1
    let found: number | null = null
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.enIds[mid] < idx) {
        found = this.enIds[mid]
        lo = mid + 1
      } else hi = mid - 1
    }
    return found
  }

  private enAfter(idx: number): number | null {
    let lo = 0
    let hi = this.enIds.length - 1
    let found: number | null = null
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.enIds[mid] > idx) {
        found = this.enIds[mid]
        hi = mid - 1
      } else lo = mid + 1
    }
    return found
  }
}

/** What the card shows for a tapped sentence. */
export interface SentenceCard {
  /** The German sentences highlighted on the page: the tapped sentence's bead, or just the sentence when it is in none. */
  highlight: number[]
  /** The English sentences of the bead, in reading order; empty when the aligner matched nothing or the sentence is in no bead. */
  translation: number[]
  /** `aligned` with a translation worth trusting; `uncertain` when the bead is at or below the threshold; `unmatched` for a 1-0 bead; `unaligned` for a sentence in no bead. */
  status: 'aligned' | 'uncertain' | 'unmatched' | 'unaligned'
  /** The English sentence just before the translation, shown as context when the status is not `aligned`. */
  before: number | null
  /** The English sentence just after it, likewise. */
  after: number | null
}

/** The card for a tapped German sentence. */
export function sentenceCard(index: BeadIndex, deIdx: number): SentenceCard {
  const bead = index.beadOf(deIdx)
  if (bead === null) return { highlight: [deIdx], translation: [], status: 'unaligned', before: null, after: null }
  const translation = [...bead.enSentenceIdx].sort((a, b) => a - b)
  const status = translation.length === 0 ? 'unmatched' : bead.confidence <= LOW_CONFIDENCE ? 'uncertain' : 'aligned'
  const { before, after } = status === 'aligned' ? { before: null, after: null } : index.neighbours(bead)
  return { highlight: [...bead.deSentenceIdx].sort((a, b) => a - b), translation, status, before, after }
}

/**
 * The German sentence Previous (−1) or Next (+1) moves to from `deIdx`, among `sentences` (the
 * chapter's German sentence ids, ascending): the nearest one in that direction that is not in
 * the same bead, so a 2-1 bead is stepped over as one. Null at either end of the chapter.
 */
export function stepSentence(index: BeadIndex, sentences: readonly number[], deIdx: number, dir: -1 | 1): number | null {
  const bead = index.beadOf(deIdx)
  const same = new Set(bead === null ? [deIdx] : bead.deSentenceIdx)
  let pos = sentences.indexOf(deIdx)
  if (pos < 0) return null
  for (pos += dir; pos >= 0 && pos < sentences.length; pos += dir) if (!same.has(sentences[pos])) return sentences[pos]
  return null
}

/**
 * How far the page must scroll (positive is down) so that a highlighted sentence spanning
 * `top`–`bottom` (viewport px) lies within the band between the top bar and the card, with
 * `margin` px to spare; 0 when it already does. A sentence taller than the band is aligned to
 * the band's top so that its beginning is read first.
 */
export function revealDelta(top: number, bottom: number, viewport: number, cardHeight: number, barHeight: number, margin = 12): number {
  const bandTop = barHeight + margin
  const bandBottom = viewport - cardHeight - margin
  if (bandBottom <= bandTop) return 0
  if (bottom - top > bandBottom - bandTop || top < bandTop) return top - bandTop
  if (bottom > bandBottom) return bottom - bandBottom
  return 0
}
