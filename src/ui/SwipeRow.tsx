/**
 * A list row that swipes to delete (plan.md step 26), as rows in iOS lists do: dragging it to
 * the left uncovers a red Delete button; letting go snaps the row open or shut, or, after a
 * long drag across most of the row, deletes at once (`ui/swipe.ts` decides). The parent says
 * which row is open, so that one open row closes when another is swiped or the list is tapped.
 * A tap on the row's content is a tap (`onTap`) while the row is shut and closes it while open;
 * with the keyboard, Delete or Backspace on the focused row uncovers the button and focuses it.
 * Vertical scrolling is left to the browser (`touch-action: pan-y`).
 *
 * The Library's shelf tiles (step 29) use the same row in two other ways: `plain` content that
 * is not itself a button but carries its own link and buttons (a tap on them is theirs while
 * the row is shut; any tap closes an open row), and `ask`, where Delete reports `onDelete` and
 * leaves the row open for the parent to confirm, which then collapses it with `removing`.
 */

import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { actionWidthAt, SWIPE_ACTION_WIDTH, swipeOffset, swipeOutcome, velocityOf, type Sample } from './swipe.ts'
import './swipe.css'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Delete was chosen: by its button, or by a drag across most of the row. */
  onDelete: () => void
  onTap?: () => void
  /** Accessible name of the row's content, which is a button unless `plain`. */
  label?: string
  /** Class on the row element, beside `swipe`. */
  class?: string
  /**
   * The content is not a button of its own: the children bring their links and buttons, which
   * work while the row is shut; a tap anywhere closes an open row. Delete and Backspace still
   * uncover the button from any focused child.
   */
  plain?: boolean
  /**
   * Delete asks first: choosing it reports `onDelete` with the row left open instead of
   * collapsing it; the parent confirms, then sets `removing` to collapse the row, or closes it.
   */
  ask?: boolean
  /** Collapse the row as a deletion does (after `ask`); the parent removes it afterwards. */
  removing?: boolean
  /** Width of the uncovered Delete button, in px. */
  actionWidth?: number
  children: ComponentChildren
}

/** A pointer must travel this far, more sideways than up or down, before the row follows it. */
const DRAG_SLOP = 8
/** How long the row takes to settle after a release. */
export const SWIPE_SETTLE_MS = 220

interface Drag {
  pointerId: number
  startX: number
  startY: number
  base: number
  samples: Sample[]
  moving: boolean
}

export function SwipeRow({ open, onOpenChange, onDelete, onTap, label, class: cls, plain = false, ask = false, removing = false, actionWidth = SWIPE_ACTION_WIDTH, children }: Props) {
  const rowRef = useRef<HTMLLIElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const deleteRef = useRef<HTMLButtonElement>(null)
  const drag = useRef<Drag | null>(null)
  const skipClick = useRef(false)
  /** The offset while a finger holds the row; null while it rests where `open` says. */
  const [dragOffset, setDragOffset] = useState<number | null>(null)
  const [collapsing, setCollapsing] = useState(false)
  const deleting = collapsing || removing

  const restOffset = open ? -actionWidth : 0
  const offset = dragOffset ?? restOffset

  const settle = (outcome: 'closed' | 'open') => {
    setDragOffset(null)
    if ((outcome === 'open') !== open) onOpenChange(outcome === 'open')
  }

  const remove = () => {
    if (ask) {
      // Leave the row open on the question; the parent collapses or closes it with its answer.
      settle('open')
      onDelete()
      return
    }
    setCollapsing(true)
    window.setTimeout(onDelete, SWIPE_SETTLE_MS)
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
    const outcome = e.type === 'pointercancel' ? (open ? 'open' : 'closed') : swipeOutcome(current, velocityOf(d.samples), width, actionWidth)
    if (outcome === 'delete') remove()
    else settle(outcome)
  }

  // The click after a drag, and any click while the row is open, go no further: not to the
  // row's own tap, nor to a link or button among plain content. Handled before the target sees
  // the event, so a link does not navigate and a button does not fire.
  const onClickCapture = (e: MouseEvent) => {
    if (skipClick.current) {
      skipClick.current = false
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (open) {
      e.preventDefault()
      e.stopPropagation()
      onOpenChange(false)
    }
  }
  const onClick = () => {
    if (!plain) onTap?.()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // Not from a text field among the children.
      const target = e.target as HTMLElement | null
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      e.preventDefault()
      onOpenChange(true)
    } else if (!plain && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      if (open) onOpenChange(false)
      else onTap?.()
    }
  }
  // Opened from the keyboard: hand focus to the button it uncovered.
  useEffect(() => {
    if (open && contentRef.current?.contains(document.activeElement) === true) deleteRef.current?.focus()
  }, [open])

  const dragging = dragOffset !== null
  const width = rowRef.current?.clientWidth ?? 0
  const style = deleting ? { transform: `translateX(${-Math.max(width, actionWidth)}px)` } : { transform: `translateX(${offset}px)` }

  return (
    <li
      class={`swipe ${deleting ? 'swipe--deleting' : ''} ${cls ?? ''}`}
      ref={rowRef}
      data-open={open || undefined}
      data-dragging={dragging || undefined}
    >
      <div class="swipe-actions" aria-hidden={!open}>
        <button
          type="button"
          class="swipe-delete"
          ref={deleteRef}
          tabIndex={open ? 0 : -1}
          style={{ width: `${deleting ? Math.max(width, actionWidth) : actionWidthAt(offset, actionWidth)}px` }}
          onClick={remove}
        >
          Delete
        </button>
      </div>
      <div
        class="swipe-content"
        ref={contentRef}
        role={plain ? undefined : 'button'}
        tabIndex={plain ? undefined : 0}
        aria-label={plain ? undefined : label}
        style={style}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClickCapture={onClickCapture}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </li>
  )
}
