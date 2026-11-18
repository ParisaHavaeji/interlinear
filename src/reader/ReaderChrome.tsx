/**
 * The Books chrome around the page (plan.md step 17): a top bar with back, contents, title,
 * aA, search and bookmark, and a footer with the page number and the pages left in the
 * chapter. Both slide away as the reader scrolls down and come back on the way up
 * (`useChrome`, over the arithmetic in `chrome.ts`). The ribbon opens the book's bookmarks
 * (step 26); bookmarks themselves are made from the bottom card (step 25). aA opens the
 * appearance menu (step 28, `AppearanceMenu.tsx`). Search is a later step; its button is in
 * place but disabled until then.
 */

import type { RefObject } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { chromeAfterScroll, readingPosition, SHOWN, type ChromeState, type ReadingPosition } from './chrome.ts'

export interface Chrome {
  hidden: boolean
  position: ReadingPosition
}

/**
 * Follow the window's scroll: hide the chrome on the way down, show it on the way up, and keep
 * the footer's position current. `page` is the element whose height is the page's: the
 * windowed body grows after the first paint and as paragraphs are measured, which moves no
 * scroll position but changes how far through the book the page is.
 */
export function useChrome(resetKey: unknown, page: RefObject<HTMLElement | null>): Chrome {
  const [state, setState] = useState<ChromeState>(SHOWN)
  const [position, setPosition] = useState<ReadingPosition>({ fraction: 0, pagesLeft: 0, page: 1, pages: 1 })
  useEffect(() => {
    let frame = 0
    const measure = () => {
      frame = 0
      setState((s) => chromeAfterScroll(s, window.scrollY))
      setPosition((p) => {
        const next = readingPosition(window.scrollY, document.documentElement.scrollHeight, window.innerHeight)
        return next.fraction === p.fraction && next.page === p.page && next.pages === p.pages ? p : next
      })
    }
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure)
    }
    setState(SHOWN)
    measure()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const observer = typeof ResizeObserver === 'undefined' || page.current === null ? null : new ResizeObserver(schedule)
    observer?.observe(page.current!)
    return () => {
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      observer?.disconnect()
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [resetKey])
  return { hidden: state.hidden, position }
}

interface BarProps {
  title: string
  onBack: () => void
  /** Opens the chapter list; absent while there is nothing to list. */
  onContents?: () => void
  /** Opens the book's bookmarks (step 26); absent while the book is still loading. */
  onBookmarks?: () => void
  /** Opens the aA menu (step 28). */
  onAppearance?: () => void
  /** The aA menu is open. */
  appearanceOpen?: boolean
}

export function ReaderBar({ title, onBack, onContents, onBookmarks, onAppearance, appearanceOpen = false }: BarProps) {
  return (
    <header class="reader-bar">
      <div class="reader-bar-group">
        <button type="button" class="reader-btn" aria-label="Back to Library" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M15 4.5 7.5 12l7.5 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button type="button" class="reader-btn" aria-label="Contents" disabled={onContents === undefined} onClick={onContents}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M9 6h11M9 12h11M9 18h11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            <circle cx="4.5" cy="6" r="1.4" fill="currentColor" />
            <circle cx="4.5" cy="12" r="1.4" fill="currentColor" />
            <circle cx="4.5" cy="18" r="1.4" fill="currentColor" />
          </svg>
        </button>
      </div>
      <div class="reader-bar-title">{title}</div>
      <div class="reader-bar-group reader-bar-group--end">
        <button
          type="button"
          class="reader-btn reader-btn--aa"
          aria-label="Appearance"
          title="Appearance"
          aria-haspopup="dialog"
          aria-expanded={appearanceOpen}
          disabled={onAppearance === undefined}
          onClick={onAppearance}
        >
          aA
        </button>
        <button type="button" class="reader-btn" aria-label="Search" title="Search: coming soon" disabled>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2" />
            <path d="m15.5 15.5 5 5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
          </svg>
        </button>
        <button type="button" class="reader-btn" aria-label="Bookmarks" title="Bookmarks" disabled={onBookmarks === undefined} onClick={onBookmarks}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M6.5 3.5h11v17l-5.5-4.5-5.5 4.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </header>
  )
}

interface FooterProps {
  position: ReadingPosition
  /** Screens left before the chapter on screen ends; null while that is not known. */
  chapterLeft: number | null
}

/**
 * The page number, as Books shows it: with the chrome up, "12 of 345" over "4 pages left in
 * chapter" at the foot of the screen; while reading, only the bare page number stays, small and
 * grey in the same spot.
 */
export function ReaderFooter({ position, chapterLeft }: FooterProps) {
  const left = chapterLeft === null ? null : chapterLeft === 0 ? 'Last page in chapter' : chapterLeft === 1 ? '1 page left in chapter' : `${chapterLeft} pages left in chapter`
  return (
    <>
      <div class="reader-pagenum" aria-hidden="true">
        {position.page}
      </div>
      <footer class="reader-footer" aria-label={`Page ${position.page} of ${position.pages}`}>
        <div class="reader-footer-page">
          {position.page} of {position.pages}
        </div>
        {left !== null && <div class="reader-footer-left">{left}</div>}
      </footer>
    </>
  )
}
