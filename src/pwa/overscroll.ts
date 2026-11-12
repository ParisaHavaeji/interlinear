/**
 * No rubber-band on the chrome (plan.md step 31, §1.8), the arithmetic kept apart from the DOM
 * so it can be tested; the touch listeners are `overscroll-guard.ts`.
 *
 * iOS bounces the whole page when a finger pulls past the top or the bottom, and a web app on
 * the Home Screen bounces with it: the fixed top bar, footer and cards ride along and a strip
 * of bare background shows, which a native app never does. `overscroll-behavior: none` asks the
 * browser not to, but Safari has honoured it only in part and late, so the guard decides for
 * each vertical pan whether anything under the finger can still scroll the way it asks: if
 * nothing can, the move is cancelled before the browser turns it into a bounce. Pans that
 * something can take, and horizontal ones, are left alone.
 */

/** What matters of a scroll container's geometry. */
export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** A scroll container under the finger, innermost first; the page itself is the last. */
export interface Scroller {
  metrics: ScrollMetrics
  /**
   * Whether a pan this one cannot take passes to the container outside it (CSS
   * `overscroll-behavior: auto`). The bottom card's body and the sheets say `contain`.
   */
  chains: boolean
}

/** A pan the guard looks at: the finger moved mostly up or down the screen. */
export function isVerticalPan(dx: number, dy: number): boolean {
  return dy !== 0 && Math.abs(dy) > Math.abs(dx)
}

/**
 * Whether a container can still scroll the way a finger travelling `dy` asks: a finger moving
 * down the screen (positive) pulls what is above into view, so there must be something above;
 * one moving up needs something below. Half a pixel of slack for fractional positions.
 */
export function canScrollBy(m: ScrollMetrics, dy: number): boolean {
  if (dy > 0) return m.scrollTop > 0.5
  if (dy < 0) return m.scrollTop + m.clientHeight < m.scrollHeight - 0.5
  return false
}

/**
 * Whether a vertical pan of `dy` should be cancelled, given the scroll containers under the
 * finger from the innermost out to the page: it is let through as soon as one of them can take
 * it, and cancelled when none can, or when one that cannot refuses to pass it on.
 */
export function blocksPan(scrollers: readonly Scroller[], dy: number): boolean {
  for (const s of scrollers) {
    if (canScrollBy(s.metrics, dy)) return false
    if (!s.chains) return true
  }
  return true
}
