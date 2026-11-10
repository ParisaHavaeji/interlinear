import { describe, expect, it } from 'vitest'
import { estimateHeight, HeightMap, rangeFor, sameRange } from '../src/reader/virtual.ts'

const metrics = { charsPerLine: 40, lineHeight: 28, spacing: 0 }

describe('estimateHeight', () => {
  it('rounds the line count up and never goes below one line', () => {
    expect(estimateHeight(0, metrics)).toBe(28)
    expect(estimateHeight(40, metrics)).toBe(28)
    expect(estimateHeight(41, metrics)).toBe(56)
    expect(estimateHeight(100, { ...metrics, spacing: 12 })).toBe(3 * 28 + 12)
  })
})

describe('HeightMap', () => {
  it('sums estimates into offsets and finds the item at a distance', () => {
    const map = new HeightMap([10, 20, 30])
    expect(map.length).toBe(3)
    expect(map.total()).toBe(60)
    expect([0, 1, 2, 3].map((i) => map.offsetOf(i))).toEqual([0, 10, 30, 60])
    expect(map.indexAt(-5)).toBe(0)
    expect(map.indexAt(0)).toBe(0)
    expect(map.indexAt(9.9)).toBe(0)
    expect(map.indexAt(10)).toBe(1)
    expect(map.indexAt(29)).toBe(1)
    expect(map.indexAt(30)).toBe(2)
    expect(map.indexAt(59)).toBe(2)
    expect(map.indexAt(60)).toBe(2)
    expect(map.indexAt(1000)).toBe(2)
  })

  it('replaces an estimate with a measurement and reports the change', () => {
    const map = new HeightMap([10, 20, 30])
    expect(map.isMeasured(1)).toBe(false)
    expect(map.set(1, 25)).toBe(5)
    expect(map.isMeasured(1)).toBe(true)
    expect(map.heightOf(1)).toBe(25)
    expect(map.offsetOf(2)).toBe(35)
    expect(map.total()).toBe(65)
    expect(map.set(1, 25)).toBe(0)
    expect(map.set(0, 4)).toBe(-6)
    expect([0, 1, 2, 3].map((i) => map.offsetOf(i))).toEqual([0, 4, 29, 59])
  })

  it('forgets measurements on reset', () => {
    const map = new HeightMap([10, 20])
    map.set(0, 50)
    map.reset([1, 2, 3])
    expect(map.length).toBe(3)
    expect(map.isMeasured(0)).toBe(false)
    expect(map.total()).toBe(6)
  })

  it('copes with an empty list', () => {
    const map = new HeightMap([])
    expect(map.total()).toBe(0)
    expect(map.indexAt(10)).toBe(0)
    expect(rangeFor(map, 0, 800, 800)).toEqual({ start: 0, end: 0, top: 0, bottom: 0 })
  })
})

describe('rangeFor', () => {
  // 100 paragraphs of 50px: 5000px in all.
  const map = new HeightMap(new Array(100).fill(50))

  it('renders the viewport plus the overscan on both sides', () => {
    // Scrolled 1000px into the list, 500px viewport, 500px overscan: 500..2000 → items 10..39.
    const r = rangeFor(map, 1000, 500, 500)
    expect(r).toEqual({ start: 10, end: 40, top: 500, bottom: 5000 - 2000 })
  })

  it('starts at the first item while the list top is still below the viewport', () => {
    const r = rangeFor(map, -300, 500, 0)
    // Visible list part: 0..200 → items 0..3.
    expect(r.start).toBe(0)
    expect(r.end).toBe(4)
    expect(r.top).toBe(0)
  })

  it('clamps at the end of the list', () => {
    const r = rangeFor(map, 4900, 500, 500)
    expect(r).toEqual({ start: 88, end: 100, top: 4400, bottom: 0 })
    const past = rangeFor(map, 9000, 500, 0)
    expect(past.start).toBe(99)
    expect(past.end).toBe(100)
  })

  it('covers every item between the window edges, so nothing scrolls into a gap', () => {
    for (let scroll = -600; scroll < 5600; scroll += 37) {
      const r = rangeFor(map, scroll, 700, 350)
      expect(r.start).toBeLessThanOrEqual(r.end)
      expect(r.end - r.start).toBeGreaterThan(0)
      // Every pixel of the window lies in a rendered item or outside the list.
      for (const y of [scroll - 350, scroll + 350, scroll + 1049]) {
        if (y < 0 || y >= map.total()) continue
        const i = map.indexAt(y)
        expect(i).toBeGreaterThanOrEqual(r.start)
        expect(i).toBeLessThan(r.end)
      }
      expect(r.top + r.bottom + (r.end - r.start) * 50).toBe(5000)
    }
  })
})

describe('sameRange', () => {
  it('compares all four fields', () => {
    const a = { start: 1, end: 5, top: 50, bottom: 200 }
    expect(sameRange(a, { ...a })).toBe(true)
    expect(sameRange(a, { ...a, bottom: 201 })).toBe(false)
    expect(sameRange(a, { ...a, start: 2 })).toBe(false)
  })
})
