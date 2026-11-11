/**
 * The word card's model (plan.md step 24, §1.6), kept apart from the DOM so it can be tested:
 * how a {@link LookupResult} of `dict/lookup.ts` becomes what the card shows, the article a
 * noun takes and the colour it gets, the labels for parts of speech and sources, and the text
 * Copy puts on the clipboard.
 *
 * A tap lands on one word of one sentence (`WordRef`). The dictionary returns ranked headwords;
 * the card shows the first in full (every entry of that lemma: "Weg" has one, "Lange" the name
 * and "lange" the adjective form are two headwords), the others as compact alternatives the
 * reader can switch to. Articles are coloured by gender, der / die / das in colours the reader
 * can change in Settings (`store/settings.ts`); the plural "die" is not a gender and stays
 * uncoloured.
 */

import { percentOf, type DictState } from '../dict/download.ts'
import type { DictEntry, DictSourceTag, Pos } from '../dict/format.ts'
import type { Headword, LookupResult } from '../dict/lookup.ts'

/** The word tapped: the sentence it is in and where, and its text as printed. */
export interface WordRef {
  /** Book-wide sentence index. */
  sentence: number
  /** Offset of the token within the sentence's text. */
  offset: number
  token: string
}

export function sameWord(a: WordRef | null, b: WordRef | null): boolean {
  return a === b || (a !== null && b !== null && a.sentence === b.sentence && a.offset === b.offset && a.token === b.token)
}

// ---------------------------------------------------------------------------------------------
// Articles and their colours

/** One gender a noun can have; the plural-only `pl` takes "die" without being one. */
export type Gender = 'm' | 'f' | 'n' | 'pl'

export interface Article {
  text: 'der' | 'die' | 'das'
  gender: Gender
}

const ARTICLES: Record<Gender, Article['text']> = { m: 'der', f: 'die', n: 'das', pl: 'die' }

/**
 * The articles for an entry's gender string: "m" → der, "f" → die, "n" → das, "pl" → die, and
 * one per gender when the sources allow several ("m/n" → der, das). Empty for no gender.
 */
export function articlesOf(gender: string | undefined): Article[] {
  if (gender === undefined || gender === '') return []
  const out: Article[] = []
  for (const g of gender.split('/')) {
    if (g in ARTICLES && !out.some((a) => a.gender === g)) out.push({ text: ARTICLES[g as Gender], gender: g as Gender })
  }
  return out
}

/** A colour the reader can give an article; keys are stable, the values live in card.css. */
export type ArticleColour = 'blue' | 'red' | 'green' | 'orange' | 'purple' | 'pink' | 'teal' | 'brown' | 'grey' | 'none'

export const ARTICLE_COLOURS: readonly { key: ArticleColour; label: string }[] = [
  { key: 'blue', label: 'Blue' },
  { key: 'red', label: 'Red' },
  { key: 'green', label: 'Green' },
  { key: 'orange', label: 'Orange' },
  { key: 'purple', label: 'Purple' },
  { key: 'pink', label: 'Pink' },
  { key: 'teal', label: 'Teal' },
  { key: 'brown', label: 'Brown' },
  { key: 'grey', label: 'Grey' },
  { key: 'none', label: 'Plain' },
]

/** The colour of each gender's article; what Settings edits. */
export type ArticleColours = Record<'m' | 'f' | 'n', ArticleColour>

/** The plan's default: der blue, die red, das green. */
export const DEFAULT_ARTICLE_COLOURS: ArticleColours = { m: 'blue', f: 'red', n: 'green' }

/** The colour an article is drawn in under `colours`; the plural "die" has none. */
export function articleColour(article: Article, colours: ArticleColours): ArticleColour {
  return article.gender === 'pl' ? 'none' : colours[article.gender]
}

/** `colours` with every value a known colour; unknown or missing ones fall back to the default. */
export function sanitizeArticleColours(value: unknown): ArticleColours {
  const out = { ...DEFAULT_ARTICLE_COLOURS }
  if (typeof value !== 'object' || value === null) return out
  const keys = new Set(ARTICLE_COLOURS.map((c) => c.key))
  for (const g of ['m', 'f', 'n'] as const) {
    const v = (value as Record<string, unknown>)[g]
    if (typeof v === 'string' && keys.has(v as ArticleColour)) out[g] = v as ArticleColour
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Labels

const POS_LABELS: Record<Pos, string> = {
  noun: 'noun',
  verb: 'verb',
  adj: 'adjective',
  adv: 'adverb',
  prep: 'preposition',
  pron: 'pronoun',
  conj: 'conjunction',
  det: 'determiner',
  num: 'numeral',
  intj: 'interjection',
  particle: 'particle',
  name: 'proper noun',
  phrase: 'phrase',
  abbrev: 'abbreviation',
  contraction: 'contraction',
  other: '',
}

/** The part of speech as the card prints it; empty for FreeDict's part-less entries. */
export function posLabel(pos: Pos): string {
  return POS_LABELS[pos] ?? ''
}

/** "plural" for a plural-only noun, else empty. */
export function genderNote(gender: string | undefined): string {
  return gender === 'pl' ? 'plural' : ''
}

const SOURCE_LABELS: Record<DictSourceTag, string> = { wikt: 'Wiktionary', freedict: 'FreeDict', 'wikt+freedict': 'Wiktionary · FreeDict' }

export function sourceLabel(src: DictSourceTag): string {
  return SOURCE_LABELS[src] ?? src
}

/** The source line for a set of entries: every source among them, once, Wiktionary first. */
export function sourcesOf(entries: readonly DictEntry[]): string {
  const wikt = entries.some((e) => e.src !== 'freedict')
  const free = entries.some((e) => e.src !== 'wikt')
  return wikt && free ? SOURCE_LABELS['wikt+freedict'] : wikt ? SOURCE_LABELS.wikt : free ? SOURCE_LABELS.freedict : ''
}

/**
 * The note under a headword that was not reached directly: how the tapped word relates to it.
 * Empty for an exact or case match, and for an inflected form (the headword line says enough).
 */
export function viaNote(headword: Headword, word: string): string {
  switch (headword.via) {
    case 'separable':
      return headword.particle === undefined ? 'Separable verb' : `Separable verb: ${word} … ${headword.particle}`
    case 'compound': {
      const parts = headword.parts ?? []
      if (parts.length < 2) return 'Compound'
      return `Compound: ${parts.map((p) => partLabel(p.lemma, p.entries)).join(' + ')}`
    }
    case 'stem':
      return 'Best guess from the word’s ending'
    default:
      return ''
  }
}

function partLabel(lemma: string, entries: readonly DictEntry[]): string {
  const gloss = firstGloss(entries)
  return gloss === '' ? lemma : `${lemma} (${gloss})`
}

/** The first gloss of an entry list, shortened to its first comma-separated sense. */
export function firstGloss(entries: readonly DictEntry[]): string {
  for (const e of entries) {
    const g = e.glosses[0]
    if (g !== undefined && g !== '') return g.split(/[,;]/)[0].trim()
  }
  return ''
}

// ---------------------------------------------------------------------------------------------
// The card

/** One entry as the card draws it. */
export interface EntryView {
  lemma: string
  articles: Article[]
  pos: string
  /** "plural" for plural-only nouns. */
  note: string
  plural: string | null
  glosses: string[]
  src: DictSourceTag
}

/** A headword the reader can switch to, in one line. */
export interface AlternativeView {
  /** Index into the result's headwords. */
  index: number
  lemma: string
  articles: Article[]
  pos: string
  gloss: string
}

export interface WordCardView {
  /** The normalised word the headwords were found for ("" when the token had no word). */
  word: string
  /** The headword shown in full, or null when the dictionary has nothing. */
  lemma: string | null
  entries: EntryView[]
  /** How the word reached the lemma, when that is worth a line. */
  via: string
  /** The sources of the shown entries. */
  sources: string
  /** The other headwords, in rank order. */
  alternatives: AlternativeView[]
}

export function entryView(entry: DictEntry): EntryView {
  return {
    lemma: entry.lemma,
    articles: entry.pos === 'noun' || entry.pos === 'name' ? articlesOf(entry.gender) : [],
    pos: posLabel(entry.pos),
    note: genderNote(entry.gender),
    plural: entry.plural ?? null,
    glosses: entry.glosses,
    src: entry.src,
  }
}

/**
 * What the card shows for a lookup, with the headword at `pick` (clamped) in full and the rest
 * as alternatives. Entries without glosses are left out; a headword with none at all is skipped.
 */
export function wordCard(result: LookupResult, pick = 0): WordCardView {
  const headwords = result.headwords.filter((h) => h.entries.some((e) => e.glosses.length > 0))
  const empty: WordCardView = { word: result.word, lemma: null, entries: [], via: '', sources: '', alternatives: [] }
  if (headwords.length === 0) return empty
  const chosen = Math.min(Math.max(0, pick), headwords.length - 1)
  const head = headwords[chosen]
  const entries = head.entries.filter((e) => e.glosses.length > 0)
  const alternatives: AlternativeView[] = []
  headwords.forEach((h, index) => {
    if (index === chosen || alternatives.length >= MAX_ALTERNATIVES) return
    const first = h.entries.find((e) => e.glosses.length > 0)
    if (first === undefined) return
    alternatives.push({
      index,
      lemma: h.lemma,
      articles: first.pos === 'noun' ? articlesOf(first.gender) : [],
      pos: posLabel(first.pos),
      gloss: firstGloss(h.entries),
    })
  })
  return { word: result.word, lemma: head.lemma, entries: entries.map(entryView), via: viaNote(head, result.word), sources: sourcesOf(entries), alternatives }
}

/** Alternatives the card lists under the shown headword; the rest are dropped. */
export const MAX_ALTERNATIVES = 4

/**
 * Why a word may have no entry yet, from the dictionary's state: a download in progress or
 * stalled, a failure. Empty when the dictionary is complete (the word is simply not in it).
 */
export function dictHint(state: DictState): string {
  switch (state.phase) {
    case 'downloading':
      return `The dictionary is still downloading (${percentOf(state.progress)}%).`
    case 'waiting':
      return 'The dictionary is not fully downloaded yet; it continues when you are online.'
    case 'failed':
    case 'unavailable':
      return 'The dictionary could not be downloaded; see Settings.'
    default:
      return ''
  }
}

/** The message for a lookup that threw: a shard that is neither cached nor fetchable, usually. */
export function lookupErrorMessage(err: unknown, online: boolean): string {
  if (!online) return 'This word’s part of the dictionary is not on the device yet. It finishes downloading when you are online.'
  return `Could not read the dictionary: ${err instanceof Error ? err.message : String(err)}`
}

/**
 * What Copy puts on the clipboard for a word: "der Weg (noun, pl. Wege): way, path" per entry,
 * one line each; the word alone when the dictionary had nothing.
 */
export function wordCopyText(view: WordCardView, token: string): string {
  if (view.lemma === null || view.entries.length === 0) return token
  return view.entries
    .map((e) => {
      const article = e.articles.map((a) => a.text).join('/')
      const head = article === '' ? e.lemma : `${article} ${e.lemma}`
      const extras = [e.pos, e.note, e.plural === null ? '' : `pl. ${e.plural}`].filter((s) => s !== '')
      return `${head}${extras.length > 0 ? ` (${extras.join(', ')})` : ''}: ${e.glosses.join('; ')}`
    })
    .join('\n')
}
