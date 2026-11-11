/**
 * A list row that swipes to delete (plan.md step 26), as rows in iOS lists do: dragging it to
 * the left uncovers a red Delete button; letting go snaps the row open or shut, or, after a
 * long drag across most of the row, deletes at once (`ui/swipe.ts` decides). The parent says
 * which row is open, so that one open row closes when another is swiped or the list is tapped.
 * A tap on the row's content is a tap (`onTap`) while the row is shut and closes it while open;
 * with the keyboard, Delete or Backspace on the focused row uncovers the button and focuses it.
 * Vertical scrolling is left to the browser (`touch-action: pan-y`).
 */

import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { actionWidthAt, SWIPE_ACTION_WIDTH, swipeOffset, swipeOutcome, velocityOf, type Sample } from './swipe.ts'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onDelete: () => void
  onTap?: () => void
  /** Accessible name of the row's content, which is a button. */
  label: string
  children: ComponentChildren
}

/** A pointer must travel this far, more sideways than up or down, before the row follows it. */
const DRAG_SLOP = 8
/** How long the row takes to settle after a release. */
const SETTLE_MS = 220

interface Drag {
  pointerId: number
  startX: number
  startY: number
  base: number
  samples: Sample[]
  moving: boolean
}

export function SwipeRow({ open, onOpenChange, onDelete, onTap, label, children }: Props) {
  const rowRef = useRef<HTMLLIElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const deleteRef = useRef<HTMLButtonElement>(null)
  const drag = useRef<Drag | null>(null)
  const skipClick = useRef(false)
  /** The offset while a finger holds the row; null while it rests where `open` says. */
  const [dragOffset, setDragOffset] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)

  const restOffset = open ? -SWIPE_ACTION_WIDTH : 0
  const offset = dragOffset ?? restOffset

  const settle = (outcome: 'closed' | 'open') => {
    setDragOffset(null)
    if ((outcome === 'open') !== open) onOpenChange(outcome === 'open')
  }

  const remove = () => {
    setDeleting(true)
    window.setTimeout(onDelete, SETTLE_MS)
  }

  const onPointerDown = (e: PointerEvent) => {
    if (!e.isPrimary || e.button !== 0 || deleting) return
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, base: restOffset, samples: [{ t: e.timeStamp, y: e.clientX }], moving: false }
  }
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current
    if (d === null || e.pointerId !== d.pointerId) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moving) {
      if (Math.abs(dx) < DRAG_SLOP) return
      // More up or down than sideways: a scroll, not a swipe.
      if (Math.abs(dy) > Math.abs(dx)) {
        drag.current = null
        return
      }
      d.moving = true
      skipClick.current = true
      contentRef.current?.setPointerCapture(e.pointerId)
    }
    d.samples.push({ t: e.timeStamp, y: e.clientX })
    if (d.samples.length > 12) d.samples.shift()
    setDragOffset(swipeOffset(dx, d.base))
  }
  const onPointerEnd = (e: PointerEvent) => {
    const d = drag.current
    if (d === null || e.pointerId !== d.pointerId) return
    drag.current = null
    if (!d.moving) return
    const current = swipeOffset(e.clientX - d.startX, d.base)
    const width = rowRef.current?.clientWidth ?? 0
    const outcome = e.type === 'pointercancel' ? (open ? 'open' : 'closed') : swipeOutcome(current, velocityOf(d.samples), width)
    if (outcome === 'delete') remove()
    else settle(outcome)
  }

  const onClick = (e: MouseEvent) => {
    if (skipClick.current) {
      skipClick.current = false
      e.preventDefault()
      return
    }
    if (open) onOpenChange(false)
    else onTap?.()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return
    e.preventDefault()
    onOpenChange(true)
  }
  // Opened from the keyboard: hand focus to the button it uncovered.
  useEffect(() => {
    if (open && document.activeElement === contentRef.current) deleteRef.current?.focus()
  }, [open])

  const dragging = dragOffset !== null
  const width = rowRef.current?.clientWidth ?? 0
  const style = deleting ? { transform: `translateX(${-Math.max(width, SWIPE_ACTION_WIDTH)}px)` } : { transform: `translateX(${offset}px)` }

  return (
    <li class={`swipe ${deleting ? 'swipe--deleting' : ''}`} ref={rowRef} data-open={open || undefined} data-dragging={dragging || undefined}>
      <div class="swipe-actions" aria-hidden={!open}>
        <button
          type="button"
          class="swipe-delete"
          ref={deleteRef}
          tabIndex={open ? 0 : -1}
          style={{ width: `${deleting ? Math.max(width, SWIPE_ACTION_WIDTH) : actionWidthAt(offset)}px` }}
          onClick={remove}
        >
          Delete
        </button>
      </div>
      <div
        class="swipe-content"
        ref={contentRef}
        role="button"
        tabIndex={0}
        aria-label={label}
        style={style}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (open) onOpenChange(false)
            else onTap?.()
          } else onKeyDown(e)
        }}
      >
        {children}
      </div>
    </li>
  )
}
