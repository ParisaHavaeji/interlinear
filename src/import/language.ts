/**
 * Which language a picked file is in (plan.md step 33, mismatched books), kept apart from the
 * DOM so it can be tested. The Add Book sheet asks before saving, so two files picked into the
 * wrong slots are caught at import rather than read as a book whose "German" is English.
 *
 * An EPUB usually says in its package metadata (`dc:language`); plain text and an EPUB that
 * does not are judged by their function words: a tally of the commonest German and English
 * words over the first pages. A text neither set clearly wins is left undecided, and the sheet
 * says nothing: a wrong warning would be worse than none.
 */
import type { Lang } from './types.ts'

/** What the guess reads of an imported text: its paragraphs and the package language, if any. */
export interface LanguageSample {
  paragraphs: readonly { text: string }[]
  meta: { language: string | null } | null
}

/** Function words that occur in almost any page of the language and hardly ever in the other. */
const GERMAN = new Set(['der', 'die', 'das', 'und', 'nicht', 'ich', 'ist', 'zu', 'ein', 'eine', 'sich', 'mit', 'auf', 'es', 'dem', 'den', 'sie', 'war', 'er', 'von', 'auch', 'wie', 'aber', 'für', 'als', 'noch', 'mir', 'mich', 'wir', 'nur'])
const ENGLISH = new Set(['the', 'and', 'of', 'to', 'a', 'in', 'is', 'that', 'it', 'was', 'he', 'for', 'as', 'with', 'his', 'on', 'be', 'at', 'by', 'had', 'not', 'but', 'you', 'this', 'her', 'she', 'they', 'from', 'have', 'which'])

/** How much of a text the tally reads: enough pages to be sure, not the whole book. */
const SAMPLE_CHARS = 20_000
/** The winning language needs this many hits, and twice the other's, to count. */
const MIN_HITS = 20

/** The language a package code names, when it is one of ours: "de", "de-DE", "en-us". */
export function languageFromCode(code: string | null | undefined): Lang | null {
  if (code === null || code === undefined) return null
  const primary = code.trim().toLowerCase().split(/[-_]/)[0]
  return primary === 'de' || primary === 'en' ? primary : null
}

/** The language the function words of the first pages point to, or null when neither clearly wins. */
export function languageFromText(paragraphs: readonly { text: string }[]): Lang | null {
  let read = 0
  let de = 0
  let en = 0
  for (const p of paragraphs) {
    if (read >= SAMPLE_CHARS) break
    read += p.text.length
    for (const word of p.text.toLowerCase().split(/[^\p{L}]+/u)) {
      if (GERMAN.has(word)) de++
      else if (ENGLISH.has(word)) en++
    }
  }
  if (de >= MIN_HITS && de >= 2 * en) return 'de'
  if (en >= MIN_HITS && en >= 2 * de) return 'en'
  return null
}

/** The language of an imported text: what its package says when that is German or English, else what its words say. */
export function guessLanguage(sample: LanguageSample): Lang | null {
  return languageFromCode(sample.meta?.language) ?? languageFromText(sample.paragraphs)
}

/**
 * What is wrong with the two picks, if anything: `swapped` when each file is in the other's
 * slot, or the slot whose file is in the other language while its partner is not; null when the
 * picks agree with their slots or nothing can be told.
 */
export type LanguageMismatch = 'swapped' | Lang

export function languageMismatch(de: Lang | null, en: Lang | null): LanguageMismatch | null {
  if (de === 'en' && en === 'de') return 'swapped'
  if (de === 'en') return 'de'
  if (en === 'de') return 'en'
  return null
}
