/**
 * The Books chrome's arithmetic (plan.md step 17), kept apart from the DOM so it can be tested:
 * when the top bar and footer hide and show as the page scrolls, and how far the page has scrolled.
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

/**
 * Where the reader is in the book. The book scrolls as one page, so a "page" is a screenful:
 * the page number is the screen the viewport's top edge is on, counted from the top, and the
 * last page is reached when the end of the book is on screen.
 */
export interface ReadingPosition {
  /** 0 at the top, 1 once the end of the page is on screen. */
  fraction: number
  /** Pages after the one on screen; 0 on the last. */
  pagesLeft: number
  /** The page on screen, from 1. */
  page: number
  /** Pages in the book at this screen size and type. */
  pages: number
}

export function readingPosition(scrollY: number, scrollHeight: number, viewport: number): ReadingPosition {
  const max = scrollHeight - viewport
  if (max <= 0 || viewport <= 0) return { fraction: 1, pagesLeft: 0, page: 1, pages: 1 }
  const y = Math.min(Math.max(0, scrollY), max)
  const pages = Math.ceil(max / viewport) + 1
  const page = y >= max - 1 ? pages : Math.min(pages, Math.floor(y / viewport) + 1)
  return { fraction: y / max, pagesLeft: pages - page, page, pages }
}

/**
 * Screens still to scroll before the chapter's end is on screen: `end` is where the chapter
 * ends and `y` where the viewport starts, both measured from the same origin. 0 once it shows.
 */
export function pagesLeftInChapter(end: number, y: number, viewport: number): number {
  if (viewport <= 0) return 0
  return Math.max(0, Math.ceil((end - y - viewport) / viewport))
}
