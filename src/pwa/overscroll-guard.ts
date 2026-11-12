/**
 * The touch listeners behind `overscroll.ts` (plan.md step 31): cancel the vertical pans that
 * would only bounce the page. Installed once by `main.tsx`.
 *
 * Only a pan's first moves can be cancelled: once the browser has begun scrolling, its
 * `touchmove` events are no longer cancelable, and the guard leaves them be. That is enough,
 * since a bounce starts with a pan that nothing can take, and a scroll that reaches an edge
 * mid-gesture stops there on iOS without bouncing when `overscroll-behavior` is `none`.
 */
import { blocksPan, isVerticalPan, type Scroller } from './overscroll.ts'

/** The scroll containers from `target` out to the page, for {@link blocksPan}. */
function scrollersUnder(target: EventTarget | null, doc: Document): Scroller[] {
  const out: Scroller[] = []
  const root = doc.documentElement
  for (let el = target instanceof Element ? target : null; el !== null && el !== root && el !== doc.body; el = el.parentElement) {
    const style = getComputedStyle(el)
    if (!/auto|scroll/.test(style.overflowY)) continue
    out.push({
      metrics: { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
      chains: style.overscrollBehaviorY === '' || style.overscrollBehaviorY === 'auto',
    })
  }
  const page = doc.scrollingElement ?? root
  out.push({ metrics: { scrollTop: page.scrollTop, scrollHeight: page.scrollHeight, clientHeight: page.clientHeight }, chains: false })
  return out
}

/** Start guarding the document; returns the function that stops it. */
export function installOverscrollGuard(doc: Document = document): () => void {
  let startX = 0
  let startY = 0

  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return
    startX = e.touches[0].clientX
    startY = e.touches[0].clientY
  }

  const onMove = (e: TouchEvent) => {
    if (e.touches.length !== 1 || !e.cancelable) return
    const dx = e.touches[0].clientX - startX
    const dy = e.touches[0].clientY - startY
    if (!isVerticalPan(dx, dy)) return
    if (blocksPan(scrollersUnder(e.target, doc), dy)) e.preventDefault()
  }

  doc.addEventListener('touchstart', onStart, { passive: true })
  doc.addEventListener('touchmove', onMove, { passive: false })
  return () => {
    doc.removeEventListener('touchstart', onStart)
    doc.removeEventListener('touchmove', onMove)
  }
}
