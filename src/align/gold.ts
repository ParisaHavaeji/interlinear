/**
 * Gold alignments (plan §1.1, step 13): the hand-checked beads the aligner is measured against.
 *
 * A gold file records, for one book pair, the correct beads over the first ~150 sentences of
 * each side as lists of `ParagraphSentence.idx`, plus a short hash of every sentence text those
 * beads cover. The texts themselves are not stored: the Demian translation is under copyright,
 * and the fixtures hold the Gutenberg texts anyway. The hashes let {@link checkGoldSentences}
 * refuse to grade an alignment whose sentence splitting no longer matches the one the gold was
 * checked against, so a splitter change shows up as "regenerate the gold", never as a silent
 * drop in accuracy.
 *
 * {@link scoreGold} grades a pipeline result: a gold bead counts as found when the alignment
 * has exactly that bead. Accuracy in the plan's sense is the recall of gold beads; precision
 * over the predicted beads that touch the gold range is reported too, together with every
 * mismatch so the debug view and the tuning script can show what went wrong. Beads partition
 * the sentences, so a merged or split bead costs recall on its own and no separate penalty is
 * needed.
 *
 * The debug view exports the first N beads of a book in this format; `tools/gold.ts` does the
 * same from Node and turns a corrected draft into the committed file.
 */

import type { AlignedBead } from './beads.ts'

export interface GoldBead {
  de: number[]
  en: number[]
}

export interface GoldFile {
  /** Pair id, e.g. "kafka-verwandlung"; the file is `tests/fixtures/<book>.gold.json`. */
  book: string
  /** Where the two texts come from, for people reading the file. */
  sources: { de: string; en: string }
  /** How the file was made and what it covers. */
  notes?: string
  /** {@link hashText} of every sentence the beads cover, keyed by `ParagraphSentence.idx` as a string. */
  sentences: { de: Record<string, string>; en: Record<string, string> }
  beads: GoldBead[]
}

/** The minimum of a sentence a gold file needs to know: its position and text. */
export interface GoldSentence {
  idx: number
  text: string
}

/** FNV-1a over the UTF-16 code units of the text, as eight hex digits. Not cryptographic. */
export function hashText(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

const key = (b: { de: readonly number[]; en: readonly number[] }): string => `${b.de.join('+')}:${b.en.join('+')}`

/**
 * Build a gold file from the first `n` beads of an alignment, in bead order. The beads are the
 * aligner's, not yet checked: the result is the draft a person corrects before it is committed.
 */
export function goldFromBeads(
  book: string,
  sources: { de: string; en: string },
  sentences: { de: readonly GoldSentence[]; en: readonly GoldSentence[] },
  beads: readonly AlignedBead[],
  n: number,
): GoldFile {
  const draft: GoldFile = { book, sources, sentences: { de: {}, en: {} }, beads: [] }
  for (const b of beads.slice(0, n)) draft.beads.push({ de: [...b.deSentenceIdx], en: [...b.enSentenceIdx] })
  return withSentenceHashes(draft, sentences)
}

/** The gold file with its sentence hashes recomputed from the given sentences. */
export function withSentenceHashes(
  gold: GoldFile,
  sentences: { de: readonly GoldSentence[]; en: readonly GoldSentence[] },
): GoldFile {
  const byIdx = (side: readonly GoldSentence[]) => new Map(side.map((s) => [s.idx, s.text]))
  const de = byIdx(sentences.de)
  const en = byIdx(sentences.en)
  const out: GoldFile = { ...gold, sentences: { de: {}, en: {} }, beads: gold.beads.map((b) => ({ de: [...b.de], en: [...b.en] })) }
  for (const b of out.beads) {
    for (const i of b.de) {
      const text = de.get(i)
      if (text === undefined) throw new Error(`Gold bead ${key(b)} names German sentence ${i}, which does not exist`)
      out.sentences.de[String(i)] = hashText(text)
    }
    for (const j of b.en) {
      const text = en.get(j)
      if (text === undefined) throw new Error(`Gold bead ${key(b)} names English sentence ${j}, which does not exist`)
      out.sentences.en[String(j)] = hashText(text)
    }
  }
  return out
}

/**
 * Problems with a gold file's beads: a sentence covered twice, beads out of order, a bead empty
 * on both sides, or a gap in either side's run of indices that `coverable` says holds a prose
 * sentence (headings between two letters of Werther get no bead and are not gaps; without the
 * predicate every gap is reported). A side may hold more than two sentences: the gold records
 * what the translator did, and a 1-3 bead is simply one the aligner's move set cannot reach.
 * Empty when the beads are a well-formed alignment.
 */
export function validateGoldBeads(beads: readonly GoldBead[], coverable: (side: 'de' | 'en', idx: number) => boolean = () => true): string[] {
  const problems: string[] = []
  const check = (side: 'de' | 'en'): void => {
    const seen = beads.flatMap((b) => b[side])
    for (let k = 1; k < seen.length; k++) {
      if (seen[k] === seen[k - 1]) problems.push(`${side} sentence ${seen[k]} appears twice`)
      else if (seen[k] < seen[k - 1]) problems.push(`${side} sentences ${seen[k - 1]} and ${seen[k]} are out of order`)
      else {
        for (let i = seen[k - 1] + 1; i < seen[k]; i++) if (coverable(side, i)) problems.push(`${side} sentence ${i} is covered by no bead`)
      }
    }
  }
  for (const b of beads) if (b.de.length === 0 && b.en.length === 0) problems.push('a bead is empty on both sides')
  check('de')
  check('en')
  return problems
}

/**
 * Sentences whose text no longer hashes to what the gold file recorded, as
 * "de 12" / "en 7" labels. Any entry means the splitter changed under the gold file, which
 * then needs re-checking rather than grading.
 */
export function checkGoldSentences(gold: GoldFile, sentences: { de: readonly GoldSentence[]; en: readonly GoldSentence[] }): string[] {
  const bad: string[] = []
  for (const side of ['de', 'en'] as const) {
    const byIdx = new Map(sentences[side].map((s) => [s.idx, s.text]))
    for (const [idx, hash] of Object.entries(gold.sentences[side])) {
      const text = byIdx.get(Number(idx))
      if (text === undefined || hashText(text) !== hash) bad.push(`${side} ${idx}`)
    }
  }
  return bad
}

/** One predicted bead that touches the gold range, with its verdict. */
export interface JudgedBead {
  bead: AlignedBead
  correct: boolean
}

export interface GoldScore {
  /** Gold beads. */
  gold: number
  /** Predicted beads touching the gold range. */
  predicted: number
  /** Gold beads the alignment reproduced exactly. */
  correct: number
  /** correct / gold: the plan's bead accuracy. */
  recall: number
  /** correct / predicted. */
  precision: number
  f1: number
  /** Gold beads the alignment missed. */
  missed: GoldBead[]
  /** Predicted beads in the range that are not gold beads. */
  spurious: AlignedBead[]
  /** Every predicted bead touching the gold range, in order, with its verdict. */
  judged: JudgedBead[]
}

/**
 * Grade an alignment against a gold file. Only beads touching the gold range (any sentence of
 * theirs is one the gold covers) take part, so the rest of the book does not dilute the score.
 */
export function scoreGold(beads: readonly AlignedBead[], gold: GoldFile): GoldScore {
  const goldKeys = new Set(gold.beads.map(key))
  const coveredDe = new Set(gold.beads.flatMap((b) => b.de))
  const coveredEn = new Set(gold.beads.flatMap((b) => b.en))
  const judged: JudgedBead[] = []
  const found = new Set<string>()
  for (const b of beads) {
    const touches = b.deSentenceIdx.some((i) => coveredDe.has(i)) || b.enSentenceIdx.some((j) => coveredEn.has(j))
    if (!touches) continue
    const k = key({ de: b.deSentenceIdx, en: b.enSentenceIdx })
    const correct = goldKeys.has(k)
    if (correct) found.add(k)
    judged.push({ bead: b, correct })
  }
  const correct = found.size
  const predicted = judged.length
  const recall = gold.beads.length === 0 ? 1 : correct / gold.beads.length
  const precision = predicted === 0 ? 1 : correct / predicted
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return {
    gold: gold.beads.length,
    predicted,
    correct,
    recall,
    precision,
    f1,
    missed: gold.beads.filter((b) => !found.has(key(b))),
    spurious: judged.filter((j) => !j.correct).map((j) => j.bead),
    judged,
  }
}
