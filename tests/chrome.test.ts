// The Books chrome's arithmetic (plan.md step 17): hide on scroll down, show on scroll up, pages left.
import { describe, expect, it } from 'vitest'
import { chromeAfterScroll, pagesLeftLabel, readingPosition, SHOWN } from '../src/reader/chrome.ts'

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
    expect(readingPosition(0, 3000, 800)).toEqual({ fraction: 0, pagesLeft: 3 })
    expect(readingPosition(1100, 3000, 800)).toEqual({ fraction: 0.5, pagesLeft: 2 })
    expect(readingPosition(2200, 3000, 800)).toEqual({ fraction: 1, pagesLeft: 0 })
    expect(readingPosition(2100, 3000, 800).pagesLeft).toBe(1)
  })

  it('treats a page that fits the viewport as finished', () => {
    expect(readingPosition(0, 500, 800)).toEqual({ fraction: 1, pagesLeft: 0 })
    expect(readingPosition(-20, 3000, 800)).toEqual({ fraction: 0, pagesLeft: 3 })
    expect(readingPosition(9999, 3000, 800)).toEqual({ fraction: 1, pagesLeft: 0 })
  })

  it('words the footer', () => {
    expect(pagesLeftLabel(0)).toBe('Last page in this chapter')
    expect(pagesLeftLabel(1)).toBe('1 page left in this chapter')
    expect(pagesLeftLabel(12)).toBe('12 pages left in this chapter')
  })
})
