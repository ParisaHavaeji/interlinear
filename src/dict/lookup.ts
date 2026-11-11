/**
 * Dictionary lookup (plan.md step 22, §1.3): from a word the reader tapped to the headwords
 * that explain it. DOM-free; the shards come through a {@link ShardLoader} the caller injects
 * (`dict/shards.ts` reads them from Cache Storage in the browser, tests hand in a map).
 *
 * A {@link Dictionary} keeps a small in-memory LRU of decoded shards: a shard is 20–400 KB of
 * gzipped JSON and a page of reading touches a dozen prefixes, so the dozen stay parsed while
 * the rest are re-read from the cache when a tap needs them. Concurrent requests for one shard
 * share one load.
 *
 * {@link Dictionary.lookup} goes through the steps of §1.3 until one yields a headword:
 *
 * 1. **Normalise** ({@link normalizeToken}): NFC, quotes and punctuation around the token
 *    stripped, soft hyphens removed; then the candidates a tapped word may stand for
 *    ({@link candidates}): the word, without a clitic "'s" (geht's → geht), a separable verb's
 *    infinitive without its "zu" (hinaufzukriechen → hinaufkriechen), a hyphenated compound
 *    joined (Schwarz-Weiß → Schwarzweiß), and its last part.
 * 2. **Exact and inflected** (one step, since the format folds both): the folded candidate is
 *    read in `forms`, which maps every lemma's own folded form and every inflected form to
 *    its lemmas, so "Haus", "HAUS", "Hauses", "Häusern" and "mußte" (→ musste → müssen) all
 *    land. Each lemma's entries are then read from the lemma's own shard.
 * 3. **Stem guess**: when the index has nothing, common inflectional endings are stripped and
 *    the stem tried (Prokuristen → Prokurist). FreeDict words have no forms of their own, so
 *    this is what catches their genitives and plurals; the result is marked uncertain.
 * 4. **Compound split** ({@link splitCompound}): the longest suffix that is a known form of a
 *    content word, whose remainder is itself a known word, possibly after a linking element
 *    (Haustür → Haus + Tür, Kinderwelt → Kinder + Welt, Liebesbrief → Liebe + s + Brief,
 *    Dampfschifffahrt → Dampf + Schiff + Fahrt). The head is the headword, the parts come along.
 * 5. **Separable verb** ({@link reuniteSeparable}, needs the sentence): a particle at the end of
 *    the clause after the tapped verb is prepended to its form and looked up again ("fing … an"
 *    → anfing → anfangen), and tapping the particle finds the verb before it. The reunited verb
 *    goes first; the plain verb (fangen, to catch) stays as an alternative.
 *
 * Headwords are ranked ({@link rankHeadwords}) so that the entry a reader wants comes first.
 * Lemmas whose capitalisation agrees with the word come first, since German capitalises
 * exactly its nouns: a lowercase word is never a noun ("linke" is the adjective, not die
 * Linke), and a capitalised word inside a sentence is one (the sentence tells whether the word
 * opened it, where its capital says nothing). Then a word with a real part of speech before
 * names and abbreviations ("Häusern" is houses before the municipality) and before FreeDict's
 * part-less `other` entries (FreeDict lists inflected forms as headwords of their own: "sah:
 * viewed", "Städte: towns"), Wiktionary before FreeDict-only. Then how the word reached the
 * lemma: a verb reunited with its particle, the exact spelling ("Weg" before "weg" for "Weg"),
 * a case-insensitive match ("an" before the abbreviation-only "Arbeitnehmer" for "An"),
 * inflected forms.
 */

import { foldForm, shardKey, type DictEntry, type DictShard, type Pos } from './format.ts'

// ---------------------------------------------------------------------------------------------
// Shards and the LRU

/** Loads one shard by its {@link shardKey}; null when the dictionary has no such shard. */
export type ShardLoader = (key: string) => Promise<DictShard | null>

/** Decoded shards kept in memory at once. */
export const DEFAULT_SHARD_CAPACITY = 24

export interface DictionaryOptions {
  /** Shards kept decoded in memory; the least recently used is dropped past this. */
  capacity?: number
}

/**
 * The shards reachable through a loader, with the LRU in front. `shard()` is the one way in;
 * {@link Dictionary} builds the lookup on top of it.
 */
export class ShardCache {
  private readonly shards = new Map<string, DictShard | null>()
  private readonly pending = new Map<string, Promise<DictShard | null>>()
  private readonly load: ShardLoader
  readonly capacity: number
  /** Loads the loader has been asked for, for tests and the debug view. */
  loads = 0

  constructor(load: ShardLoader, capacity: number = DEFAULT_SHARD_CAPACITY) {
    this.load = load
    this.capacity = Math.max(1, capacity)
  }

  /** The decoded shard for a key, loading it when it is not in memory. */
  shard(key: string): Promise<DictShard | null> {
    const have = this.shards.get(key)
    if (have !== undefined || this.shards.has(key)) {
      // Re-insert so the map's order is least recently used first.
      this.shards.delete(key)
      this.shards.set(key, have ?? null)
      return Promise.resolve(have ?? null)
    }
    let p = this.pending.get(key)
    if (p === undefined) {
      this.loads++
      p = this.load(key)
        .then((shard) => {
          this.remember(key, shard)
          return shard
        })
        .finally(() => this.pending.delete(key))
      this.pending.set(key, p)
    }
    return p
  }

  private remember(key: string, shard: DictShard | null): void {
    this.shards.delete(key)
    this.shards.set(key, shard)
    while (this.shards.size > this.capacity) {
      const oldest = this.shards.keys().next().value
      if (oldest === undefined) break
      this.shards.delete(oldest)
    }
  }

  /** Keys currently decoded in memory, least recently used first. */
  keys(): string[] {
    return [...this.shards.keys()]
  }

  /** Forget every decoded shard (after the dictionary on disk changed). */
  clear(): void {
    this.shards.clear()
  }
}

// ---------------------------------------------------------------------------------------------
// Normalisation

/** Characters stripped from the ends of a tapped token: anything that is not a letter or digit. */
const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu
/** Soft hyphens and zero-width characters a text may carry inside words. */
const INVISIBLE = /[­​‌‍﻿]/g
/** A clitic "es" or genitive marker after an apostrophe: geht's, Goethe's. */
const CLITIC = /[’']s$/u

/**
 * The word inside a tapped token: NFC, invisible characters removed, quotes, dashes and
 * punctuation stripped from both ends. "„Haus“," → "Haus"; "..." → "".
 */
export function normalizeToken(token: string): string {
  return token.normalize('NFC').replace(INVISIBLE, '').replace(EDGE, '')
}

/**
 * The spellings a normalised word may be filed under, in the order to try them: the word
 * itself; without a clitic "'s"; a separable verb's zu-infinitive with the "zu" taken out
 * (hinaufzukriechen → hinaufkriechen, which the index knows when it lacks the zu-form); a
 * hyphenated word joined and, failing that, its last part (the head of a German compound).
 * Distinct, non-empty.
 */
export function candidates(word: string): string[] {
  const out: string[] = []
  const add = (w: string): void => {
    if (w !== '' && !out.includes(w)) out.push(w)
  }
  add(word)
  add(word.replace(CLITIC, ''))
  const folded = foldForm(word)
  for (const particle of SEPARABLE_PARTICLES) {
    if (folded.startsWith(particle + 'zu') && folded.length >= particle.length + 2 + MIN_HEAD) add(word.slice(0, particle.length) + word.slice(particle.length + 2))
  }
  if (word.includes('-')) {
    const parts = word.split('-').filter((p) => p !== '')
    add(parts.join(''))
    if (parts.length > 1) add(parts[parts.length - 1])
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Results

/** How a headword was reached from the tapped word. */
export type Via =
  /** The lemma is spelled exactly like the word. */
  | 'exact'
  /** The lemma differs only in case or ß/ss. */
  | 'case'
  /** The word is an inflected form of the lemma, by the index. */
  | 'form'
  /** A guessed stem after stripping an inflectional ending; uncertain. */
  | 'stem'
  /** A separable verb reunited with its particle from the sentence. */
  | 'separable'
  /** The head of a compound the dictionary lacks as a whole. */
  | 'compound'

export interface CompoundPart {
  /** The slice of the folded word this part covers, linking element included. */
  text: string
  lemma: string
  entries: DictEntry[]
}

export interface Headword {
  lemma: string
  /** The lemma's entries, one per part of speech, in the dictionary's order. */
  entries: DictEntry[]
  via: Via
  /** `separable`: the particle found in the sentence ("an" of "fing … an"). */
  particle?: string
  /** `compound`: the parts in reading order, the head last. */
  parts?: CompoundPart[]
}

export interface LookupResult {
  /** The token as tapped. */
  token: string
  /** The normalised word, what the headwords were found for ("" when the token had no word). */
  word: string
  /** Ranked headwords; empty when the dictionary has nothing to say. */
  headwords: Headword[]
}

/** A verb reunited with its particle from the sentence outranks even an exact match of the word. */
const VIA_RANK: Record<Via, number> = { separable: -1, exact: 0, case: 1, form: 2, compound: 3, stem: 4 }

/** Parts of speech that can stand on their own as parts of a compound or as a plain headword. */
const CONTENT_POS: ReadonlySet<Pos> = new Set<Pos>(['noun', 'verb', 'adj', 'adv', 'num', 'name'])

/** Content words first, names and abbreviations next, FreeDict's part-less entries last. */
function posRank(pos: Pos): number {
  return pos === 'other' ? 2 : pos === 'name' || pos === 'abbrev' ? 1 : 0
}

/** Rank of an entry list: by its best part of speech, Wiktionary before FreeDict-only. */
function entriesRank(entries: readonly DictEntry[]): number {
  const pos = Math.min(...entries.map((e) => posRank(e.pos)))
  const wikt = entries.some((e) => e.src !== 'freedict')
  return pos * 2 + (wikt ? 0 : 1)
}

function isUpper(s: string): boolean {
  const c = s[0] ?? ''
  return c !== c.toLowerCase() && c === c.toUpperCase()
}

/**
 * Whether a lemma's capitalisation contradicts the word's: a lowercase word against a
 * capitalised lemma (never a noun), or, for a word known not to open its sentence, a
 * capitalised word against a lowercase lemma. A word that may open its sentence (`initial`
 * unknown or true) only rules out capitalised lemmas when it is lowercase itself.
 */
function caseClash(word: string, lemma: string, initial: boolean | undefined): boolean {
  if (word === '' || lemma === '') return false
  if (!isUpper(word)) return isUpper(lemma)
  return initial === false && !isUpper(lemma)
}

/**
 * Order headwords for the card: agreement of the capitalisation with `word` first (see
 * {@link caseClash}), then part of speech and source, then how directly the word reached the
 * lemma, then the dictionary's own order. Stable.
 */
export function rankHeadwords(headwords: Headword[], word = '', initial?: boolean): Headword[] {
  return headwords
    .map((h, i) => ({ h, i, rank: (caseClash(word, h.lemma, initial) ? 1000 : 0) + entriesRank(h.entries) * 100 + VIA_RANK[h.via] }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.h)
}

// ---------------------------------------------------------------------------------------------
// Separable verbs

/**
 * Particles a German verb can shed to the end of its clause. Prepositional ones double as
 * prepositions, so a candidate only counts at the end of a clause (see {@link particleAfter}).
 */
export const SEPARABLE_PARTICLES: ReadonlySet<string> = new Set([
  'ab', 'an', 'auf', 'aus', 'bei', 'da', 'dar', 'durch', 'ein', 'empor', 'entgegen', 'entlang', 'fehl', 'fern', 'fest', 'fort', 'frei', 'gegenüber', 'heim',
  'her', 'herab', 'heran', 'herauf', 'heraus', 'herbei', 'herein', 'herüber', 'herum', 'herunter', 'hervor', 'hin', 'hinab', 'hinan', 'hinauf', 'hinaus',
  'hindurch', 'hinein', 'hinüber', 'hinunter', 'hinweg', 'hinzu', 'los', 'mit', 'nach', 'nieder', 'statt', 'teil', 'über', 'um', 'umher', 'unter', 'vor',
  'voran', 'voraus', 'vorbei', 'vorüber', 'weg', 'weiter', 'wider', 'wieder', 'zu', 'zurecht', 'zurück', 'zusammen', 'zuvor', 'zuwider',
])

/** Words of a sentence with their offsets; the same word class as the reader's tokeniser. */
const WORDS = /[\p{L}\p{M}\p{N}]+(?:[’'-][\p{L}\p{M}\p{N}]+)*/gu

interface SentenceWord {
  text: string
  start: number
  end: number
}

function wordsOf(sentence: string): SentenceWord[] {
  const out: SentenceWord[] = []
  for (const m of sentence.matchAll(WORDS)) out.push({ text: m[0], start: m.index, end: m.index + m[0].length })
  return out
}

/**
 * Whether a word ends its clause: only whitespace follows before the sentence ends or before
 * punctuation, or the next word is "zu" (fing an, zu weinen / fing an zu weinen). A particle
 * followed by a noun phrase ("ging nach Hause") is a preposition, not a separated prefix.
 */
function endsClause(sentence: string, words: SentenceWord[], i: number): boolean {
  const w = words[i]
  const rest = sentence.slice(w.end)
  if (/^\s*$/.test(rest)) return true
  if (/^\s*[,;:.!?…)»“"”'’–—-]/.test(rest)) return true
  const next = words[i + 1]
  return next !== undefined && foldForm(next.text) === 'zu'
}

/**
 * Where a tapped word sits among the words of its sentence: at `offset` when given, else the
 * first word spelled like it (a plain `indexOf` would find "an" inside "lange"). -1 when the
 * sentence does not contain it.
 */
function locate(words: SentenceWord[], word: string, offset: number | undefined): number {
  if (offset !== undefined) {
    const i = words.findIndex((w) => w.start <= offset && offset < w.end)
    if (i >= 0) return i
  }
  const exact = words.findIndex((w) => normalizeToken(w.text) === word)
  if (exact >= 0) return exact
  const folded = foldForm(word)
  return words.findIndex((w) => foldForm(normalizeToken(w.text)) === folded)
}

/** Punctuation that separates clauses, as far as a separated particle is concerned. */
const CLAUSE_BREAK = /[,;:()–—]/g

/**
 * The particles standing at the end of a clause after `offset` in the sentence, nearest
 * first, folded, up to the first clause break after the offset (a particle right before the
 * break still counts: "fing sofort an, die Tür…"). Exported for the tests.
 */
export function particlesAfter(sentence: string, offset: number): string[] {
  const words = wordsOf(sentence)
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w.start < offset) continue
    const f = foldForm(w.text)
    if (SEPARABLE_PARTICLES.has(f) && endsClause(sentence, words, i)) out.push(f)
    const next = words[i + 1]
    if (next !== undefined && CLAUSE_BREAK.test(sentence.slice(w.end, next.start))) break
  }
  return out
}

/** Index of the first word of the clause the word at `here` is in. */
function clauseStart(sentence: string, words: SentenceWord[], here: number): number {
  for (let i = here; i > 0; i--) if (CLAUSE_BREAK.test(sentence.slice(words[i - 1].end, words[i].start))) return i
  return 0
}

// ---------------------------------------------------------------------------------------------
// Compounds

/** Linking elements between the parts of a compound, tried after the bare modifier. */
const LINKERS = ['', 's', 'es', 'n', 'en', 'er', 'e', 'ens']
/** Shortest head and modifier of a compound, in characters of the folded word. */
const MIN_HEAD = 3
const MIN_MODIFIER = 2
/** Most parts a compound is cut into. */
const MAX_PARTS = 4

// ---------------------------------------------------------------------------------------------
// The dictionary

export interface LookupOptions {
  /** The sentence the token came from, for separable verbs. */
  sentence?: string
  /** Offset of the token in the sentence, when known (else its first occurrence). */
  offset?: number
}

export class Dictionary {
  readonly shards: ShardCache

  constructor(load: ShardLoader, options: DictionaryOptions = {}) {
    this.shards = new ShardCache(load, options.capacity)
  }

  /** The lemmas a folded form maps to in the index, in the index's order. */
  async lemmasOf(folded: string): Promise<string[]> {
    if (folded === '') return []
    const shard = await this.shards.shard(shardKey(folded))
    return shard?.forms[folded] ?? []
  }

  /** The entries of a lemma, from its own shard. */
  async entriesOf(lemma: string): Promise<DictEntry[]> {
    const shard = await this.shards.shard(shardKey(lemma))
    return shard?.entries[lemma] ?? []
  }

  /**
   * Headwords for a word by the forms index alone: the lemmas of its folded form with their
   * entries, each tagged exact / case / form against the word as written.
   */
  async headwordsOf(word: string, via: Via | null = null): Promise<Headword[]> {
    const folded = foldForm(word)
    const lemmas = await this.lemmasOf(folded)
    const out: Headword[] = []
    for (const lemma of lemmas) {
      const entries = await this.entriesOf(lemma)
      if (entries.length === 0) continue
      out.push({ lemma, entries, via: via ?? (lemma === word ? 'exact' : foldForm(lemma) === folded ? 'case' : 'form') })
    }
    return out
  }

  /** The §1.3 lookup. Never throws for a word the dictionary lacks: the headwords are empty. */
  async lookup(token: string, options: LookupOptions = {}): Promise<LookupResult> {
    const word = normalizeToken(token)
    const result: LookupResult = { token, word, headwords: [] }
    if (word === '') return result

    for (const candidate of candidates(word)) {
      let headwords = await this.headwordsOf(candidate)
      if (headwords.length === 0) headwords = await this.stemGuess(candidate)
      if (headwords.length === 0) {
        const compound = await this.splitCompound(candidate)
        if (compound !== null) headwords = [compound]
      }
      if (headwords.length === 0) continue
      result.headwords = headwords
      break
    }

    let initial: boolean | undefined
    if (options.sentence !== undefined) {
      const words = wordsOf(options.sentence)
      const here = locate(words, word, options.offset)
      if (here >= 0) {
        initial = here === 0
        const reunited = await this.reuniteSeparable(word, options.sentence, words[here].start)
        if (reunited !== null) result.headwords = [reunited, ...result.headwords.filter((h) => h.lemma !== reunited.lemma)]
      }
    }

    result.headwords = rankHeadwords(result.headwords, word, initial)
    return result
  }

  /** Endings tried on a word the index does not know, shortest stem last. */
  private static readonly ENDINGS = ['ens', 'est', 'ete', 'ten', 'tet', 'es', 'en', 'er', 'em', 'st', 'te', 'e', 'n', 's', 't']

  /**
   * Step 3: strip an inflectional ending and look the stem up; the first ending whose stem
   * resolves to a content word wins. Uncertain, hence `via: 'stem'`.
   */
  async stemGuess(word: string): Promise<Headword[]> {
    const folded = foldForm(word)
    const tried = new Set<string>()
    for (const ending of Dictionary.ENDINGS) {
      if (!folded.endsWith(ending)) continue
      const stem = folded.slice(0, -ending.length)
      if (stem.length < 3 || tried.has(stem)) continue
      tried.add(stem)
      const headwords = (await this.headwordsOf(stem, 'stem')).filter((h) => h.entries.some((e) => CONTENT_POS.has(e.pos)))
      if (headwords.length > 0) return headwords
    }
    return []
  }

  /**
   * The headword of a folded part of a compound: a content word, a noun when `noun` and one
   * reads that way ("haus" is Haus before hausen), else a non-noun when one does (the head of
   * lowercase "hinaufkriechen" is the verb kriechen, not the gerund Kriechen). The part has
   * lost its case, so none is checked.
   */
  private async partOf(folded: string, noun: boolean): Promise<Headword | null> {
    const headwords = await this.headwordsOf(folded)
    const content = rankHeadwords(headwords.filter((h) => h.entries.some((e) => CONTENT_POS.has(e.pos))))
    return content.find((h) => h.entries.some((e) => e.pos === 'noun') === noun) ?? content[0] ?? null
  }

  /**
   * Step 4: cut a word the dictionary lacks into known parts, longest head first. Returns the
   * head as a `compound` headword carrying every part, or null when no cut has all its parts
   * in the dictionary.
   */
  async splitCompound(word: string): Promise<Headword | null> {
    const folded = foldForm(word)
    // A capitalised compound is a noun and so is its head; a lowercase one is not.
    const parts = await this.cut(folded, MAX_PARTS, isUpper(word))
    if (parts === null || parts.length < 2) return null
    const head = parts[parts.length - 1]
    return { lemma: head.lemma, entries: head.entries, via: 'compound', parts }
  }

  /**
   * The parts of `folded`, or of its longest known head and a known remainder, recursively.
   * `noun` says whether the head should be one; modifiers are taken as nouns when they can be.
   */
  private async cut(folded: string, budget: number, noun: boolean): Promise<CompoundPart[] | null> {
    if (budget === 0 || folded.length < MIN_MODIFIER) return null
    const whole = await this.partOf(folded, noun)
    if (whole !== null) return [{ text: folded, lemma: whole.lemma, entries: whole.entries }]
    if (budget === 1) return null
    for (let i = MIN_MODIFIER; i <= folded.length - MIN_HEAD; i++) {
      const head = await this.partOf(folded.slice(i), noun)
      if (head === null) continue
      // Readings of the modifier, one per linking element it can end in; a noun modifier is
      // preferred ("Liebes-" is Liebe + s before the adjective form "liebes").
      let first: CompoundPart[] | null = null
      for (const linker of LINKERS) {
        if (!folded.slice(0, i).endsWith(linker)) continue
        const modifier = folded.slice(0, i - linker.length)
        if (modifier.length < MIN_MODIFIER) continue
        const rest = await this.cut(modifier, budget - 1, true)
        if (rest === null) continue
        const last = rest[rest.length - 1]
        rest[rest.length - 1] = { ...last, text: last.text + linker }
        if (last.entries.some((e) => e.pos === 'noun')) return [...rest, { text: folded.slice(i), lemma: head.lemma, entries: head.entries }]
        first ??= [...rest, { text: folded.slice(i), lemma: head.lemma, entries: head.entries }]
      }
      if (first !== null) return first
    }
    return null
  }

  /**
   * Step 5: the separable verb a tapped word belongs to, from its sentence. Tapping the verb
   * ("fing") finds a particle at the end of its clause ("an") and the lemma of "anfing";
   * tapping such a particle finds the verb before it. Null when the sentence has no such pair.
   */
  async reuniteSeparable(word: string, sentence: string, offset?: number): Promise<Headword | null> {
    const folded = foldForm(word)
    if (folded === '') return null
    const words = wordsOf(sentence)
    const here = locate(words, word, offset)
    if (here < 0) return null

    if (SEPARABLE_PARTICLES.has(folded) && endsClause(sentence, words, here)) {
      // The particle was tapped: its verb is the finite verb of the clause, which German puts
      // early (second position), so the clause is read from its start: in "er sah den Vater
      // lange an", "sah" is reached before "lange" (a form of langen, which would make
      // anlangen). The word must itself be a verb form.
      for (let i = clauseStart(sentence, words, here); i < here; i++) {
        const form = foldForm(normalizeToken(words[i].text))
        const verb = await this.verbOf(folded + form, folded)
        if (verb !== null && (await this.isVerbForm(form))) return verb
      }
      return null
    }

    for (const particle of particlesAfter(sentence, words[here].end)) {
      const verb = await this.verbOf(particle + folded, particle)
      if (verb !== null) return verb
    }
    return null
  }

  /** Whether the index knows a folded form as a form of some verb. */
  private async isVerbForm(form: string): Promise<boolean> {
    for (const lemma of await this.lemmasOf(form)) if ((await this.entriesOf(lemma)).some((e) => e.pos === 'verb')) return true
    return false
  }

  /** The verb headword of a reunited form, when the index knows it as a verb. */
  private async verbOf(form: string, particle: string): Promise<Headword | null> {
    for (const lemma of await this.lemmasOf(form)) {
      const entries = await this.entriesOf(lemma)
      if (entries.some((e) => e.pos === 'verb')) return { lemma, entries: entries.filter((e) => e.pos === 'verb'), via: 'separable', particle }
    }
    return null
  }
}
