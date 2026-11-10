import { describe, expect, it } from 'vitest'
import { coverColours, coverGradient, coverStyle, hashString } from '../src/ui/cover.ts'

describe('hashString', () => {
  it('is deterministic and spreads nearby strings apart', () => {
    expect(hashString('Demian')).toBe(hashString('Demian'))
    expect(hashString('Demian')).not.toBe(hashString('Demiam'))
    expect(hashString('')).toBe(0x811c9dc5)
  })
})

describe('coverColours', () => {
  it('gives the same colours for the same title', () => {
    expect(coverColours('Die Verwandlung')).toEqual(coverColours('Die Verwandlung'))
  })

  it('ignores case, surrounding whitespace and diacritics', () => {
    const base = coverColours('Die Leiden des jungen Werther')
    expect(coverColours('  die leiden DES jungen werther ')).toEqual(base)
    expect(coverColours('Die Leiden des jungen Werther'.normalize('NFD'))).toEqual(base)
    expect(coverColours('Über Nacht')).toEqual(coverColours('Uber Nacht'))
  })

  it('keeps both hues in [0, 360)', () => {
    for (const t of ['Demian', 'Der Prozess', 'a', 'Zwei Welten', '1234', 'Ä']) {
      const { hue, hue2 } = coverColours(t)
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
      expect(hue2).toBeGreaterThanOrEqual(0)
      expect(hue2).toBeLessThan(360)
      expect(Number.isInteger(hue)).toBe(true)
      expect(hue2).not.toBe(hue)
    }
  })

  it('gives different titles different hues most of the time', () => {
    const titles = ['Demian', 'Die Verwandlung', 'Der Prozess', 'Werther', 'Siddhartha', 'Steppenwolf', 'Faust', 'Effi Briest']
    const hues = new Set(titles.map((t) => coverColours(t).hue))
    expect(hues.size).toBeGreaterThanOrEqual(titles.length - 1)
  })

  it('falls back to the default warm cover for an empty title', () => {
    expect(coverColours('')).toEqual({ hue: 32, hue2: 14 })
    expect(coverColours('   ')).toEqual({ hue: 32, hue2: 14 })
  })
})

describe('coverGradient / coverStyle', () => {
  it('renders a CSS gradient from the two hues with white text', () => {
    const css = coverGradient({ hue: 200, hue2: 238 })
    expect(css).toMatch(/^linear-gradient\(160deg, hsl\(200 /)
    expect(css).toContain('hsl(238 ')
    expect(coverStyle({ hue: 200, hue2: 238 })).toEqual({ background: css, color: '#ffffff' })
  })
})
