/**
 * Windowed rendering of a long chapter (plan.md step 16, "virtualise long chapters"): the
 * platform-free half. A plain-text book without detected headings is one chapter of several
 * thousand sentences, tens of thousands of word spans; rendering them all at once is slow on a
 * phone and heavy to keep in the DOM. Instead the reader keeps a {@link HeightMap} of every
 * paragraph's height, estimated from its length until the paragraph has been on screen once and
 * measured, and renders only the paragraphs that fall within the viewport plus an overscan on
 * either side ({@link rangeFor}). Spacers above and below the rendered window stand in for the
 * rest, so the scrollbar and the page length behave as if everything were there.
 *
 * Measuring a paragraph above the viewport changes the offsets of everything below it; the DOM
 * half (`Reader.tsx`) scrolls by that delta so the text on screen does not move.
 */

export interface TextMetrics {
  /** Average characters per rendered line at the current width and font. */
  charsPerLine: number
  /** Line box height in CSS px. */
  lineHeight: number
  /** Vertical space a paragraph adds beyond its lines (margins, padding), in CSS px. */
  spacing: number
}

/** A paragraph's height before it has been measured, from its character count. */
export function estimateHeight(chars: number, metrics: TextMetrics): number {
  const lines = Math.max(1, Math.ceil(chars / Math.max(1, metrics.charsPerLine)))
  return lines * metrics.lineHeight + metrics.spacing
}

/** Heights of a list of items, each estimated until measured, with prefix sums for offsets. */
export class HeightMap {
  private heights: Float64Array
  private measured: Uint8Array
  /** `offsets[i]` is the top of item i; `offsets[n]` the total. Rebuilt lazily after a change. */
  private offsets: Float64Array | null = null

  constructor(estimates: readonly number[]) {
    this.heights = Float64Array.from(estimates)
    this.measured = new Uint8Array(estimates.length)
  }

  get length(): number {
    return this.heights.length
  }

  heightOf(i: number): number {
    return this.heights[i]
  }

  isMeasured(i: number): boolean {
    return this.measured[i] === 1
  }

  /** Record a measured height. Returns the change against the previous value (0 when none). */
  set(i: number, height: number): number {
    const delta = height - this.heights[i]
    this.measured[i] = 1
    if (delta === 0) return 0
    this.heights[i] = height
    this.offsets = null
    return delta
  }

  /** Forget every measurement and start again from new estimates (the width or font changed). */
  reset(estimates: readonly number[]): void {
    this.heights = Float64Array.from(estimates)
    this.measured = new Uint8Array(estimates.length)
    this.offsets = null
  }

  private sums(): Float64Array {
    if (this.offsets === null) {
      const n = this.heights.length
      const offsets = new Float64Array(n + 1)
      for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + this.heights[i]
      this.offsets = offsets
    }
    return this.offsets
  }

  /** Distance from the top of the list to the top of item i; `offsetOf(length)` is the total. */
  offsetOf(i: number): number {
    return this.sums()[Math.min(Math.max(0, i), this.heights.length)]
  }

  total(): number {
    return this.offsetOf(this.heights.length)
  }

  /** The item whose box contains distance `y` from the top; clamped to the first and last item. */
  indexAt(y: number): number {
    const n = this.heights.length
    if (n === 0) return 0
    const offsets = this.sums()
    if (y < 0) return 0
    if (y >= offsets[n]) return n - 1
    // Largest i with offsets[i] <= y.
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (offsets[mid] <= y) lo = mid
      else hi = mid - 1
    }
    return lo
  }
}

/** The items to render and the spacer heights that stand in for the rest. */
export interface RenderRange {
  /** First item to render. */
  start: number
  /** One past the last item to render; `start === end` when the list is empty. */
  end: number
  /** Height of the items before `start`. */
  top: number
  /** Height of the items from `end` on. */
  bottom: number
}

/**
 * The items that intersect `[scrollTop - overscan, scrollTop + viewport + overscan)`, where
 * `scrollTop` is how far the list's top is above the viewport's top (negative while the list
 * starts below it).
 */
export function rangeFor(map: HeightMap, scrollTop: number, viewport: number, overscan: number): RenderRange {
  const n = map.length
  if (n === 0) return { start: 0, end: 0, top: 0, bottom: 0 }
  const from = scrollTop - overscan
  const to = scrollTop + viewport + overscan
  const start = map.indexAt(from)
  // indexAt clamps to the last item; past the end nothing is visible, yet we keep at least one
  // item rendered so measurements have something to work with.
  const end = Math.min(n, map.indexAt(Math.max(from, to - 1)) + 1)
  return { start, end, top: map.offsetOf(start), bottom: map.total() - map.offsetOf(end) }
}

export function sameRange(a: RenderRange, b: RenderRange): boolean {
  return a.start === b.start && a.end === b.end && a.top === b.top && a.bottom === b.bottom
}
