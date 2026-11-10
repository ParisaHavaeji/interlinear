/**
 * Generated book covers (plan §1.8): title and author on a gradient whose colours are
 * derived from the title, so the same book always gets the same cover and two books on
 * the shelf rarely share one.
 */

import type { CoverColours } from '../store/db.ts'

/** Distance (degrees) between the two gradient stops. */
const HUE_SPREAD = 38

/** FNV-1a over the UTF-16 code units; small, stable, good enough to spread hues. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** Lowercase, collapse whitespace, strip diacritics, so "Demian" and "DEMIAN " match. */
function normaliseTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Pick the gradient colours for a title. Deterministic; an empty title gets the default warm cover. */
export function coverColours(title: string): CoverColours {
  const key = normaliseTitle(title)
  if (key === '') return { hue: 32, hue2: 14 }
  const hue = hashString(key) % 360
  // Go the "warm" way round when the second hue would land in muddy yellow-green.
  const forward = (hue + HUE_SPREAD) % 360
  const hue2 = forward >= 60 && forward <= 100 ? (hue - HUE_SPREAD + 360) % 360 : forward
  return { hue, hue2 }
}

/** CSS `background` for a cover: a diagonal gradient between the two hues. */
export function coverGradient({ hue, hue2 }: CoverColours): string {
  return `linear-gradient(160deg, hsl(${hue} 64% 52%) 0%, hsl(${hue2} 70% 36%) 100%)`
}

/** Inline style for a cover element. */
export function coverStyle(colours: CoverColours): { background: string; color: string } {
  return { background: coverGradient(colours), color: '#ffffff' }
}
