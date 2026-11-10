/**
 * Alignment Layer C, part three (plan §1.2, step 11): the book-specific lexicon and pass two.
 *
 * The dictionary knows "Zimmer → room", but not that this translator always renders
 * "Prokurist" as "chief clerk", nor the characters' names when they differ between editions,
 * nor the words the dictionary lacks. Hunalign's answer is to let the first alignment teach the
 * second: the confident 1-1 beads of pass one are a small parallel corpus, and words that keep
 * turning up together in them are probably translations of each other.
 *
 * {@link induceLexicon} counts, over the confident beads, in how many beads each German content
 * word occurs, each English content stem occurs, and each pair occurs together, and scores a
 * pair by Dice, 2·both / (de + en). A pair is kept when it was seen together at least
 * `minCount` times, its Dice is at least `minDice`, and it is at least `minRelative` times as
 * strong as the best pair of either of its words (so "Mutter → sister" loses to
 * "Schwester → sister" even though mother and sister share many sentences); each German word
 * keeps at most `maxGlosses` English partners, strongest first. Counting presence per bead,
 * not token multiplicity, keeps a word repeated inside one long sentence from inflating itself.
 *
 * The result is a {@link MapLexicon} keyed by the lowercase German surface form, whose
 * glosses are the English surface words most often seen for each stem, so that the feature
 * module's gloss stemming lands back on the stem it will meet in the English sentences. The
 * induced lexicon is stacked on the dictionary with {@link mergeLexicons} and
 * {@link alignTwoPass} runs {@link alignBlocks} again over it. Pass two cannot move paragraph
 * blocks, only the sentence beads inside them, and a dictionary gloss is never overridden,
 * only added to.
 */

import { alignBlocks, type AlignedBead, type AlignOptions, type ParagraphBlock } from './beads.ts'
import { MapLexicon, STOPWORDS, stemEn, tokenize, type Lexicon } from './features.ts'
import type { ParagraphSentence } from './sentences.ts'

// ---------------------------------------------------------------------------------------------
// Induction

export interface InduceOptions {
  /** Beads below this confidence are not used as evidence. */
  minConfidence?: number
  /** A pair must have been seen together in at least this many beads. */
  minCount?: number
  /** Dice coefficient a pair needs, 2·both / (de + en). */
  minDice?: number
  /** A pair's Dice must be at least this fraction of the best Dice of each of its two words. */
  minRelative?: number
  /** Most English partners kept per German word. */
  maxGlosses?: number
}

export const DEFAULT_INDUCE_OPTIONS: Required<InduceOptions> = {
  minConfidence: 0.9,
  minCount: 3,
  minDice: 0.4,
  minRelative: 0.5,
  maxGlosses: 3,
}

/** One learned translation pair, for the debug view and the tests. */
export interface InducedPair {
  /** Lowercase German surface form. */
  de: string
  /** The English surface word most often seen for the matched stem, possessive removed. */
  en: string
  /** Beads in which the two were seen together. */
  count: number
  /** Dice coefficient of the pair over the confident beads. */
  dice: number
}

/** The lexicon learned from a book, with the pairs it was built from. */
export class InducedLexicon extends MapLexicon {
  readonly pairs: readonly InducedPair[]

  constructor(pairs: readonly InducedPair[]) {
    super(pairs.map((p) => [p.de, [p.en]] as const))
    this.pairs = pairs
  }
}

/** Distinct lowercase German content words of a sentence. */
function deWords(text: string): Set<string> {
  const out = new Set<string>()
  for (const t of tokenize(text)) {
    if (t.kind !== 'word' || t.text.length < 2) continue
    const lower = t.text.toLowerCase()
    if (!STOPWORDS.de.has(lower)) out.add(lower)
  }
  return out
}

/** Distinct English content stems of a sentence, each with the surface word it came from. */
function enStems(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const t of tokenize(text)) {
    if (t.kind !== 'word' || t.text.length < 2) continue
    const lower = t.text.toLowerCase()
    if (STOPWORDS.en.has(lower)) continue
    const stem = stemEn(lower)
    if (!out.has(stem)) out.set(stem, lower.replace(/['’]s$/u, ''))
  }
  return out
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

/**
 * Learn translation pairs from the confident 1-1 beads of a pass-one alignment. `de` and `en`
 * are the sentence lists the beads index into by `ParagraphSentence.idx`. Returns a lexicon
 * that can be stacked on the dictionary; empty when the beads taught nothing.
 */
export function induceLexicon(
  de: readonly ParagraphSentence[],
  en: readonly ParagraphSentence[],
  beads: readonly AlignedBead[],
  options: InduceOptions = {},
): InducedLexicon {
  const { minConfidence, minCount, minDice, minRelative, maxGlosses } = { ...DEFAULT_INDUCE_OPTIONS, ...options }
  const deByIdx = new Map(de.map((s) => [s.idx, s]))
  const enByIdx = new Map(en.map((s) => [s.idx, s]))

  const deCount = new Map<string, number>()
  const enCount = new Map<string, number>()
  const surface = new Map<string, Map<string, number>>()
  const pairCount = new Map<string, Map<string, number>>()

  for (const bead of beads) {
    if (bead.deSentenceIdx.length !== 1 || bead.enSentenceIdx.length !== 1) continue
    if (bead.confidence < minConfidence) continue
    const d = deByIdx.get(bead.deSentenceIdx[0])
    const e = enByIdx.get(bead.enSentenceIdx[0])
    if (d === undefined || e === undefined) continue
    const words = deWords(d.text)
    const stems = enStems(e.text)
    if (words.size === 0 || stems.size === 0) continue
    for (const w of words) bump(deCount, w)
    for (const [stem, word] of stems) {
      bump(enCount, stem)
      let forms = surface.get(stem)
      if (forms === undefined) surface.set(stem, (forms = new Map()))
      bump(forms, word)
    }
    for (const w of words) {
      let row = pairCount.get(w)
      if (row === undefined) pairCount.set(w, (row = new Map()))
      for (const stem of stems.keys()) bump(row, stem)
    }
  }

  // Every pair over the count and Dice floors, with the best Dice seen for each word.
  const candidates = new Map<string, { stem: string; both: number; dice: number }[]>()
  const bestDe = new Map<string, number>()
  const bestEn = new Map<string, number>()
  for (const [w, row] of pairCount) {
    for (const [stem, both] of row) {
      if (both < minCount) continue
      const dice = (2 * both) / (deCount.get(w)! + enCount.get(stem)!)
      if (dice < minDice) continue
      let list = candidates.get(w)
      if (list === undefined) candidates.set(w, (list = []))
      list.push({ stem, both, dice })
      bestDe.set(w, Math.max(bestDe.get(w) ?? 0, dice))
      bestEn.set(stem, Math.max(bestEn.get(stem) ?? 0, dice))
    }
  }

  const pairs: InducedPair[] = []
  for (const [w, list] of candidates) {
    const kept: InducedPair[] = []
    for (const { stem, both, dice } of list) {
      if (dice < minRelative * bestDe.get(w)! || dice < minRelative * bestEn.get(stem)!) continue
      kept.push({ de: w, en: commonest(surface.get(stem)!), count: both, dice })
    }
    kept.sort((a, b) => b.dice - a.dice || b.count - a.count || a.en.localeCompare(b.en))
    pairs.push(...kept.slice(0, maxGlosses))
  }
  pairs.sort((a, b) => b.dice - a.dice || b.count - a.count || a.de.localeCompare(b.de) || a.en.localeCompare(b.en))
  return new InducedLexicon(pairs)
}

function commonest(forms: Map<string, number>): string {
  let best = ''
  let n = -1
  for (const [form, count] of forms) {
    if (count > n || (count === n && form < best)) {
      best = form
      n = count
    }
  }
  return best
}

// ---------------------------------------------------------------------------------------------
// Stacking

/**
 * A lexicon that answers with the glosses of every given lexicon, in order and without
 * duplicates. `null` entries are skipped, so the dictionary may be absent. Returns `null` when
 * nothing is left to consult.
 */
export function mergeLexicons(...lexicons: readonly (Lexicon | null)[]): Lexicon | null {
  const layers = lexicons.filter((l): l is Lexicon => l !== null)
  if (layers.length === 0) return null
  if (layers.length === 1) return layers[0]
  return {
    glosses(form: string): readonly string[] {
      const out: string[] = []
      for (const layer of layers) for (const g of layer.glosses(form)) if (!out.includes(g)) out.push(g)
      return out
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Pass two

export interface TwoPassOptions extends AlignOptions {
  induce?: InduceOptions
}

export interface TwoPassResult {
  /** The pass-two alignment. */
  beads: AlignedBead[]
  /** The pass-one alignment it was learned from. */
  firstPass: AlignedBead[]
  /** What the book taught; empty when pass two was skipped. */
  lexicon: InducedLexicon
}

/**
 * Align a book twice: once over the dictionary (or nothing), then again over the dictionary
 * plus the lexicon induced from the first pass's confident beads. When the first pass taught
 * nothing, its beads are returned as they are.
 */
export function alignTwoPass(
  de: readonly ParagraphSentence[],
  en: readonly ParagraphSentence[],
  blocks: readonly ParagraphBlock[],
  dictionary: Lexicon | null,
  options: TwoPassOptions = {},
): TwoPassResult {
  const { induce, ...alignOptions } = options
  const firstPass = alignBlocks(de, en, blocks, dictionary, alignOptions)
  const lexicon = induceLexicon(de, en, firstPass, induce)
  if (lexicon.size === 0) return { beads: firstPass, firstPass, lexicon }
  const beads = alignBlocks(de, en, blocks, mergeLexicons(dictionary, lexicon), alignOptions)
  return { beads, firstPass, lexicon }
}
