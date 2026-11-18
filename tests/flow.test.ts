// The whole book as one page (reader/flow.ts): chapters laid end to end, and back again.
import { describe, expect, it } from 'vitest'
import type { ChapterMeta } from '../src/align/pipeline.ts'
import { chapterAt, flowOf, flowPosition } from '../src/reader/flow.ts'

const chapter = (idx: number, paraStart: number, paraCount: number): ChapterMeta => ({ idx, heading: null, sectionIdx: null, paraStart, paraCount, words: 0 })

describe('flowOf', () => {
  const paragraphs = ['front', 'a1', 'a2', 'skipped', 'b1', 'b2', 'b3', 'back']
  const chapters = [chapter(0, 1, 2), chapter(1, 4, 3)]

  it('lays the chapters end to end and leaves out what is in none', () => {
    const flow = flowOf(paragraphs, chapters)
    expect(flow.rows).toEqual(['a1', 'a2', 'b1', 'b2', 'b3'])
    expect(flow.starts).toEqual([0, 2])
  })

  it('finds the chapter of a position, and the position of a place in a chapter', () => {
    const { starts } = flowOf(paragraphs, chapters)
    expect([0, 1, 2, 3, 4].map((pos) => chapterAt(starts, pos))).toEqual([0, 0, 1, 1, 1])
    expect(flowPosition(starts, 1, 2)).toBe(4)
    expect(flowPosition(starts, 9, 0)).toBe(2)
    expect(flowPosition([], 0, 3)).toBe(0)
  })

  it('gives a position shared with an empty chapter to the chapter that has the paragraph', () => {
    const { starts } = flowOf(paragraphs, [chapter(0, 1, 2), chapter(1, 3, 0), chapter(2, 4, 3)])
    expect(starts).toEqual([0, 2, 2])
    expect(chapterAt(starts, 2)).toBe(2)
    expect(chapterAt(starts, 1)).toBe(0)
  })
})
