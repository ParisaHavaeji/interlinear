/**
 * Keep the browser's own chrome in the reading theme (plan.md step 31). Safari on iOS tints its
 * toolbars with the page's `theme-color`; `index.html` gives one per system scheme, which suits
 * Auto, but a reader who pins Sepia or Gray in the aA menu would read under a white or black
 * toolbar. While a theme is pinned (`<html data-theme>`), both metas take the page's background
 * as the theme's colours resolve it; when the attribute goes, they return to their own values.
 */

const DEFAULTS: Record<string, string> = {
  '(prefers-color-scheme: light)': '#ffffff',
  '(prefers-color-scheme: dark)': '#000000',
}

export function syncThemeColor(doc: Document = document): void {
  const root = doc.documentElement
  const pinned = root.dataset.theme !== undefined ? getComputedStyle(root).backgroundColor : null
  for (const meta of doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const fallback = DEFAULTS[meta.media] ?? DEFAULTS['(prefers-color-scheme: light)']
    meta.content = pinned ?? fallback
  }
}
