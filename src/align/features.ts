/**
 * Alignment Layer C, part one (plan §1.2, step 9): the features that price a sentence bead.
 *
 * A bead is one, two or no sentences on the German side set against one, two or no sentences
 * on the English side. The bead DP of step 10 asks, for each candidate bead, how plausible it
 * is that these sentences translate each other, and this module answers with four signals:
 *
 * 1. **Length** — the Gale–Church character-length cost of step 7, in nats (lower is better).
 * 2. **Lexical overlap** — the dictionary used as a bilingual lexicon. Each German content
 *    token is looked up (the {@link Lexicon} does the lemmatising), its English glosses are
 *    broken into words and stemmed, and a hit is one German token whose glosses contain an
 *    English token of the bead that no earlier German token has claimed. Score: Dice over the
 *    content tokens of both sides, 2·hits / (|de| + |en|).
 * 3. **Cognates and identical tokens** — numbers, tokens spelled the same after folding
 *    umlauts (names: Gregor, Samsa, Sinclair; loans: Nation), and cognates judged by the
 *    longest-common-subsequence ratio (Mutter/mother, Haus/house, Vater is missed). Same Dice.
 * 4. **Punctuation shape** — the terminal mark, whether the bead opens with dialogue quotes and
 *    whether it contains a colon: three traits translators keep, each worth a third.
 *
 * Sentences are prepared once ({@link prepareSentence}) so the DP, which prices many beads
 * per sentence, only merges precomputed token sets. {@link combinedCost} turns the four signals
 * into one cost with default weights checked against the gold files (see {@link DEFAULT_WEIGHTS}).
 *
 * The dictionary of Phase 4 is not built yet, so lookup goes through the {@link Lexicon}
 * interface; {@link MapLexicon} is an in-memory implementation for tests and for the induced
 * book lexicon of step 11, with a crude German suffix-stripping fallback in place of the
 * dictionary's inflection index.
 */

import type { Lang } from '../import/types.ts'
import { deletionCost, lengthCost } from './structure.ts'

// ---------------------------------------------------------------------------------------------
// Lexicon

/** A German → English lexicon, as the dictionary (step 22) or an induced book lexicon provides. */
export interface Lexicon {
  /**
   * English glosses for a German surface form, as the dictionary writes them ("to go", "the
   * house", "mother"), after whatever lemmatising the implementation can do. Empty when unknown.
   */
  glosses(form: string): readonly string[]
}

/**
 * German suffixes tried in turn when a form is not in the lexicon: nouns ("Häusern", "Tages"),
 * adjectives ("kleines", "schweren"), weak verbs ("sagte", "machten", "gehst"). Longest first
 * so "-ten" is tried before "-n". The umlaut of a plural ("Häuser") is not undone here.
 */
const DE_SUFFIXES = ['ten', 'test', 'tet', 'ern', 'em', 'en', 'er', 'es', 'st', 'te', 'e', 'n', 's', 't']

/**
 * In-memory lexicon over a list of `[lemma, glosses]` entries. Lookup tries the form, its
 * lowercase, then suffix-stripped variants of either; a stripped variant may also regain a
 * final "e", "en" or "n" ("erwachte" → "erwach" → "erwachen", "verwandelt" → "verwandeln").
 * Keys are stored lowercased.
 */
export class MapLexicon implements Lexicon {
  private readonly entries = new Map<string, string[]>()

  constructor(entries: Iterable<readonly [string, readonly string[]]> = []) {
    for (const [lemma, glosses] of entries) this.add(lemma, glosses)
  }

  /** Add glosses for a lemma, merging with any already present. */
  add(lemma: string, glosses: readonly string[]): void {
    const key = lemma.toLowerCase()
    const have = this.entries.get(key)
    if (have === undefined) this.entries.set(key, [...glosses])
    else for (const g of glosses) if (!have.includes(g)) have.push(g)
  }

  get size(): number {
    return this.entries.size
  }

  glosses(form: string): readonly string[] {
    const lower = form.toLowerCase()
    const exact = this.entries.get(lower)
    if (exact !== undefined) return exact
    for (const suffix of DE_SUFFIXES) {
      if (lower.length - suffix.length < 3 || !lower.endsWith(suffix)) continue
      const stem = lower.slice(0, -suffix.length)
      const hit =
        this.entries.get(stem) ?? this.entries.get(stem + 'e') ?? this.entries.get(stem + 'en') ?? this.entries.get(stem + 'n')
      if (hit !== undefined) return hit
    }
    return []
  }
}

// ---------------------------------------------------------------------------------------------
// Tokens

export type TokenKind = 'word' | 'number' | 'punct'

export interface Token {
  text: string
  kind: TokenKind
  /** Offset of the token in the sentence text. */
  start: number
  /** True for the first word or number of the sentence. */
  initial: boolean
}

const TOKEN = /\p{N}+(?:[.,]\p{N}+)*|[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*|[^\s\p{L}\p{M}\p{N}]+/gu

/**
 * Tokenise a sentence into words, numbers and punctuation runs. Words keep internal apostrophes
 * ("wasn't", "d'abord"); hyphenated compounds split at the hyphen ("armour-like" → two words),
 * which lets each half match on its own. Numbers keep their group and decimal separators.
 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let sawWord = false
  for (const m of text.matchAll(TOKEN)) {
    const t = m[0]
    const kind: TokenKind = /^\p{N}/u.test(t) ? 'number' : /^[\p{L}\p{M}]/u.test(t) ? 'word' : 'punct'
    const initial = kind !== 'punct' && !sawWord
    if (kind !== 'punct') sawWord = true
    tokens.push({ text: t, kind, start: m.index, initial })
  }
  return tokens
}

/**
 * Function words ignored by the lexical and cognate scores: they carry no translation evidence
 * and would otherwise match everywhere. Also used to clean gloss phrases ("to go" → "go").
 */
export const STOPWORDS: Record<Lang, ReadonlySet<string>> = {
  de: new Set([
    'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines', 'und', 'oder', 'aber', 'denn',
    'doch', 'in', 'im', 'an', 'am', 'auf', 'zu', 'zum', 'zur', 'von', 'vom', 'mit', 'für', 'aus', 'bei', 'beim', 'nach', 'über',
    'unter', 'vor', 'durch', 'um', 'ohne', 'gegen', 'ist', 'war', 'sind', 'waren', 'sein', 'bin', 'bist', 'seid', 'wäre', 'wären',
    'hat', 'hatte', 'haben', 'hatten', 'habe', 'hast', 'wird', 'wurde', 'werden', 'wurden', 'worden', 'er', 'sie', 'es', 'ich',
    'du', 'wir', 'ihr', 'sich', 'mir', 'mich', 'dir', 'dich', 'ihm', 'ihn', 'ihnen', 'uns', 'euch', 'mein', 'meine', 'meinen',
    'meinem', 'meiner', 'dein', 'deine', 'seine', 'seinen', 'seinem', 'seiner', 'seines', 'ihre', 'ihren', 'ihrem', 'ihrer',
    'ihres', 'unser', 'unsere', 'kein', 'keine', 'keinen', 'keinem', 'keiner', 'dieser', 'diese', 'dieses', 'diesen', 'diesem',
    'jener', 'jene', 'jenes', 'nicht', 'auch', 'als', 'wie', 'dass', 'daß', 'so', 'noch', 'nur', 'wenn', 'weil', 'ob', 'schon',
    'sehr', 'man', 'da', 'dann', 'denn', 'hier', 'dort', 'ja', 'nein', 'was', 'wer', 'wo', 'etwas', 'nichts', 'alle', 'alles',
    'viel', 'mehr', 'ganz', 'wieder', 'immer', 'nun', 'jetzt', 'kann', 'konnte', 'können', 'konnten', 'muss', 'muß', 'musste',
    'mußte', 'müssen', 'soll', 'sollte', 'sollen', 'will', 'wollte', 'wollen', 'darf', 'durfte', 'mag', 'möchte', 'sei', 'zwei',
  ]),
  en: new Set([
    'the', 'a', 'an', 'to', 'of', 'and', 'or', 'but', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'into', 'onto', 'off',
    'out', 'up', 'down', 'over', 'under', 'about', 'is', 'was', 'be', 'been', 'being', 'are', 'were', 'am', 'it', 'its', 'he',
    'she', 'they', 'we', 'i', 'you', 'me', 'him', 'her', 'them', 'us', 'his', 'their', 'our', 'my', 'your', 'mine', 'himself',
    'herself', 'itself', 'themselves', 'myself', 'yourself', 'oneself', 'that', 'this', 'these', 'those', 'not', 'no', 'nor',
    'had', 'have', 'has', 'having', 'do', 'did', 'does', 'done', 'so', 'if', 'then', 'than', 'there', 'here', 'what', 'who',
    'which', 'when', 'where', 'how', 'why', 'all', 'any', 'some', 'very', 'just', 'only', 'also', 'too', 'yes', 'can', 'could',
    'would', 'should', 'will', 'shall', 'may', 'might', 'must', 'one', 'sb', 'sth', 'smb', 'smth', 'someone', 'something',
    's', 't', 'll', 'd', 're', 've', 'm',
  ]),
}

/**
 * A light English stemmer so inflected tokens meet dictionary glosses: plurals, past tense,
 * -ing, -ly, possessives. Applied to both sides, so only consistency matters, not linguistics.
 */
export function stemEn(word: string): string {
  let w = word.toLowerCase().replace(/['’]s$/u, '').replace(/['’]/gu, '')
  if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y'
  else if (w.length > 4 && w.endsWith('sses')) w = w.slice(0, -2)
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1)
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3)
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2)
  else if (w.length > 4 && w.endsWith('ly')) w = w.slice(0, -2)
  // "housed" → "hous", "house" → "hous": drop a final e after the suffix rules so both agree.
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1)
  return w
}

/**
 * Fold a German or English word to a comparison form: lowercase, umlauts and ß reduced to their
 * base letters, apostrophes removed. Used for identical-token and cognate matching only.
 */
export function fold(word: string): string {
  return word
    .toLowerCase()
    .replace(/ä/gu, 'a')
    .replace(/ö/gu, 'o')
    .replace(/ü/gu, 'u')
    .replace(/ß/gu, 'ss')
    .replace(/['’]/gu, '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
}

/** Gloss phrases → stemmed English content words ("to go away" → ["go", "away"]). */
export function glossWords(glosses: readonly string[]): string[] {
  const out: string[] = []
  for (const g of glosses) {
    for (const t of tokenize(g)) {
      if (t.kind !== 'word') continue
      const lower = t.text.toLowerCase()
      if (STOPWORDS.en.has(lower)) continue
      const stem = stemEn(lower)
      if (!out.includes(stem)) out.push(stem)
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Prepared sentences

/** Terminal mark class of a sentence, by its last punctuation run. */
export type Terminal = '.' | '!' | '?' | '…' | ''

export interface Shape {
  terminal: Terminal
  /** The sentence opens with a quotation mark (dialogue). */
  quoted: boolean
  /** The sentence contains a colon or semicolon. */
  colon: boolean
}

/** The precomputed view of one sentence that bead scoring works from. */
export interface PreparedSentence {
  lang: Lang
  chars: number
  /** Content words and numbers (stopwords and punctuation dropped), in order, folded. */
  content: string[]
  /** For English: stemmed content words, parallel to `content`. */
  stems: string[]
  /** For German: the stemmed gloss words of each content token, parallel to `content`. */
  glosses: string[][]
  /** Normalised number tokens ("3.000" → "3000"). */
  numbers: string[]
  /** Capitalised, non-initial content words, folded: proper-noun candidates. */
  capitalised: Set<string>
  shape: Shape
}

const OPENING_QUOTE = /^[„“"»«‚‘'(\[]/u

/** The punctuation traits of a sentence (see {@link Shape}). */
export function shapeOf(text: string): Shape {
  const trimmed = text.trim()
  const tail = /[.!?…]+[”“"’'»«)\]]*$/u.exec(trimmed)?.[0] ?? ''
  let terminal: Terminal = ''
  if (/\?/u.test(tail)) terminal = '?'
  else if (/!/u.test(tail)) terminal = '!'
  else if (/…|\.\.\./u.test(tail)) terminal = '…'
  else if (/\./u.test(tail)) terminal = '.'
  return { terminal, quoted: OPENING_QUOTE.test(trimmed), colon: /[:;]/u.test(trimmed) }
}

/**
 * Precompute everything bead scoring needs for one sentence. The lexicon is consulted for
 * German sentences only; pass `null` when there is none (features then rely on cognates).
 */
export function prepareSentence(text: string, lang: Lang, lexicon: Lexicon | null = null): PreparedSentence {
  const content: string[] = []
  const stems: string[] = []
  const glosses: string[][] = []
  const numbers: string[] = []
  const capitalised = new Set<string>()
  for (const t of tokenize(text)) {
    if (t.kind === 'number') {
      const n = t.text.replace(/[.,]/gu, '')
      numbers.push(n)
      content.push(n)
      stems.push(n)
      glosses.push([])
      continue
    }
    if (t.kind !== 'word') continue
    const lower = t.text.toLowerCase()
    if (STOPWORDS[lang].has(lower) || t.text.length < 2) continue
    const folded = fold(t.text)
    content.push(folded)
    stems.push(lang === 'en' ? stemEn(lower) : folded)
    glosses.push(lang === 'de' && lexicon !== null ? glossWords(lexicon.glosses(t.text)) : [])
    if (!t.initial && /^\p{Lu}/u.test(t.text)) capitalised.add(folded)
  }
  return { lang, chars: text.length, content, stems, glosses, numbers, capitalised, shape: shapeOf(text) }
}

// ---------------------------------------------------------------------------------------------
// Feature scores

/** A multiset of strings with claim-once semantics, for one-to-one matching. */
class Pool {
  private readonly counts = new Map<string, number>()
  constructor(items: Iterable<string>) {
    for (const s of items) this.counts.set(s, (this.counts.get(s) ?? 0) + 1)
  }
  take(s: string): boolean {
    const n = this.counts.get(s)
    if (n === undefined) return false
    if (n === 1) this.counts.delete(s)
    else this.counts.set(s, n - 1)
    return true
  }
  *remaining(): IterableIterator<string> {
    for (const [s, n] of this.counts) for (let i = 0; i < n; i++) yield s
  }
}

function dice(hits: number, a: number, b: number): number {
  return a + b === 0 ? 0 : (2 * hits) / (a + b)
}

/**
 * Dice coefficient of dictionary translation hits between the German and English sides of a
 * bead: a German content token scores when one of its gloss stems is still unclaimed among the
 * English content stems. Zero when either side is empty or the lexicon knew no word.
 */
export function lexicalOverlap(de: readonly PreparedSentence[], en: readonly PreparedSentence[]): number {
  const pool = new Pool(en.flatMap((s) => s.stems))
  let hits = 0
  let nDe = 0
  for (const s of de) {
    nDe += s.content.length
    for (const g of s.glosses) {
      for (const stem of g) {
        if (pool.take(stem)) {
          hits++
          break
        }
      }
    }
  }
  const nEn = en.reduce((n, s) => n + s.content.length, 0)
  return dice(hits, nDe, nEn)
}

/** Length of the longest common subsequence of two short strings. */
export function lcsLength(a: string, b: string): number {
  const m = b.length
  let prev = new Uint16Array(m + 1)
  let cur = new Uint16Array(m + 1)
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[m]
}

/** Shortest word length for cognate matching; shorter words agree by chance too often. */
const COGNATE_MIN_LENGTH = 5
/** Longest-common-subsequence ratio (LCS / longer length) at or above which two words are cognates. */
const COGNATE_MIN_LCSR = 0.6

/**
 * Whether two folded words look like cognates: both at least five letters, same first letter,
 * and a longest-common-subsequence ratio of 0.6 or more (Mutter/mother 4/6, Haus/house is too
 * short, Nation/nation 1.0, wird/word too short). Identical words are cognates trivially.
 */
export function isCognate(a: string, b: string): boolean {
  if (a === b) return true
  if (a.length < COGNATE_MIN_LENGTH || b.length < COGNATE_MIN_LENGTH || a[0] !== b[0]) return false
  if (Math.abs(a.length - b.length) > 3) return false
  return lcsLength(a, b) / Math.max(a.length, b.length) >= COGNATE_MIN_LCSR
}

export interface CognateMatches {
  /** Number tokens equal on both sides. */
  numbers: number
  /** Words identical after folding; `names` of them are capitalised non-initial on the English side. */
  identical: number
  names: number
  /** Non-identical cognate pairs. */
  cognates: number
  /** Dice coefficient over content tokens of all matches together. */
  score: number
}

/**
 * Match numbers, identical tokens and cognates one-to-one across the bead and score them by
 * Dice over the content tokens. German genitive and plural "-s" is tolerated on names
 * ("Gregors" ↔ "Gregor"). Identical matches are claimed before cognates so a word is not
 * spent on a lookalike when its twin is present.
 */
export function cognateMatches(de: readonly PreparedSentence[], en: readonly PreparedSentence[]): CognateMatches {
  const enContent = en.flatMap((s) => s.content)
  const pool = new Pool(enContent)
  const enNames = new Set(en.flatMap((s) => [...s.capitalised]))
  const deContent = de.flatMap((s) => s.content)
  const deNumbers = new Set(de.flatMap((s) => s.numbers))
  let numbers = 0
  let identical = 0
  let names = 0
  const unmatched: string[] = []
  for (const w of deContent) {
    if (deNumbers.has(w) && pool.take(w)) {
      numbers++
      continue
    }
    const stripped = w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : null
    const hit = pool.take(w) ? w : stripped !== null && pool.take(stripped) ? stripped : null
    if (hit !== null) {
      identical++
      if (enNames.has(hit)) names++
      continue
    }
    unmatched.push(w)
  }
  let cognates = 0
  const rest = [...pool.remaining()]
  for (const w of unmatched) {
    const k = rest.findIndex((e) => isCognate(w, e))
    if (k === -1) continue
    rest.splice(k, 1)
    cognates++
  }
  const score = dice(numbers + identical + cognates, deContent.length, enContent.length)
  return { numbers, identical, names, cognates, score }
}

/**
 * Agreement of punctuation shape between the two sides of a bead, a third each for the terminal
 * mark (of the last sentence), the opening quote (of the first) and the presence of a colon.
 */
export function punctuationShape(de: readonly PreparedSentence[], en: readonly PreparedSentence[]): number {
  if (de.length === 0 || en.length === 0) return 0
  const d = beadShape(de)
  const e = beadShape(en)
  let agree = 0
  if (d.terminal === e.terminal) agree++
  if (d.quoted === e.quoted) agree++
  if (d.colon === e.colon) agree++
  return agree / 3
}

function beadShape(side: readonly PreparedSentence[]): Shape {
  return {
    terminal: side[side.length - 1].shape.terminal,
    quoted: side[0].shape.quoted,
    colon: side.some((s) => s.shape.colon),
  }
}

// ---------------------------------------------------------------------------------------------
// Beads

export interface BeadFeatures {
  /** Gale–Church length cost in nats (deletion cost for a one-sided bead). */
  length: number
  /** Dictionary translation overlap, Dice in [0, 1]. */
  lexical: number
  /** Numbers, identical tokens and cognates, Dice in [0, 1]. */
  cognate: number
  /** Punctuation-shape agreement in [0, 1]. */
  punctuation: number
}

export interface FeatureOptions {
  /** Expected English characters per German character (see `estimateRatio` in structure.ts). */
  ratio: number
  /** Gale–Church variance; defaults to the structure module's. */
  variance?: number
  /** Characters per nat for one-sided beads; defaults to the structure module's. */
  deletionScale?: number
}

/** The four signals for one candidate bead. Empty sides give zero overlap scores. */
export function beadFeatures(
  de: readonly PreparedSentence[],
  en: readonly PreparedSentence[],
  options: FeatureOptions,
): BeadFeatures {
  const deChars = de.reduce((n, s) => n + s.chars, 0)
  const enChars = en.reduce((n, s) => n + s.chars, 0)
  const length =
    de.length === 0 || en.length === 0
      ? deletionCost(deChars + enChars, options.deletionScale)
      : lengthCost(deChars, enChars, options.ratio, options.variance)
  if (de.length === 0 || en.length === 0) return { length, lexical: 0, cognate: 0, punctuation: 0 }
  return {
    length,
    lexical: lexicalOverlap(de, en),
    cognate: cognateMatches(de, en).score,
    punctuation: punctuationShape(de, en),
  }
}

/** Nats of penalty for a total lack of each kind of evidence. */
export interface FeatureWeights {
  lexical: number
  cognate: number
  punctuation: number
}

/**
 * Checked against the three gold files in step 13 (`node tools/tune.ts`): coordinate descent
 * over these weights, the deletion scale and the Gale–Church variance found no single change
 * that raises the mean bead recall (Kafka 99.3%, Demian 98.0%, Werther 92.6% without a
 * dictionary, once the paragraph DP could merge four paragraphs into one). Werther's remaining
 * misses are structural, not a matter of weights: a translator's note with no German, a
 * dropped sentence, and 1-3 beads the sentence move set cannot reach.
 */
export const DEFAULT_WEIGHTS: FeatureWeights = { lexical: 3, cognate: 1.5, punctuation: 0.5 }

/**
 * One cost in nats for a bead: the length cost plus, for each overlap signal, its weight times
 * how far the signal falls short of 1, scaled by `size`, the bead's text measured in sentence
 * pairs ((|de| + |en|) / 2, so 1 for a 1-1 bead, 2 for a 2-2, ½ for a one-sided one). Without
 * the scaling a 2-2 bead would pay for missing evidence once where two 1-1 beads pay twice,
 * and the sentence DP would merge everything. A one-sided bead pays all three in full for its
 * half pair, so dropping a sentence still costs more than matching it to anything that shares
 * a word.
 */
export function combinedCost(f: BeadFeatures, w: FeatureWeights = DEFAULT_WEIGHTS, size = 1): number {
  const missing = w.lexical * (1 - f.lexical) + w.cognate * (1 - f.cognate) + w.punctuation * (1 - f.punctuation)
  return f.length + size * missing
}
