// Project Gutenberg plain-text handling for the alignment fixtures (plan.md step 6).
// Pure functions only, so they can be unit-tested; the download CLI is fetch-fixtures.ts.

/** One Gutenberg e-text that contributes to a fixture file. */
export interface GutenbergPart {
  /** Gutenberg e-book number, e.g. 22367. */
  id: number
  /** Drop everything before the first line (trimmed) matching this, e.g. a chapter heading. */
  startAt: RegExp
}

/** A fixture file assembled from one or more Gutenberg e-texts. */
export interface Fixture {
  /** File name under tests/fixtures/. */
  file: string
  title: string
  lang: 'de' | 'en'
  parts: GutenbergPart[]
}

/**
 * The two test pairs from plan.md §1.1. The German Werther is published by Gutenberg as two
 * volumes, so that fixture concatenates them. Boylan's English Werther keeps its short PREFACE,
 * which this German edition lacks: a real front-matter mismatch for the aligner to cope with.
 */
export const FIXTURES: readonly Fixture[] = [
  {
    file: 'kafka-verwandlung.de.txt',
    title: 'Die Verwandlung (Kafka)',
    lang: 'de',
    parts: [{ id: 22367, startAt: /^I\.$/ }],
  },
  {
    file: 'kafka-verwandlung.en.txt',
    title: 'Metamorphosis (Kafka, tr. David Wyllie)',
    lang: 'en',
    parts: [{ id: 5200, startAt: /^I$/ }],
  },
  {
    file: 'goethe-werther.de.txt',
    title: 'Die Leiden des jungen Werther (Goethe)',
    lang: 'de',
    parts: [
      { id: 2407, startAt: /^Erstes Buch$/ },
      { id: 2408, startAt: /^Zweites Buch$/ },
    ],
  },
  {
    file: 'goethe-werther.en.txt',
    title: 'The Sorrows of Young Werther (Goethe, tr. R. D. Boylan)',
    lang: 'en',
    parts: [{ id: 2527, startAt: /^PREFACE$/ }],
  },
]

/** The UTF-8 plain-text download for an e-book number. */
export function gutenbergUrl(id: number): string {
  return `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`
}

const START_MARKER = /^\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG/i
const END_MARKER = /^\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i
/** Transcriber credits that some e-texts repeat just after the START marker. */
const LEADING_CREDITS = /^(Produced by|E-?text prepared by|This e-?text was prepared|Transcribed (from|by))/i
/** Closing notes such as "Ende dieses Projekt Gutenberg Etextes …" before the END marker. */
const TRAILING_NOTE = /Proje[ck]t Gutenberg/i

const isBlank = (line: string) => line.trim() === ''

/**
 * Reduce a Gutenberg e-text to the work itself.
 *
 * Keeps only the lines between the START and END markers, drops any transcriber credit
 * paragraph at the top and any "end of this Project Gutenberg e-text" note at the bottom and,
 * when `startAt` is given, everything before the first line matching it (title page, publisher
 * and edition lines). Line endings become LF, a BOM is removed, trailing whitespace is trimmed
 * from each line and the result ends in exactly one newline. Blank-line runs inside the body
 * are kept as they are, since extra blank lines before headings are a signal the importer may
 * use.
 */
export function stripGutenberg(raw: string, opts: { startAt?: RegExp } = {}): string {
  const text = raw.startsWith('﻿') ? raw.slice(1) : raw
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd())

  const start = lines.findIndex((l) => START_MARKER.test(l))
  const end = lines.findIndex((l) => END_MARKER.test(l))
  if (start < 0) throw new Error('no "*** START OF … PROJECT GUTENBERG" marker found')
  if (end < 0) throw new Error('no "*** END OF … PROJECT GUTENBERG" marker found')
  if (end <= start) throw new Error('END marker precedes START marker')
  let body = lines.slice(start + 1, end)

  const startAt = opts.startAt
  if (startAt) {
    const i = body.findIndex((l) => startAt.test(l.trim()))
    if (i < 0) throw new Error(`startAt ${startAt} matched no line`)
    body = body.slice(i)
  } else {
    body = dropLeadingParagraphsWhile(body, (p) => LEADING_CREDITS.test(p))
  }
  body = dropTrailingParagraphsWhile(body, (p) => TRAILING_NOTE.test(p))

  while (body.length && isBlank(body[0]!)) body.shift()
  while (body.length && isBlank(body[body.length - 1]!)) body.pop()
  if (body.length === 0) throw new Error('nothing left after stripping')
  return body.join('\n') + '\n'
}

/** Remove leading paragraphs (blank-line delimited) for as long as `drop` accepts them. */
function dropLeadingParagraphsWhile(lines: string[], drop: (para: string) => boolean): string[] {
  let i = 0
  for (;;) {
    while (i < lines.length && isBlank(lines[i]!)) i++
    if (i >= lines.length) break
    let j = i
    while (j < lines.length && !isBlank(lines[j]!)) j++
    if (!drop(lines.slice(i, j).join(' '))) break
    i = j
  }
  return lines.slice(i)
}

/** Remove trailing paragraphs (blank-line delimited) for as long as `drop` accepts them. */
function dropTrailingParagraphsWhile(lines: string[], drop: (para: string) => boolean): string[] {
  let end = lines.length
  for (;;) {
    while (end > 0 && isBlank(lines[end - 1]!)) end--
    if (end === 0) break
    let i = end
    while (i > 0 && !isBlank(lines[i - 1]!)) i--
    if (!drop(lines.slice(i, end).join(' '))) break
    end = i
  }
  return lines.slice(0, end)
}

/** Join the stripped parts of a multi-volume fixture, separated by a blank-line gap. */
export function joinParts(parts: string[]): string {
  return parts.map((p) => p.trimEnd()).join('\n\n\n') + '\n'
}
