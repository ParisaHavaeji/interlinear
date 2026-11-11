/**
 * Swipe-to-delete arithmetic (plan.md step 26), kept apart from the DOM so it can be tested:
 * where a list row sits while a finger drags it, and what letting go does. As in iOS lists, a
 * drag to the left uncovers a Delete button behind the row; past the button the row keeps
 * following and the button stretches with it; far enough across the row, letting go deletes
 * without a second tap. A drag to the right of rest meets a rubber band.
 */

import { rubberBand, velocityOf, type Sample } from './motion.ts'

/** Width of the uncovered Delete button, in px. */
export const SWIPE_ACTION_WIDTH = 88
/** A row dragged this share of its width to the left is deleted on release. */
export const SWIPE_DELETE_FRACTION = 0.6
/** A release moving faster than this (px/ms) decides by direction rather than position. */
export const SWIPE_FLICK = 0.3

export type SwipeOutcome = 'closed' | 'open' | 'delete'

/**
 * The row's horizontal offset (≤ 0 when uncovering) after a finger moved `dx` from where it took
 * hold with the row at `base` (0 at rest, `-SWIPE_ACTION_WIDTH` when open).
 */
export function swipeOffset(dx: number, base: number): number {
  const raw = base + dx
  return raw <= 0 ? raw : rubberBand(raw, 24)
}

/**
 * What letting go of the row at `offset` with horizontal `velocity` does: a flick decides by
 * its direction, a long drag across most of the row deletes, otherwise the row settles on the
 * nearer of closed and open.
 */
export function swipeOutcome(offset: number, velocity: number, rowWidth: number, actionWidth = SWIPE_ACTION_WIDTH): SwipeOutcome {
  if (rowWidth > 0 && -offset >= rowWidth * SWIPE_DELETE_FRACTION) return 'delete'
  if (velocity <= -SWIPE_FLICK) return 'open'
  if (velocity >= SWIPE_FLICK) return 'closed'
  return -offset >= actionWidth / 2 ? 'open' : 'closed'
}

/** The Delete button's width while the row sits at `offset`: its own, stretched once the row has gone further. */
export function actionWidthAt(offset: number, actionWidth = SWIPE_ACTION_WIDTH): number {
  return Math.max(actionWidth, -offset)
}

export { velocityOf, type Sample }
