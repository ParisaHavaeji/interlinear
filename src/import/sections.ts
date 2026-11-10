/**
 * Per-section heuristics (plan §1.1b): which leading paragraphs are a heading, and whether a
 * spine item is front matter, body text or back matter.
 *
 * Step 5 scope: class-name hints, the heading heuristic, keyword and length rules, and a
 * position pass that turns "matter" into front/back. Step 5b adds the book-relative
 * proper-noun density rule and the cross-edition chapter-mapping DP.
 */

import type { Block } from './markup.ts'
import type { Paragraph, Section, SectionKind } from './types.ts'

/** Longest paragraph that can still be a heading line. */
const MAX_HEADING_CHARS = 60
/** At most this many leading short paragraphs form the heading ("CHAPTER ONE" + "TWO WORLDS"). */
const MAX_HEADING_LINES = 3
/** Sections with fewer words and no other signal are treated as matter (title pages, epigraphs). */
const MIN_BODY_WORDS = 200
/** Copyright boilerplate is only looked for in sections shorter than this. */
const MAX_COPYRIGHT_SCAN_WORDS = 1500

/** Terminal punctuation that marks prose rather than a heading. */
const PROSE_END = /[.!?…;,]["”“’'»«]?$/
/** Opening quotation marks: a paragraph that starts with dialogue is prose. */
const QUOTE_START = /^[„“"»«‚‘']/
/** Explicit chapter-style labels, accepted even with a trailing period ("Kapitel 1.", "II."). */
const CHAPTER_LABEL =
  /^(?:(?:chapter|kapitel|part|teil|book|buch|abschnitt|section)\s+[\w.]+|[ivxlcdm]+\.?|\d{1,3}\.?|(?:erstes|zweites|drittes|viertes|fünftes|sechstes|siebtes|siebentes|achtes|neuntes|zehntes|elftes|zwölftes)\s+(?:kapitel|buch))$/i

/** True when a paragraph reads like a heading line rather than prose. */
export function isHeadingLine(text: string): boolean {
  if (CHAPTER_LABEL.test(text)) return true
  if (text.length > MAX_HEADING_CHARS) return false
  if (PROSE_END.test(text)) return false
  if (QUOTE_START.test(text)) return false
  return true
}

/**
 * Split the leading heading lines off a section's blocks. Takes up to three leading blocks
 * that look like headings, but always leaves at least one block behind, so a page of short
 * lines (an epigraph) is not swallowed whole.
 */
export function splitHeading(blocks: Block[]): { heading: string | null; body: Block[] } {
  let n = 0
  while (n < blocks.length - 1 && n < MAX_HEADING_LINES && isHeadingLine(blocks[n].text)) n++
  if (n === 0) return { heading: null, body: blocks }
  return { heading: blocks.slice(0, n).map((b) => b.text).join(': '), body: blocks.slice(n) }
}

/** Class-name hints found in publisher EPUBs (InDesign exports and the like). */
const FRONT_CLASS = /(?:^|[-_\s])fm(?:[-_\s]|$)|front/i
const BACK_CLASS = /(?:^|[-_\s])bm(?:[-_\s]|$)|back/i
const BODY_CLASS = /chapter|body/i

/** Section titles / headings that mark front or back matter in either language. */
const MATTER_TITLE =
  /^(?:(?:table of )?contents|inhalt(?:sverzeichnis)?|copyright|impressum|foreword|introduction|vorwort|einleitung|nachwort|afterword|acknowledg\w*|danksagung(?:en)?|about the (?:author|translator)|über den autor|(?:suggestions for )?further reading|bibliograph\w*|literatur(?:verzeichnis|hinweise)?|(?:end)?notes|anmerkungen|glossary|glossar|index|dedication|widmung|epigraph|motto|also by\b.*|praise for\b.*|title page|titelseite|cover|colophon|appendix|anhang|translator['’]?s? note|a note on the (?:text|translation|type)|chronolog(?:y|ie)|zeittafel)\b/i

const COPYRIGHT = /copyright|©|isbn|all rights reserved|alle rechte vorbehalten/i

/** Count whitespace-separated tokens. */
export function countWords(paragraphs: readonly { text: string }[]): number {
  let n = 0
  for (const p of paragraphs) n += p.text.split(' ').length
  return n
}

/**
 * Decide whether one spine item is body text or (front/back) matter, from its own content.
 * Signals, in order: class-name hints on the leading blocks, matter keywords in the heading,
 * nav title or a short first paragraph, copyright boilerplate in short sections, and length.
 */
export function isBodySection(
  heading: string | null,
  navTitle: string | null,
  blocks: readonly Block[],
  paragraphs: readonly Paragraph[],
  words: number,
): boolean {
  if (paragraphs.length === 0) return false

  for (const b of blocks.slice(0, MAX_HEADING_LINES + 1)) {
    if (b.cls === '') continue
    if (FRONT_CLASS.test(b.cls) || BACK_CLASS.test(b.cls)) return false
    if (BODY_CLASS.test(b.cls)) return true
  }

  const first = paragraphs[0].text
  const candidates = [heading, navTitle, first.length <= 80 ? first : null]
  if (candidates.some((c) => c !== null && MATTER_TITLE.test(c))) return false

  if (words < MAX_COPYRIGHT_SCAN_WORDS && paragraphs.some((p) => COPYRIGHT.test(p.text))) return false

  return words >= MIN_BODY_WORDS
}

/**
 * Turn per-section body/matter verdicts into kinds: matter before the first body section is
 * front matter, matter after the last one is back matter. Matter between body sections
 * (part-title pages) is labelled front so it is excluded like the rest; the chapter list
 * still shows it. A book with no body section at all is all front matter.
 */
export function assignKinds(sections: Section[], isBody: readonly boolean[]): void {
  const lastBody = isBody.lastIndexOf(true)
  for (let i = 0; i < sections.length; i++) {
    let kind: SectionKind
    if (isBody[i]) kind = 'body'
    else if (lastBody >= 0 && i > lastBody) kind = 'back'
    else kind = 'front'
    sections[i].kind = kind
  }
}
