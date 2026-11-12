// No rubber-band on the chrome (plan.md step 31): which pans the guard cancels.
import { describe, expect, it } from 'vitest'
import { blocksPan, canScrollBy, isVerticalPan, type Scroller } from '../src/pwa/overscroll.ts'

const page = (scrollTop: number, scrollHeight = 3000, clientHeight = 800): Scroller => ({
  metrics: { scrollTop, scrollHeight, clientHeight },
  chains: false,
})

describe('isVerticalPan', () => {
  it('takes a mostly vertical move and leaves horizontal or still fingers alone', () => {
    expect(isVerticalPan(2, 10)).toBe(true)
    expect(isVerticalPan(-3, -12)).toBe(true)
    expect(isVerticalPan(10, 4)).toBe(false)
    expect(isVerticalPan(0, 0)).toBe(false)
    expect(isVerticalPan(5, 5)).toBe(false)
  })
})

describe('canScrollBy', () => {
  it('pulling down needs room above, pushing up needs room below', () => {
    const top = { scrollTop: 0, scrollHeight: 3000, clientHeight: 800 }
    const middle = { ...top, scrollTop: 1000 }
    const bottom = { ...top, scrollTop: 2200 }
    expect(canScrollBy(top, 10)).toBe(false)
    expect(canScrollBy(top, -10)).toBe(true)
    expect(canScrollBy(middle, 10)).toBe(true)
    expect(canScrollBy(middle, -10)).toBe(true)
    expect(canScrollBy(bottom, -10)).toBe(false)
    expect(canScrollBy(bottom, 10)).toBe(true)
  })

  it('forgives fractional positions at the ends', () => {
    expect(canScrollBy({ scrollTop: 0.3, scrollHeight: 3000, clientHeight: 800 }, 10)).toBe(false)
    expect(canScrollBy({ scrollTop: 2199.7, scrollHeight: 3000, clientHeight: 800 }, -10)).toBe(false)
  })

  it('a page that fits has nowhere to go', () => {
    const fits = { scrollTop: 0, scrollHeight: 800, clientHeight: 800 }
    expect(canScrollBy(fits, 10)).toBe(false)
    expect(canScrollBy(fits, -10)).toBe(false)
  })
})

describe('blocksPan', () => {
  it('cancels a pull past the top and a push past the bottom of the page', () => {
    expect(blocksPan([page(0)], 12)).toBe(true)
    expect(blocksPan([page(2200)], -12)).toBe(true)
    expect(blocksPan([page(0)], -12)).toBe(false)
    expect(blocksPan([page(1000)], 12)).toBe(false)
  })

  it('lets a card body that can scroll take the pan', () => {
    const body: Scroller = { metrics: { scrollTop: 40, scrollHeight: 900, clientHeight: 300 }, chains: false }
    expect(blocksPan([body, page(0)], 12)).toBe(false)
    expect(blocksPan([body, page(0)], -12)).toBe(false)
  })

  it('cancels at the edge of a contained scroller, whatever the page could do', () => {
    const bodyAtTop: Scroller = { metrics: { scrollTop: 0, scrollHeight: 900, clientHeight: 300 }, chains: false }
    expect(blocksPan([bodyAtTop, page(1000)], 12)).toBe(true)
  })

  it('passes a chaining scroller at its edge on to the page', () => {
    const listAtTop: Scroller = { metrics: { scrollTop: 0, scrollHeight: 900, clientHeight: 300 }, chains: true }
    expect(blocksPan([listAtTop, page(1000)], 12)).toBe(false)
    expect(blocksPan([listAtTop, page(0)], 12)).toBe(true)
  })
})
