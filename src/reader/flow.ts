/**
 * The whole book as one scrolling page: the paragraphs of every chapter, in reading order, as
 * the Reader's windowed body lists them, and the arithmetic between a position in that list and
 * a chapter with a paragraph in it (which is how bookmarks and the reading place are stored).
 * Paragraphs outside the chapters (excluded front and back matter) are not part of the flow.
 * DOM-free so it can be tested.
 */

import type { ChapterMeta } from '../align/pipeline.ts'

export interface Flow<T> {
  /** Every chapter's paragraphs, one chapter after the other. */
  rows: T[]
  /** `starts[i]` is the position in `rows` of chapter i's first paragraph; an empty chapter shares the next one's. */
  starts: number[]
}

/** The flow of `chapters` over the book's `paragraphs` (by position in the book). */
export function flowOf<T>(paragraphs: readonly T[], chapters: readonly ChapterMeta[]): Flow<T> {
  const rows: T[] = []
  const starts: number[] = []
  for (const c of chapters) {
    starts.push(rows.length)
    for (let p = c.paraStart; p < c.paraStart + c.paraCount; p++) {
      const row = paragraphs[p]
      if (row !== undefined) rows.push(row)
    }
  }
  return { rows, starts }
}

/** The chapter the paragraph at `pos` of the flow is in: the last one that starts at or before it. */
export function chapterAt(starts: readonly number[], pos: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= pos) lo = mid
    else hi = mid - 1
  }
  return Math.max(0, lo)
}

/** The position in the flow of paragraph `para` of `chapter`, clamped to the chapters there are. */
export function flowPosition(starts: readonly number[], chapter: number, para: number): number {
  if (starts.length === 0) return 0
  const c = Math.min(Math.max(0, chapter), starts.length - 1)
  return starts[c] + Math.max(0, para)
}
