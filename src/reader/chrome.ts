/**
 * The Books chrome's arithmetic (plan.md step 17), kept apart from the DOM so it can be tested:
 * when the top bar and footer hide and show as the page scrolls, and what the footer says.
 */

/** Whether the chrome is hidden, and the scroll offset the decision was last anchored to. */
export interface ChromeState {
  hidden: boolean
  /** While hidden, the furthest down the page has been; while shown, the furthest up. */
  anchor: number
}

export interface ChromeOptions {
  /** Scrolling this far in one direction flips the chrome. */
  threshold?: number
  /** Within this distance of the top the chrome always shows. */
  top?: number
}

export const SHOWN: ChromeState = { hidden: false, anchor: 0 }

/**
 * The chrome after the page scrolled to `y`: hidden once it has gone down by more than the
 * threshold from where it was last shown, shown again once it has come up by more than the
 * threshold from the lowest point reached while hidden, and always shown near the top. Small
 * jitters in either direction change nothing.
 */
export function chromeAfterScroll(state: ChromeState, y: number, options: ChromeOptions = {}): ChromeState {
  const threshold = options.threshold ?? 24
  const top = options.top ?? 48
  if (y <= top) return state.hidden || state.anchor !== y ? { hidden: false, anchor: y } : state
  if (state.hidden) {
    if (y < state.anchor - threshold) return { hidden: false, anchor: y }
    return y > state.anchor ? { hidden: true, anchor: y } : state
  }
  if (y > state.anchor + threshold) return { hidden: true, anchor: y }
  return y < state.anchor ? { hidden: false, anchor: y } : state
}

/** Where the reader is in the chapter: the share scrolled, and the screens still to go. */
export interface ReadingPosition {
  /** 0 at the top, 1 once the end of the page is on screen. */
  fraction: number
  /** Viewport-heights of page below the one on screen, rounded up; 0 on the last screen. */
  pagesLeft: number
}

export function readingPosition(scrollY: number, scrollHeight: number, viewport: number): ReadingPosition {
  const max = scrollHeight - viewport
  if (max <= 0 || viewport <= 0) return { fraction: 1, pagesLeft: 0 }
  const y = Math.min(Math.max(0, scrollY), max)
  return { fraction: y / max, pagesLeft: Math.max(0, Math.ceil((max - y) / viewport)) }
}

/** The footer's wording for a reading position. */
export function pagesLeftLabel(pagesLeft: number): string {
  if (pagesLeft === 0) return 'Last page in this chapter'
  return pagesLeft === 1 ? '1 page left in this chapter' : `${pagesLeft} pages left in this chapter`
}
