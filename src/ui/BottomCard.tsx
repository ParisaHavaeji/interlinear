/**
 * The bottom card (plan.md step 18, §1.5–1.6): the one surface the sentence card (step 19) and
 * the word card (step 24) are drawn on. Books' "Look Up" look: rounded top corners, frosted
 * background, a grabber, the content sitting above the home indicator. It is non-modal: no
 * backdrop, the page behind stays visible and scrollable and never reflows, so the highlighted
 * sentence can be read next to its translation.
 *
 * Dismissed by swiping it down, tapping the page, or Escape. It rises and leaves on a damped
 * spring (`ui/motion.ts`, played through the Web Animations API); a drag follows the finger,
 * resists upward, and flows into that spring on release, which either returns the card or
 * carries it off. The parent owns `open`: a dismissal calls `onClose`, the card animates out
 * and unmounts once `open` is false. Content changes while open simply resize it in place.
 */

import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { dragOffset, shouldDismiss, spring, velocityOf, type Sample } from './motion.ts'
import './card.css'

interface Props {
  open: boolean
  /** The reader dismissed the card (swipe, tap outside, Escape). The parent sets `open` false. */
  onClose: () => void
  /**
   * A tap on the page outside the card, with the element tapped; closes the card when absent.
   * The Reader uses it to turn a tap on another sentence into a switch rather than a dismissal.
   */
  onOutsideTap?: (target: Element | null) => void
  /** Accessible name of the dialog. */
  label: string
  /** Fixed part under the grabber (title, actions); does not scroll. */
  header?: ComponentChildren
  /** Scrolling part. */
  children: ComponentChildren
  /** The card's on-screen height whenever it changes, 0 once it is gone, for keeping what it refers to in view. */
  onHeightChange?: (height: number) => void
}

/** The card extends this far below the screen so a spring overshoot shows no gap. Matches `--card-overshoot` in card.css. */
const OVERSHOOT = 40
/** A pointer must travel this far before the card follows it; shorter is a tap on the card. */
const DRAG_SLOP = 6
/** A pointer that moves less than this between down and up is a tap. */
const TAP_SLOP = 10

interface Drag {
  pointerId: number
  startY: number
  /** Where the card was when the finger took hold (non-zero when it interrupted an animation). */
  base: number
  samples: Sample[]
  /** Started over scrolling content: an upward move is handed to the scroller. */
  fromBody: boolean
  /** Past the slop: the card is following. */
  moving: boolean
}

export function BottomCard({ open, onClose, onOutsideTap, label, header, children, onHeightChange }: Props) {
  const [mounted, setMounted] = useState(open)
  const cardRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const animation = useRef<Animation | null>(null)
  /** The card's translateY while no animation runs. */
  const offset = useRef(0)
  /** An exit animation is in flight (the drag sent it off before `open` turned false). */
  const leaving = useRef(false)
  const drag = useRef<Drag | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  const heightRef = useRef(onHeightChange)
  heightRef.current = onHeightChange

  const currentOffset = (el: HTMLElement): number => {
    if (animation.current === null) return offset.current
    const transform = getComputedStyle(el).transform
    return transform === 'none' || transform === '' ? 0 : new DOMMatrixReadOnly(transform).f
  }

  const settle = (el: HTMLElement, y: number) => {
    animation.current?.cancel()
    animation.current = null
    offset.current = y
    el.style.transform = `translateY(${y}px)`
  }

  /** Spring the card from where it is to `to`, starting at `velocity`, then `done`. */
  const animateTo = (el: HTMLElement, to: number, velocity: number, done?: () => void) => {
    const from = currentOffset(el)
    animation.current?.cancel()
    animation.current = null
    const track = reducedMotion() || typeof el.animate !== 'function' ? null : spring(from, to, velocity)
    if (track === null || track.duration === 0) {
      settle(el, to)
      done?.()
      return
    }
    const a = el.animate(
      track.values.map((y) => ({ transform: `translateY(${y}px)` })),
      { duration: track.duration, easing: 'linear', fill: 'forwards' },
    )
    animation.current = a
    a.onfinish = () => {
      if (animation.current !== a) return
      settle(el, to)
      done?.()
    }
  }

  const finishClose = () => {
    leaving.current = false
    setMounted(false)
    heightRef.current?.(0)
  }

  /** The translateY that puts the card wholly below the screen, shadow included. */
  const offScreen = (el: HTMLElement) => el.getBoundingClientRect().height + OVERSHOOT

  // Entrance: the card is in the DOM but, before paint, moved below the screen, then springs up.
  useLayoutEffect(() => {
    const el = cardRef.current
    if (!mounted || el === null) return
    settle(el, offScreen(el))
    animateTo(el, 0, 0)
  }, [mounted])

  // `open` changes: mount for an opening; spring out for a closing, unless the drag already did.
  useLayoutEffect(() => {
    const el = cardRef.current
    if (open) {
      if (!mounted) setMounted(true)
      else if (el !== null && leaving.current) {
        leaving.current = false
        animateTo(el, 0, 0)
      }
      return
    }
    if (!mounted || el === null || leaving.current) return
    leaving.current = true
    animateTo(el, offScreen(el), 0, () => {
      if (openRef.current) {
        leaving.current = false
        animateTo(el, 0, 0)
      } else finishClose()
    })
  }, [open])

  // Report the on-screen height while open, and let overflowing content scroll natively.
  useLayoutEffect(() => {
    const el = cardRef.current
    const body = bodyRef.current
    if (!mounted || el === null || body === null) return
    const measure = () => {
      body.style.touchAction = body.scrollHeight > body.clientHeight + 1 ? 'pan-y' : ''
      if (openRef.current) heightRef.current?.(Math.max(0, el.getBoundingClientRect().height - OVERSHOOT))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    observer.observe(body)
    return () => observer.disconnect()
  }, [mounted])

  // Escape and taps on the page. Taps are told apart from scrolls by how far the pointer moved.
  useEffect(() => {
    if (!open || !mounted) return
    let down: { x: number; y: number; target: EventTarget | null } | null = null
    const onDown = (e: PointerEvent) => {
      if (!e.isPrimary) return
      down = cardRef.current?.contains(e.target as Node) ? null : { x: e.clientX, y: e.clientY, target: e.target }
    }
    const onUp = (e: PointerEvent) => {
      const d = down
      down = null
      if (d === null || !e.isPrimary || Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_SLOP) return
      const target = d.target instanceof Element ? d.target : null
      if (onOutsideTap !== undefined) onOutsideTap(target)
      else onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('pointerup', onUp, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('pointerup', onUp, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, mounted, onClose, onOutsideTap])

  // --- Drag ---------------------------------------------------------------------------------

  const onPointerDown = (e: PointerEvent) => {
    const el = cardRef.current
    const body = bodyRef.current
    if (el === null || body === null || !e.isPrimary || e.button !== 0 || drag.current !== null) return
    const inBody = body.contains(e.target as Node)
    // Scrolled content scrolls; the card is dismissed from its handle or by scrolling back up first.
    if (inBody && body.scrollTop > 0) return
    const base = currentOffset(el)
    if (animation.current !== null) settle(el, base)
    drag.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      base,
      samples: [{ t: e.timeStamp, y: e.clientY }],
      fromBody: inBody && body.scrollHeight > body.clientHeight + 1,
      moving: false,
    }
  }

  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current
    const el = cardRef.current
    if (d === null || el === null || e.pointerId !== d.pointerId) return
    const dy = e.clientY - d.startY
    d.samples.push({ t: e.timeStamp, y: e.clientY })
    if (d.samples.length > 32) d.samples.shift()
    if (!d.moving) {
      if (Math.abs(dy) < DRAG_SLOP) return
      if (d.fromBody && dy < 0) {
        drag.current = null
        return
      }
      d.moving = true
      // Capture only now: a capture from pointerdown would swallow the clicks on the card's buttons.
      el.setPointerCapture(e.pointerId)
      el.dataset.dragging = ''
    }
    offset.current = dragOffset(d.base + dy)
    el.style.transform = `translateY(${offset.current}px)`
  }

  const onPointerEnd = (e: PointerEvent) => {
    const d = drag.current
    const el = cardRef.current
    if (d === null || el === null || e.pointerId !== d.pointerId) return
    drag.current = null
    if (!d.moving) {
      // A tap on the card that interrupted an animation: carry on to the resting place.
      if (offset.current !== 0 && !leaving.current) animateTo(el, 0, 0)
      return
    }
    delete el.dataset.dragging
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    const velocity = e.type === 'pointercancel' ? 0 : velocityOf(d.samples)
    const height = el.getBoundingClientRect().height - OVERSHOOT
    if (e.type !== 'pointercancel' && shouldDismiss(offset.current, velocity, height)) {
      leaving.current = true
      onClose()
      animateTo(el, offScreen(el), velocity, () => {
        if (openRef.current) {
          leaving.current = false
          animateTo(el, 0, 0)
        } else finishClose()
      })
    } else animateTo(el, 0, velocity)
  }

  if (!mounted) return null

  return (
    <div
      class="card"
      role="dialog"
      aria-label={label}
      ref={cardRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <div class="card-handle">
        <div class="card-grabber" aria-hidden="true" />
      </div>
      {header !== undefined && <div class="card-header">{header}</div>}
      <div class="card-body" ref={bodyRef}>
        {children}
      </div>
    </div>
  )
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}
