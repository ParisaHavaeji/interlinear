// The aA menu's model (plan.md step 28): choices, their CSS, and reading a stored choice back.
import { describe, expect, it } from 'vitest'
import {
  appearanceStyle,
  canStepFontSize,
  DEFAULT_APPEARANCE,
  FONT_SIZES,
  FONTS,
  metricsKey,
  nearestFontSize,
  resolveTheme,
  sanitizeAppearance,
  stepFontSize,
  themeAttribute,
} from '../src/reader/appearance.ts'

describe('font sizes', () => {
  it('steps through the allowed sizes and stops at the ends', () => {
    expect(stepFontSize(18, 1)).toBe(19)
    expect(stepFontSize(18, -1)).toBe(17)
    expect(stepFontSize(20, 1)).toBe(22)
    expect(stepFontSize(32, 1)).toBe(32)
    expect(stepFontSize(14, -1)).toBe(14)
    expect(canStepFontSize(14, -1)).toBe(false)
    expect(canStepFontSize(14, 1)).toBe(true)
    expect(canStepFontSize(32, 1)).toBe(false)
    expect(canStepFontSize(32, -1)).toBe(true)
  })

  it('snaps an arbitrary size to the nearest allowed one before stepping', () => {
    expect(nearestFontSize(18.4)).toBe(18)
    expect(nearestFontSize(21)).toBe(20)
    expect(nearestFontSize(23)).toBe(22)
    expect(nearestFontSize(1)).toBe(14)
    expect(nearestFontSize(99)).toBe(32)
    expect(stepFontSize(21, 1)).toBe(22)
    expect(FONT_SIZES).toContain(DEFAULT_APPEARANCE.size)
  })
})

describe('sanitizeAppearance', () => {
  it('falls back to the default for anything missing or unknown', () => {
    expect(sanitizeAppearance(undefined)).toEqual(DEFAULT_APPEARANCE)
    expect(sanitizeAppearance('sepia')).toEqual(DEFAULT_APPEARANCE)
    expect(sanitizeAppearance({ font: 'comic', size: 'big', spacing: 'wide', theme: 'blue' })).toEqual(DEFAULT_APPEARANCE)
    expect(sanitizeAppearance({ size: Number.NaN })).toEqual(DEFAULT_APPEARANCE)
  })

  it('keeps every known choice and snaps the size', () => {
    expect(sanitizeAppearance({ font: 'charter', size: 23, spacing: 'loose', theme: 'sepia' })).toEqual({ font: 'charter', size: 22, spacing: 'loose', theme: 'sepia' })
    expect(sanitizeAppearance({ theme: 'night' })).toEqual({ ...DEFAULT_APPEARANCE, theme: 'night' })
    expect(sanitizeAppearance({ font: 'sanfrancisco' }).font).toBe('sanfrancisco')
  })
})

describe('what the choices mean in CSS', () => {
  it('writes the custom properties the Reader root takes', () => {
    expect(appearanceStyle(DEFAULT_APPEARANCE)).toBe(`--font-serif: ${FONTS[0].stack}; --reader-size: 18px; --reader-leading: 1.55`)
    expect(appearanceStyle({ font: 'georgia', size: 24, spacing: 'tight', theme: 'gray' })).toBe("--font-serif: Georgia, 'Iowan Old Style', serif; --reader-size: 24px; --reader-leading: 1.35")
    expect(appearanceStyle({ ...DEFAULT_APPEARANCE, spacing: 'loose' })).toContain('--reader-leading: 1.8')
  })

  it('names the fonts Books offers, mapped to what iOS ships, every stack ending in a generic family', () => {
    expect(FONTS.map((f) => f.label)).toEqual(['Original', 'Charter', 'Georgia', 'Iowan', 'Palatino', 'San Francisco', 'Times New Roman'])
    for (const f of FONTS) expect(f.stack).toMatch(/(serif|sans-serif)$/)
  })

  it('puts a theme on <html> and leaves Auto to the system', () => {
    expect(themeAttribute('sepia')).toBe('sepia')
    expect(themeAttribute('night')).toBe('night')
    expect(themeAttribute('auto')).toBeNull()
    expect(resolveTheme('auto', true)).toBe('night')
    expect(resolveTheme('auto', false)).toBe('white')
    expect(resolveTheme('gray', true)).toBe('gray')
  })

  it('changes the metrics key for anything that reflows the page, not for the theme', () => {
    const a = DEFAULT_APPEARANCE
    expect(metricsKey({ ...a, theme: 'night' })).toBe(metricsKey(a))
    expect(metricsKey({ ...a, size: 20 })).not.toBe(metricsKey(a))
    expect(metricsKey({ ...a, font: 'times' })).not.toBe(metricsKey(a))
    expect(metricsKey({ ...a, spacing: 'loose' })).not.toBe(metricsKey(a))
  })
})
