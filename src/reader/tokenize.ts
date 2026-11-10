/**
 * Reader tokenisation (plan.md step 16): how a paragraph of stored text becomes the nested
 * sentence → word spans the reader taps on.
 *
 * Two pure functions, both lossless (concatenating their output gives the input back, so the
 * page shows exactly the imported text):
 *
 * - {@link runsOf} cuts a paragraph into *runs* along the sentence boundaries the splitter of
 *   step 8 stored (`charStart`/`charEnd` per sentence). A run is either one sentence or the
 *   separator text between two sentences (whitespace, a dash run), which belongs to neither
 *   and so gets no sentence span.
 * - {@link tokenize} cuts a run into *tokens*: words and everything else. A word is a run of
 *   letters, marks and digits, with apostrophes and hyphens allowed inside (`geht's`, `don't`,
 *   `Schwarz-Weiß`, `1.000` is two words around a period). Punctuation, quotes, dashes and
 *   whitespace are kept as they are; the reader renders them as plain text between word spans.
 */

export interface Token {
  text: string
  /** True for a word (gets a `<span>`), false for punctuation and whitespace (plain text). */
  word: boolean
}

/** Letters, combining marks and digits; apostrophes and hyphens only between two such runs. */
const WORD = /[\p{L}\p{M}\p{N}]+(?:[’'-][\p{L}\p{M}\p{N}]+)*/gu

/** Split text into word and non-word tokens; `tokens.map(t => t.text).join('') === text`. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let last = 0
  for (const m of text.matchAll(WORD)) {
    const start = m.index
    if (start > last) tokens.push({ text: text.slice(last, start), word: false })
    tokens.push({ text: m[0], word: true })
    last = start + m[0].length
  }
  if (last < text.length) tokens.push({ text: text.slice(last), word: false })
  return tokens
}

/** The slice of a sentence row the reader needs to place it in its paragraph. */
export interface SentenceSpan {
  /** Book-wide sentence index (`SentenceRow.idx`); what a tap reports. */
  idx: number
  charStart: number
  charEnd: number
}

export interface Run {
  text: string
  /** The sentence this run is, or null for separator text between sentences. */
  sentenceIdx: number | null
}

/**
 * Cut a paragraph into sentence runs and the separators between them, in reading order.
 * Sentences may come in any order; ranges are clamped to the text and to each other, so a
 * stale or overlapping row can never drop or duplicate characters. Empty runs are left out.
 */
export function runsOf(text: string, sentences: readonly SentenceSpan[]): Run[] {
  const sorted = [...sentences].sort((a, b) => a.charStart - b.charStart || a.idx - b.idx)
  const runs: Run[] = []
  let pos = 0
  for (const s of sorted) {
    const start = Math.min(Math.max(s.charStart, pos), text.length)
    const end = Math.min(Math.max(s.charEnd, start), text.length)
    if (start > pos) runs.push({ text: text.slice(pos, start), sentenceIdx: null })
    if (end > start) runs.push({ text: text.slice(start, end), sentenceIdx: s.idx })
    pos = end
  }
  if (pos < text.length) runs.push({ text: text.slice(pos), sentenceIdx: null })
  return runs
}
