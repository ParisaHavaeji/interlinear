/**
 * Alignment Layer B (plan §1.2, step 8): sentence splitting.
 *
 * Splits one paragraph into sentences and records where each one sits in the paragraph text,
 * so the reader can wrap exactly those characters in tappable spans and the sentence DP of
 * step 10 can price beads by character length. Rule-based and language-aware:
 *
 * - A sentence ends at a run of `.`, `!`, `?` or `…`, plus any closing quotes or brackets glued
 *   to it (`.«`, `?”`, `.")`), when whitespace follows and the next token starts a sentence: a
 *   capital or digit, optionally behind opening quotes or brackets.
 * - A lowercase continuation is never a boundary (`»Was ist geschehen?« dachte er`, `"Oh,
 *   sir!" she exclaimed`), which is how dialogue tails stay with their quotation.
 * - A dash run between the terminal mark and the next sentence (`ich.--"Der Graf`,
 *   `cried.—“Mother?”`) is a separator like whitespace: it belongs to neither sentence.
 * - Abbreviations do not end a sentence: single letters (initials, `z. B.`, `d. h.`, `S. 12`),
 *   titles and common abbreviations per language (`Dr.`, `Nr.`, `vgl.`, `Mr.`, `St.`, `vol.`),
 *   and in German a one- or two-digit ordinal (`am 4. Mai`, `im 18. Jahrhundert`). `etc.` and
 *   `usw.` can end a sentence and are deliberately not in the lists; a closing quote right
 *   after the period (`Mr."`) also overrides the lists, since the quote shows the speech ended.
 * - Periods inside numbers and domains (`3.000`, `1.5`, `www.x.de`) are not followed by
 *   whitespace and so never split.
 *
 * The splitter is deterministic and runs on text already collapsed to single spaces by the
 * importers. It makes no attempt at the colon or semicolon, which the plan treats as sentence
 * shape, not sentence ends.
 */

import type { Lang, Paragraph } from '../import/types.ts'

export interface Sentence {
  /** The sentence as it appears in the paragraph, closing quotes included, separators excluded. */
  text: string
  /** Offset of the first character in the paragraph text. */
  charStart: number
  /** Offset one past the last character: `paragraph.text.slice(charStart, charEnd) === text`. */
  charEnd: number
}

/** A sentence placed in a book: what the `sentences` table stores minus book id and language. */
export interface ParagraphSentence extends Sentence {
  /** Running 0-based index over all sentences of the paragraph list. */
  idx: number
  /** `Paragraph.idx` of the paragraph this sentence sits in. */
  paraIdx: number
}

/**
 * Abbreviations that are (almost) never sentence-final, by language, lowercased and without the
 * period. Single letters need no listing: `z. B.`, `u. a.`, `N. N.`, `S. 12` fall under the
 * single-letter rule. Words that are also ordinary words (`no`, `co`, `gen`) are left out or
 * handled by {@link NUMBER_ABBREVIATIONS}.
 */
const ABBREVIATIONS: Record<Lang, ReadonlySet<string>> = {
  de: new Set([
    // titles and names
    'dr', 'prof', 'hr', 'hrn', 'fr', 'frl', 'frau', 'st', 'hl', 'pfr', 'dipl', 'ing', 'mag', 'med', 'jur', 'phil', 'theol',
    // references
    'nr', 'nro', 'bd', 'bde', 'kap', 'abs', 'anm', 'abb', 'tab', 'vgl', 'zit', 'hrsg', 'aufl', 'jg', 'jh', 'jhd', 'jhdt', 'tel',
    // common
    'bzw', 'ca', 'sog', 'evtl', 'ggf', 'inkl', 'exkl', 'einschl', 'entspr', 'insb', 'ugs', 'allg', 'bes', 'betr', 'geb', 'gest',
    'gegr', 'verh', 'verw', 'urspr', 'eig', 'erg', 'etw', 'dgl', 'rd', 'mind', 'max', 'mio', 'mrd', 'tsd', 'tgl', 'vorm', 'nachm',
    'wg', 'zz', 'zzt', 'ev', 'kath', 'str', 'pl', 'ggfs', 'lt', 'ff', 'mo', 'di', 'mi', 'do', 'sa', 'so',
    // months as abbreviated in dates ("4. Sept. 1771")
    'jan', 'feb', 'mär', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'okt', 'nov', 'dez',
  ]),
  en: new Set([
    // titles
    'mr', 'mrs', 'ms', 'dr', 'prof', 'rev', 'hon', 'st', 'mt', 'messrs', 'mme', 'mlle', 'jr', 'sr', 'esq', 'fr', 'sgt', 'capt',
    'col', 'maj', 'cpl', 'gov', 'sen', 'rep', 'pres', 'supt', 'insp',
    // references
    'vol', 'vols', 'ch', 'chap', 'pp', 'fig', 'figs', 'sec', 'para', 'op', 'cit', 'ibid', 'cf', 'viz', 'vs', 'approx', 'dept',
    'inc', 'ltd', 'corp', 'bros',
    // months
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  ]),
}

/** Abbreviations that are ordinary words unless a number follows (`No. 5`, but `He said no.`). */
const NUMBER_ABBREVIATIONS: Record<Lang, ReadonlySet<string>> = {
  de: new Set(['no']),
  en: new Set(['no', 'nos', 'p']),
}

/** A run of terminal marks. `…` is one character; `...` is a run of three periods. */
const TERMINAL_RUN = /[.!?…]+/gu
/** Closing quotes and brackets glued to the terminal mark. German `“` closes `„…“`. */
const CLOSERS = /[”“"’'»«)\]]*/uy
/** What may stand between two sentences: whitespace, or a dash run with optional spaces. */
const SEPARATOR = /(?:\s*(?:-{2,}|[—–]+)\s*|\s+)/uy
/** A sentence start: opening quotes or brackets, then a capital letter or a digit. */
const START = /[„“"»«‚‘'(\[]*[\p{Lu}\p{N}]/uy
/**
 * The word (letters and digits, internal apostrophes kept) ending right before the terminal
 * run. Keeping the apostrophe is what stops a possessive or elision from passing for a single
 * letter: "grandmother’s." and "mir's." end sentences, "S." and "z. B." do not.
 */
const WORD_BEFORE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*$/u

function matchAt(re: RegExp, text: string, at: number): string {
  re.lastIndex = at
  const m = re.exec(text)
  return m === null ? '' : m[0]
}

function startsSentence(text: string, at: number): boolean {
  START.lastIndex = at
  return START.test(text)
}

/**
 * True when the period at `periodAt` ends an abbreviation rather than a sentence, judged by
 * the word before it and, for number abbreviations, by what follows at `nextAt`.
 */
export function isAbbreviation(text: string, periodAt: number, nextAt: number, lang: Lang): boolean {
  const word = WORD_BEFORE.exec(text.slice(0, periodAt))?.[0]
  if (word === undefined) return false
  const lower = word.toLowerCase()
  // Initials and spaced abbreviations: "N. N.", "z. B.", "d. h.", "S. 12". The English pronoun
  // "I" is the one single letter that commonly ends a sentence ("said I. She laughed.").
  if (word.length === 1 && /\p{L}/u.test(word)) return !(lang === 'en' && word === 'I')
  // German ordinals: "am 4. Mai", "im 18. Jahrhundert", "der 2. Stock". Years are longer.
  if (lang === 'de' && /^\d{1,2}$/.test(word)) return true
  if (ABBREVIATIONS[lang].has(lower)) return true
  if (NUMBER_ABBREVIATIONS[lang].has(lower)) {
    START.lastIndex = nextAt
    const m = START.exec(text)
    return m !== null && /\p{N}$/u.test(m[0])
  }
  return false
}

/**
 * Split one paragraph into sentences with their character offsets. Separators (whitespace,
 * dash runs) between sentences belong to no sentence; a trailing separator is dropped. Text
 * without any terminal mark (a heading-like line, a fragment) is one sentence. Returns an
 * empty list for blank text.
 */
export function splitSentences(text: string, lang: Lang): Sentence[] {
  const sentences: Sentence[] = []
  const push = (from: number, to: number): void => {
    while (to > from && /\s/u.test(text[to - 1])) to--
    if (to > from) sentences.push({ text: text.slice(from, to), charStart: from, charEnd: to })
  }

  let start = 0
  while (start < text.length && /\s/u.test(text[start])) start++

  const re = new RegExp(TERMINAL_RUN.source, TERMINAL_RUN.flags)
  re.lastIndex = start
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const runStart = m.index
    let end = runStart + m[0].length
    const closers = matchAt(CLOSERS, text, end)
    end += closers.length
    const separator = matchAt(SEPARATOR, text, end)
    const next = end + separator.length
    if (next >= text.length) {
      // End of paragraph: the sentence ends at the closers; trailing separators are dropped.
      push(start, end)
      start = text.length
      break
    }
    if (separator.length === 0) continue // "3.000", "1.5", "e.g", "www.x.de"
    if (!startsSentence(text, next)) continue // lowercase continuation: dialogue tail, "… vielleicht"
    if (m[0] === '.' && closers === '' && isAbbreviation(text, runStart, next, lang)) continue
    push(start, end)
    start = next
    re.lastIndex = next
  }
  if (start < text.length) push(start, text.length)
  return sentences
}

/**
 * Split every paragraph and number the sentences consecutively across the list, keeping each
 * one's `Paragraph.idx` and its offsets within that paragraph's text.
 */
export function splitParagraphs(paragraphs: readonly Paragraph[], lang: Lang): ParagraphSentence[] {
  const out: ParagraphSentence[] = []
  for (const p of paragraphs) {
    for (const s of splitSentences(p.text, lang)) out.push({ ...s, idx: out.length, paraIdx: p.idx })
  }
  return out
}
