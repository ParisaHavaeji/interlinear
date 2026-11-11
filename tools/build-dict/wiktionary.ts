/**
 * One line of the kaikki.org German extract of the English Wiktionary → a dictionary entry
 * and/or form links (plan.md step 21). Pure, so the tests feed it sample lines.
 *
 * A kaikki line is one JSON object per word and part of speech: `word`, `pos`, `senses` (each
 * with `glosses`, a general-to-specific list, and `tags`), `forms` (the headline's genitive and
 * plural, then the whole declension or conjugation table with `source: "declension"`, also
 * including the one-word subordinate-clause forms of separable verbs, "anreist") and
 * `head_templates` (whose `expansion` is the printed headline, "Loh m or n (strong, …)").
 * Inflected forms also have lines of their own whose senses carry `form_of` ("genitive
 * singular of Engen") or `alt_of` ("alternative spelling of aufwendig"); those become links from
 * the form to the lemma, not entries.
 */

import type { Pos } from '../../src/dict/format.ts'

export interface WiktEntry {
  lemma: string
  pos: Pos
  gender?: string
  plural?: string
  glosses: string[]
  /** One-word inflected forms of the lemma, as written, without the lemma itself. */
  forms: string[]
}

/** A surface form that another entry declares a form or alternative spelling of `lemma`. */
export interface WiktLink {
  form: string
  lemma: string
}

export interface WiktParse {
  entry: WiktEntry | null
  links: WiktLink[]
  /** Why the line yielded no entry, for the build log: "pos:prefix", "no-glosses", "lang:en". */
  skipped?: string
}

/** kaikki parts of speech kept, with the name the dictionary stores them under. */
export const POS_MAP: Readonly<Record<string, Pos>> = {
  noun: 'noun',
  verb: 'verb',
  adj: 'adj',
  adv: 'adv',
  prep: 'prep',
  postp: 'prep',
  pron: 'pron',
  conj: 'conj',
  det: 'det',
  article: 'det',
  num: 'num',
  intj: 'intj',
  particle: 'particle',
  name: 'name',
  phrase: 'phrase',
  prep_phrase: 'phrase',
  adv_phrase: 'phrase',
  abbrev: 'abbrev',
  contraction: 'contraction',
}

/** Most glosses kept per entry. */
export const MAX_GLOSSES = 3
/** Longest gloss kept; longer ones are cut at a word boundary. */
export const MAX_GLOSS_LENGTH = 120

/** Sense tags that put a gloss after the usual ones. */
const DEPRECATED_TAGS = new Set([
  'obsolete', 'archaic', 'dated', 'rare', 'historical', 'dialectal', 'regional', 'vulgar', 'derogatory', 'offensive',
  'nonstandard', 'misspelling', 'proscribed', 'uncommon', 'no-longer-productive',
])

/** Sense tags of a form-of or alternative-form sense (a link, not a meaning). */
const LINK_TAGS = new Set(['form-of', 'alt-of'])

/** Glosses that only point elsewhere, kept out even when not tagged as a link. */
const POINTER_GLOSS = /^(?:\w+[- ])*(?:form|spelling|case form|letter-case form|inflection|romanization|misspelling|abbreviation|initialism|acronym|clipping|contraction|synonym|variant|ellipsis) of\b/i

/** Table rows that are not forms. */
const NON_FORM_TAGS = new Set(['table-tags', 'inflection-template', 'class', 'auxiliary', 'romanization', 'diminutive'])
const CASE_OR_NUMBER_TAGS = new Set(['nominative', 'genitive', 'dative', 'accusative', 'singular', 'plural'])
const GENDER_TAGS: Readonly<Record<string, string>> = { masculine: 'm', feminine: 'f', neuter: 'n' }
const GENDER_ORDER = ['m', 'f', 'n']

/** A single word: letters and marks, with inner apostrophes or hyphens ("Schloss", "Hans-Peter", "geh'n"). */
const SINGLE_WORD = /^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u

interface RawSense {
  glosses?: string[]
  tags?: string[]
  form_of?: { word: string }[]
  alt_of?: { word: string }[]
}

interface RawForm {
  form: string
  tags?: string[]
  source?: string
}

interface RawLine {
  word?: string
  pos?: string
  lang_code?: string
  senses?: RawSense[]
  forms?: RawForm[]
  head_templates?: { expansion?: string }[]
}

function isLinkSense(s: RawSense): boolean {
  return (s.form_of?.length ?? 0) > 0 || (s.alt_of?.length ?? 0) > 0 || (s.tags ?? []).some((t) => LINK_TAGS.has(t))
}

/** Cut a gloss at a word boundary when it runs past {@link MAX_GLOSS_LENGTH}. */
export function trimGloss(gloss: string): string {
  const g = gloss.replace(/\s+/g, ' ').trim().replace(/:$/, '')
  if (g.length <= MAX_GLOSS_LENGTH) return g
  const cut = g.lastIndexOf(' ', MAX_GLOSS_LENGTH - 1)
  return (cut > MAX_GLOSS_LENGTH / 2 ? g.slice(0, cut) : g.slice(0, MAX_GLOSS_LENGTH - 1)).replace(/[,;:]$/, '') + '…'
}

/** A gloss that only labels the ones under it ("agent noun of schreien:") or points elsewhere. */
function isPointer(gloss: string): boolean {
  return gloss === '' || gloss.endsWith(':') || POINTER_GLOSS.test(gloss)
}

/**
 * The glosses of an entry. A kaikki sense's `glosses` run from the general to the specific:
 * "Bild" has nine sub-senses under "depiction, image, picture" ("digital photograph",
 * "painting", …), "Schreier" has "agent noun of schreien:" over "crier". The entry gets the
 * most general gloss of each sense that is not a mere label or pointer, senses in their order,
 * the usual ones before the obsolete, archaic, dated, rare or regional (kept, not dropped: the
 * books this is for are old, and Werther's "Frauenzimmer" is no misprint); then, while slots
 * are left, the specific glosses in the same order. At most {@link MAX_GLOSSES}, distinct
 * ignoring case.
 */
export function pickGlosses(senses: readonly RawSense[]): string[] {
  const general: [string, boolean][] = []
  const specific: [string, boolean][] = []
  for (const s of senses) {
    if (isLinkSense(s) || s.glosses === undefined) continue
    const levels = s.glosses.map((g) => g.trim()).filter((g) => !isPointer(g))
    if (levels.length === 0) continue
    const deprecated = (s.tags ?? []).some((t) => DEPRECATED_TAGS.has(t))
    general.push([trimGloss(levels[0]), deprecated])
    if (levels.length > 1) specific.push([trimGloss(levels[levels.length - 1]), deprecated])
  }
  const ranked = [...general.filter(([, d]) => !d), ...general.filter(([, d]) => d), ...specific.filter(([, d]) => !d), ...specific.filter(([, d]) => d)]
  const out: string[] = []
  for (const [g] of ranked) {
    if (out.length === MAX_GLOSSES) break
    if (!out.some((h) => h.toLowerCase() === g.toLowerCase())) out.push(g)
  }
  return out
}

/**
 * Gender of a noun: from the sense tags, else from the headline ("Loh m or n (strong, …)",
 * "Eltern pl (plural only)"), several joined "m/n"; "pl" for plural-only nouns.
 */
export function pickGender(senses: readonly RawSense[], expansion: string | undefined): string | undefined {
  const found = new Set<string>()
  let pluralOnly = false
  for (const s of senses) {
    for (const t of s.tags ?? []) {
      const g = GENDER_TAGS[t]
      if (g !== undefined) found.add(g)
      if (t === 'plural-only') pluralOnly = true
    }
  }
  if (found.size === 0 && expansion !== undefined) {
    const m = /^.+? ((?:m|f|n)(?: or (?:m|f|n))*)(?: \(|$)/.exec(expansion)
    if (m !== null) for (const g of m[1].split(' or ')) found.add(g)
    else if (/^.+? pl(?: \(|$)/.test(expansion)) pluralOnly = true
  }
  if (found.size > 0) return GENDER_ORDER.filter((g) => found.has(g)).join('/')
  return pluralOnly ? 'pl' : undefined
}

/** Nominative plural: the headline's plural, else the table's nominative plural row. */
export function pickPlural(forms: readonly RawForm[]): string | undefined {
  for (const f of forms) {
    const tags = f.tags ?? []
    if (tags.length === 1 && tags[0] === 'plural' && SINGLE_WORD.test(f.form)) return f.form
  }
  for (const f of forms) {
    const tags = f.tags ?? []
    if (tags.includes('plural') && tags.includes('nominative') && SINGLE_WORD.test(f.form)) return f.form
  }
  return undefined
}

/**
 * The one-word inflected forms of the table: no template rows, no multi-word forms (the
 * separable verb's "reist an" is covered by its subordinate-clause row "anreist", the
 * adjective's "am freiesten" by nothing), no diminutives, and no gendered counterparts of a
 * noun ("Schreierin" under "Schreier" is a different word, not a form).
 */
export function pickForms(lemma: string, pos: Pos, forms: readonly RawForm[]): string[] {
  const out = new Set<string>()
  for (const f of forms) {
    const tags = f.tags ?? []
    if (tags.some((t) => NON_FORM_TAGS.has(t))) continue
    if ((pos === 'noun' || pos === 'name') && tags.some((t) => t === 'feminine' || t === 'masculine') && !tags.some((t) => CASE_OR_NUMBER_TAGS.has(t))) continue
    const form = f.form.trim()
    if (form === lemma || !SINGLE_WORD.test(form)) continue
    out.add(form)
  }
  return [...out]
}

/** Parse one kaikki line. Lines of other languages, unkept parts of speech and malformed JSON yield no entry. */
export function parseWiktionaryLine(line: string): WiktParse {
  let raw: RawLine
  try {
    raw = JSON.parse(line) as RawLine
  } catch {
    return { entry: null, links: [], skipped: 'json' }
  }
  if (raw.lang_code !== undefined && raw.lang_code !== 'de') return { entry: null, links: [], skipped: `lang:${raw.lang_code}` }
  const word = raw.word?.normalize('NFC').trim() ?? ''
  if (word === '') return { entry: null, links: [], skipped: 'no-word' }
  const pos = POS_MAP[raw.pos ?? '']
  if (pos === undefined) return { entry: null, links: [], skipped: `pos:${raw.pos ?? '?'}` }

  const senses = raw.senses ?? []
  const links: WiktLink[] = []
  for (const s of senses) {
    for (const target of [...(s.form_of ?? []), ...(s.alt_of ?? [])]) {
      const lemma = target.word.normalize('NFC').trim()
      if (lemma !== '' && lemma !== word && !links.some((l) => l.lemma === lemma)) links.push({ form: word, lemma })
    }
  }

  const glosses = pickGlosses(senses)
  if (glosses.length === 0) return { entry: null, links, skipped: links.length > 0 ? 'link' : 'no-glosses' }

  const forms = raw.forms ?? []
  const entry: WiktEntry = { lemma: word, pos, glosses, forms: pickForms(word, pos, forms) }
  if (pos === 'noun' || pos === 'name') {
    const gender = pickGender(senses, raw.head_templates?.[0]?.expansion)
    if (gender !== undefined) entry.gender = gender
    const plural = pickPlural(forms)
    if (plural !== undefined) entry.plural = plural
  }
  return { entry, links }
}
