// Motion arithmetic for the bottom card (plan.md step 18): spring, rubber band, release velocity, dismissal.
import { describe, expect, it } from 'vitest'
import { dragOffset, rubberBand, shouldDismiss, spring, velocityOf } from '../src/ui/motion.ts'

describe('spring', () => {
  it('starts where it is told, ends exactly on the target, and takes well under a second', () => {
    const track = spring(300, 0, 0)
    expect(track.values[0]).toBe(300)
    expect(track.values[track.values.length - 1]).toBe(0)
    expect(track.duration).toBe((track.values.length - 1) * (1000 / 60))
    expect(track.duration).toBeGreaterThan(200)
    expect(track.duration).toBeLessThan(1000)
  })

  it('approaches without a visible overshoot from rest', () => {
    const { values } = spring(300, 0, 0)
    expect(Math.min(...values)).toBeGreaterThan(-3)
    // Monotone until the (tiny) overshoot: each sample is no higher than the one before.
    for (let i = 1; i < values.length; i++) if (values[i - 1] > 0) expect(values[i]).toBeLessThanOrEqual(values[i - 1])
  })

  it('carries the release velocity: a flick away from the target goes further first', () => {
    const away = spring(100, 0, 1.5)
    expect(away.values[1]).toBeGreaterThan(100)
    expect(away.values[away.values.length - 1]).toBe(0)
    const towards = spring(100, 0, -1.5)
    expect(towards.values[1]).toBeLessThan(away.values[1])
    expect(towards.duration).toBeLessThan(away.duration)
  })

  it('is already at rest when there is nowhere to go', () => {
    expect(spring(0, 0, 0)).toEqual({ values: [0], duration: 0 })
    expect(spring(0.1, 0, 0)).toEqual({ values: [0], duration: 0 })
  })

  it('cuts an unsettled spring to the target at the maximum duration', () => {
    const track = spring(100, 0, 0, { damping: 0, maxDuration: 500 })
    expect(track.duration).toBeLessThanOrEqual(500 + 1e-6)
    expect(track.values[track.values.length - 1]).toBe(0)
  })

  it('samples at the requested step', () => {
    const track = spring(100, 0, 0, { step: 10 })
    expect(track.duration).toBe((track.values.length - 1) * 10)
  })
})

describe('rubber band', () => {
  it('follows downward drags and resists upward ones within the limit', () => {
    expect(dragOffset(0)).toBe(0)
    expect(dragOffset(57)).toBe(57)
    expect(dragOffset(-20)).toBeLessThan(0)
    expect(dragOffset(-20)).toBeGreaterThan(-20)
    expect(dragOffset(-100000)).toBeGreaterThan(-40)
  })

  it('gives ever less the further it is pulled', () => {
    expect(rubberBand(0, 40)).toBe(0)
    const steps = [20, 40, 60, 80, 100, 120].map((d) => rubberBand(d, 40))
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]).toBeGreaterThan(steps[i - 1])
      expect(steps[i] - steps[i - 1]).toBeLessThan(steps[i - 1] - (steps[i - 2] ?? 0))
    }
    expect(rubberBand(1, 40)).toBeCloseTo(0.55, 1)
  })
})

describe('velocityOf', () => {
  it('averages the last 100 ms of the track', () => {
    expect(velocityOf([{ t: 0, y: 0 }, { t: 50, y: 50 }, { t: 100, y: 100 }])).toBe(1)
    expect(velocityOf([{ t: 0, y: -1000 }, { t: 200, y: 0 }, { t: 250, y: 50 }])).toBe(1)
    expect(velocityOf([{ t: 0, y: 0 }, { t: 1000, y: 100 }, { t: 1100, y: 100 }])).toBe(0)
  })

  it('is zero without two samples apart in time', () => {
    expect(velocityOf([])).toBe(0)
    expect(velocityOf([{ t: 5, y: 10 }])).toBe(0)
    expect(velocityOf([{ t: 5, y: 10 }, { t: 5, y: 40 }])).toBe(0)
  })
})

describe('shouldDismiss', () => {
  it('dismisses a slow drag past two fifths of the card, not a shorter one', () => {
    expect(shouldDismiss(130, 0.1, 300)).toBe(true)
    expect(shouldDismiss(90, 0.1, 300)).toBe(false)
    expect(shouldDismiss(0, 0, 300)).toBe(false)
  })

  it('dismisses a flick down from anywhere', () => {
    expect(shouldDismiss(20, 0.8, 300)).toBe(true)
    expect(shouldDismiss(-10, 0.8, 300)).toBe(false)
  })

  it('keeps a card that is being flicked back up, however far down it is', () => {
    expect(shouldDismiss(200, -0.5, 300)).toBe(false)
    expect(shouldDismiss(200, -0.1, 300)).toBe(true)
  })
})
