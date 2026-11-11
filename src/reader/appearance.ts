/**
 * The aA menu's model (plan.md step 28, §1.8), kept apart from the DOM so it can be tested:
 * the reading font, text size, line spacing and theme a reader can choose, what each choice
 * means in CSS, and how a stored choice is read back safely.
 *
 * Books' font picker (Original, Athelas, Charter, Georgia, Palatino, San Francisco, Times New
 * Roman) is mapped to what iOS has installed: Athelas is a Mac font, so its place goes to Iowan
 * Old Style, which iOS ships and Books itself uses. Every stack ends in fallbacks for other
 * platforms. Themes are Books' four plus Auto (White or Night by the system setting); the
 * colours live in index.css under `:root[data-theme=…]`, the menu only names them.
 *
 * The choice is one `settings` row (`store/settings.ts`, key `appearance`), applied as custom
 * properties on the Reader's root (`appearanceStyle`) and as a `data-theme` attribute on
 * `<html>` while the Reader is open, so the page, its chrome and the cards follow together.
 */

export type ReadingFont = 'original' | 'charter' | 'georgia' | 'iowan' | 'palatino' | 'sanfrancisco' | 'times'

export type LineSpacing = 'tight' | 'normal' | 'loose'

export type Theme = 'white' | 'sepia' | 'gray' | 'night' | 'auto'

export interface Appearance {
  font: ReadingFont
  /** Body text size in CSS px, one of {@link FONT_SIZES}. */
  size: number
  spacing: LineSpacing
  theme: Theme
}

export interface FontOption {
  key: ReadingFont
  label: string
  /** The CSS `font-family` stack. */
  stack: string
}

export const FONTS: readonly FontOption[] = [
  { key: 'original', label: 'Original', stack: "ui-serif, 'New York', 'Iowan Old Style', Palatino, 'Palatino Linotype', Georgia, serif" },
  { key: 'charter', label: 'Charter', stack: "Charter, 'Bitstream Charter', 'Iowan Old Style', Georgia, serif" },
  { key: 'georgia', label: 'Georgia', stack: "Georgia, 'Iowan Old Style', serif" },
  { key: 'iowan', label: 'Iowan', stack: "'Iowan Old Style', Palatino, 'Palatino Linotype', Georgia, serif" },
  { key: 'palatino', label: 'Palatino', stack: "Palatino, 'Palatino Linotype', 'Book Antiqua', 'URW Palladio L', Georgia, serif" },
  { key: 'sanfrancisco', label: 'San Francisco', stack: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', ui-sans-serif, system-ui, 'Helvetica Neue', sans-serif" },
  { key: 'times', label: 'Times New Roman', stack: "'Times New Roman', Times, 'Nimbus Roman', serif" },
]

/** The sizes the stepper walks, in CSS px; Books' range, finer near the default. */
export const FONT_SIZES: readonly number[] = [14, 15, 16, 17, 18, 19, 20, 22, 24, 26, 28, 30, 32]

export const LINE_SPACINGS: readonly { key: LineSpacing; label: string; lineHeight: number }[] = [
  { key: 'tight', label: 'Tight', lineHeight: 1.35 },
  { key: 'normal', label: 'Normal', lineHeight: 1.55 },
  { key: 'loose', label: 'Loose', lineHeight: 1.8 },
]

export const THEMES: readonly { key: Theme; label: string }[] = [
  { key: 'white', label: 'White' },
  { key: 'sepia', label: 'Sepia' },
  { key: 'gray', label: 'Gray' },
  { key: 'night', label: 'Night' },
  { key: 'auto', label: 'Auto' },
]

/** What a reader gets before touching the menu: the page as steps 16–27 drew it, following the system's light or dark. */
export const DEFAULT_APPEARANCE: Appearance = { font: 'original', size: 18, spacing: 'normal', theme: 'auto' }

export function fontOf(key: ReadingFont): FontOption {
  return FONTS.find((f) => f.key === key) ?? FONTS[0]
}

export function lineHeightOf(spacing: LineSpacing): number {
  return (LINE_SPACINGS.find((s) => s.key === spacing) ?? LINE_SPACINGS[1]).lineHeight
}

/** The allowed size nearest to `size` (the first of two equally near). */
export function nearestFontSize(size: number): number {
  let best = FONT_SIZES[0]
  for (const s of FONT_SIZES) if (Math.abs(s - size) < Math.abs(best - size)) best = s
  return best
}

/** Whether the stepper can go smaller (-1) or larger (+1) from `size`. */
export function canStepFontSize(size: number, direction: -1 | 1): boolean {
  const i = FONT_SIZES.indexOf(nearestFontSize(size))
  return direction < 0 ? i > 0 : i < FONT_SIZES.length - 1
}

/** The next size in `direction`, or the same size at either end. */
export function stepFontSize(size: number, direction: -1 | 1): number {
  const i = FONT_SIZES.indexOf(nearestFontSize(size))
  return FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, i + direction))]
}

/** `value` as an Appearance: every field a known choice, unknown or missing ones the default. */
export function sanitizeAppearance(value: unknown): Appearance {
  const out = { ...DEFAULT_APPEARANCE }
  if (typeof value !== 'object' || value === null) return out
  const v = value as Record<string, unknown>
  if (typeof v.font === 'string' && FONTS.some((f) => f.key === v.font)) out.font = v.font as ReadingFont
  if (typeof v.size === 'number' && Number.isFinite(v.size)) out.size = nearestFontSize(v.size)
  if (typeof v.spacing === 'string' && LINE_SPACINGS.some((s) => s.key === v.spacing)) out.spacing = v.spacing as LineSpacing
  if (typeof v.theme === 'string' && THEMES.some((t) => t.key === v.theme)) out.theme = v.theme as Theme
  return out
}

/**
 * The custom properties for the Reader's root, as an inline style: the reading font replaces
 * `--font-serif` there so the page, the chapter heading and the cards' text all take it, and
 * `.reader-page` reads its size and line height from the other two.
 */
export function appearanceStyle(a: Appearance): string {
  return `--font-serif: ${fontOf(a.font).stack}; --reader-size: ${a.size}px; --reader-leading: ${lineHeightOf(a.spacing)}`
}

/** What `<html data-theme>` should hold: a theme name, or nothing for Auto, which leaves the system in charge. */
export function themeAttribute(theme: Theme): string | null {
  return theme === 'auto' ? null : theme
}

/** The theme on screen once Auto is settled by the system. */
export function resolveTheme(theme: Theme, systemDark: boolean): Exclude<Theme, 'auto'> {
  return theme === 'auto' ? (systemDark ? 'night' : 'white') : theme
}

/** Changes under which the windowed page's height estimates are stale (anything but the theme). */
export function metricsKey(a: Appearance): string {
  return `${a.font}/${a.size}/${a.spacing}`
}
