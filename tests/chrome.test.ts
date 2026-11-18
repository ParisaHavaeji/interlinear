// The Books chrome's arithmetic (plan.md step 17): hide on scroll down, show on scroll up, pages left.
import { describe, expect, it } from 'vitest'
import { chromeAfterScroll, pagesLeftInChapter, readingPosition, SHOWN } from '../src/reader/chrome.ts'

describe('chromeAfterScroll', () => {
  const scroll = (ys: number[]) => ys.reduce((s, y) => chromeAfterScroll(s, y), SHOWN)

  it('hides after scrolling down past the threshold and shows again after scrolling up past it', () => {
    expect(scroll([10, 40]).hidden).toBe(false)
    expect(scroll([10, 40, 60]).hidden).toBe(false)
    expect(scroll([10, 40, 70]).hidden).toBe(true)
    expect(scroll([10, 40, 70, 300]).hidden).toBe(true)
    expect(scroll([10, 40, 70, 300, 290]).hidden).toBe(true)
    expect(scroll([10, 40, 70, 300, 260]).hidden).toBe(false)
  })

  it('ignores jitter and anchors on the furthest point in the current direction', () => {
    const hidden = scroll([100, 200])
    expect(hidden).toEqual({ hidden: true, anchor: 200 })
    expect(chromeAfterScroll(hidden, 190)).toBe(hidden)
    expect(chromeAfterScroll(hidden, 260)).toEqual({ hidden: true, anchor: 260 })
    const shown = chromeAfterScroll(hidden, 150)
    expect(shown).toEqual({ hidden: false, anchor: 150 })
    expect(chromeAfterScroll(shown, 160)).toBe(shown)
    expect(chromeAfterScroll(shown, 140)).toEqual({ hidden: false, anchor: 140 })
  })

  it('always shows near the top', () => {
    expect(chromeAfterScroll({ hidden: true, anchor: 500 }, 30)).toEqual({ hidden: false, anchor: 30 })
    expect(chromeAfterScroll(SHOWN, 0)).toBe(SHOWN)
  })
})

describe('readingPosition', () => {
  it('counts the screens below the viewport and the share scrolled', () => {
    expect(readingPosition(0, 3000, 800)).toEqual({ fraction: 0, pagesLeft: 3, page: 1, pages: 4 })
    expect(readingPosition(1100, 3000, 800)).toEqual({ fraction: 0.5, pagesLeft: 2, page: 2, pages: 4 })
    expect(readingPosition(2200, 3000, 800)).toEqual({ fraction: 1, pagesLeft: 0, page: 4, pages: 4 })
    expect(readingPosition(2100, 3000, 800).pagesLeft).toBe(1)
  })

  it('treats a page that fits the viewport as finished', () => {
    expect(readingPosition(0, 500, 800)).toEqual({ fraction: 1, pagesLeft: 0, page: 1, pages: 1 })
    expect(readingPosition(-20, 3000, 800)).toEqual({ fraction: 0, pagesLeft: 3, page: 1, pages: 4 })
    expect(readingPosition(9999, 3000, 800)).toEqual({ fraction: 1, pagesLeft: 0, page: 4, pages: 4 })
  })

  it('numbers the pages without skipping or repeating as the book scrolls', () => {
    let last = 1
    for (let y = 0; y <= 2200; y += 50) {
      const { page } = readingPosition(y, 3000, 800)
      expect(page === last || page === last + 1).toBe(true)
      last = page
    }
    expect(last).toBe(4)
  })
})

describe('pagesLeftInChapter', () => {
  it('counts the screens until the chapter end is on screen', () => {
    expect(pagesLeftInChapter(3000, 0, 800)).toBe(3)
    expect(pagesLeftInChapter(3000, 1400, 800)).toBe(1)
    expect(pagesLeftInChapter(3000, 2200, 800)).toBe(0)
    expect(pagesLeftInChapter(3000, 2900, 800)).toBe(0)
  })
})
