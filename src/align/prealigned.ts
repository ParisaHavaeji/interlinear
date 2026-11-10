/**
 * Pre-aligned input (plan §1.2, "Fallbacks", step 14): two plain-text files with one sentence
 * per line and the same number of lines, line *i* of the English translating line *i* of the
 * German. Such files come out of other alignment tools (and out of this app's own bundles, in
 * spirit), so they are accepted as they are and the aligner is skipped: every line is one
 * sentence, every line pair is one 1-1 bead with full confidence.
 *
 * Detection is structural, never guessed from content: both files must have been parsed in the
 * `lines` layout (no blank lines at all, see `parseTxtLayout`) and have equal counts. Two
 * ordinary books never meet both conditions at once, and the Add Book sheet says what it will
 * do before the user confirms.
 *
 * Chapters are still detected on each side from heading lines, for the chapter list of step
 * 17, and paired by the line correspondence itself: chapters whose line ranges overlap belong
 * to one pair. Heading lines keep their bead, since the file says they translate each other.
 */

import type { ImportedText } from '../import/file.ts'
import type { Paragraph } from '../import/types.ts'
import type { Book } from '../store/db.ts'
import type { AlignedBead } from './beads.ts'
import type { AlignResult, ChapterMeta, ChapterPair } from './pipeline.ts'
import type { ParagraphSentence } from './sentences.ts'
import { chaptersFromParagraphs, type Chapter } from './structure.ts'

/** True when two imported texts are pre-aligned: both plain text, one paragraph per line, equal counts. */
export function isPrealignedPair(de: ImportedText, en: ImportedText): boolean {
  return isPrealigned(
    { format: de.format, layout: de.layout, paragraphs: de.paragraphs.length },
    { format: en.format, layout: en.layout, paragraphs: en.paragraphs.length },
  )
}

/** True when a stored book's two sources are pre-aligned input (see {@link isPrealignedPair}). */
export function isPrealignedBook(book: Book): boolean {
  return isPrealigned(book.sources.de, book.sources.en)
}

interface SourceShape {
  format: 'txt' | 'epub'
  layout?: 'blocks' | 'lines'
  paragraphs: number
}

function isPrealigned(de: SourceShape, en: SourceShape): boolean {
  return (
    de.format === 'txt' &&
    en.format === 'txt' &&
    de.layout === 'lines' &&
    en.layout === 'lines' &&
    de.paragraphs > 0 &&
    de.paragraphs === en.paragraphs
  )
}

/** One sentence per paragraph, spanning the whole paragraph text. */
function lineSentences(paragraphs: readonly Paragraph[]): ParagraphSentence[] {
  return paragraphs.map((p, idx) => ({ idx, paraIdx: p.idx, text: p.text, charStart: 0, charEnd: p.text.length }))
}

function meta(c: Chapter): ChapterMeta {
  return { idx: c.idx, heading: c.heading, sectionIdx: c.sectionIdx, paraStart: c.paraStart, paraCount: c.paragraphs.length, words: c.words }
}

/**
 * Pair chapters through the line correspondence: walking both lists in order, chapters whose
 * paragraph ranges overlap on the shared line numbering fall into one pair. A heading that
 * only one edition has merges its chapter into the neighbouring pair rather than leaving a
 * one-sided pair, since every line of it has a translation.
 */
export function pairChaptersByPosition(de: readonly Chapter[], en: readonly Chapter[]): ChapterPair[] {
  const pairs: ChapterPair[] = []
  const end = (c: Chapter) => c.paraStart + c.paragraphs.length
  let i = 0
  let j = 0
  while (i < de.length || j < en.length) {
    const pair: ChapterPair = { de: [], en: [] }
    if (i >= de.length) pair.en.push(en[j++].idx)
    else if (j >= en.length) pair.de.push(de[i++].idx)
    else {
      pair.de.push(de[i].idx)
      pair.en.push(en[j].idx)
      let deEnd = end(de[i++])
      let enEnd = end(en[j++])
      // Extend whichever side ends first while the other side's chapter still covers it.
      while (deEnd !== enEnd) {
        if (deEnd < enEnd) {
          if (i >= de.length) break
          pair.de.push(de[i].idx)
          deEnd = end(de[i++])
        } else {
          if (j >= en.length) break
          pair.en.push(en[j].idx)
          enEnd = end(en[j++])
        }
      }
    }
    pairs.push(pair)
  }
  // A trailing one-sided pair only happens when one side ran out first; fold it into the last
  // two-sided pair so that no chapter stands without a partner.
  for (let k = pairs.length - 1; k > 0; k--) {
    const p = pairs[k]
    if (p.de.length > 0 && p.en.length > 0) continue
    pairs[k - 1].de.push(...p.de)
    pairs[k - 1].en.push(...p.en)
    pairs.splice(k, 1)
  }
  return pairs
}

/**
 * The alignment of a pre-aligned pair: one sentence per line, one 1-1 bead per line pair with
 * confidence 1, the chapters of both sides paired by position. Both lists must have the same
 * length; the result goes straight to `saveAlignment` in `jobs.ts`.
 */
export function prealignedResult(de: readonly Paragraph[], en: readonly Paragraph[]): AlignResult {
  if (de.length !== en.length) throw new Error(`Pre-aligned input needs equal line counts, got ${de.length} and ${en.length}`)
  const t0 = performance.now()
  const sentDe = lineSentences(de)
  const sentEn = lineSentences(en)
  const beads: AlignedBead[] = sentDe.map((s, k) => ({
    deSentenceIdx: [s.idx],
    enSentenceIdx: [sentEn[k].idx],
    cost: 0,
    margin: Infinity,
    confidence: 1,
  }))
  const chaptersDe = chaptersFromParagraphs(de)
  const chaptersEn = chaptersFromParagraphs(en)
  const pairs = pairChaptersByPosition(chaptersDe, chaptersEn)
  return {
    sentences: { de: sentDe, en: sentEn },
    beads,
    chapters: { de: chaptersDe.map(meta), en: chaptersEn.map(meta), pairs },
    lexicon: [],
    stats: {
      sentences: { de: sentDe.length, en: sentEn.length },
      beads: beads.length,
      oneToOne: beads.length,
      uncertain: 0,
      learnedPairs: 0,
      changedBeads: 0,
      pairedChapters: pairs.filter((p) => p.de.length > 0 && p.en.length > 0).length,
      elapsedMs: Math.round(performance.now() - t0),
    },
  }
}
