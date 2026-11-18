/**
 * The browser's text selection, read as a place in the book: the DOM half of highlighting
 * (`bookmarks/highlights.ts` is the model). A paragraph of the page is a `<p class="para">`
 * carrying its `Paragraph.idx` as `data-para`, and shows exactly its stored text, so a point of
 * the selection is the paragraph it is in and the number of characters before it there.
 *
 * Touches the DOM, so the tests never import it.
 */

import type { TextRange } from '../bookmarks/highlights.ts'

/**
 * The selection as a range of the book's text, when there is one and it lies within `page`;
 * null for none, a collapsed one, or one that reaches outside the page. An end that falls
 * outside every paragraph (in a chapter heading, say) is moved to the edge of the nearest
 * paragraph the selection covers.
 */
export function selectionRange(page: HTMLElement): TextRange | null {
  const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!page.contains(range.commonAncestorContainer)) return null
  let first: HTMLElement | null = null
  let last: HTMLElement | null = null
  for (const para of page.querySelectorAll<HTMLElement>('.para[data-para]')) {
    if (!range.intersectsNode(para)) continue
    if (first === null) first = para
    last = para
  }
  if (first === null || last === null) return null
  return {
    start: { para: Number(first.dataset.para), offset: offsetIn(first, range.startContainer, range.startOffset, 0) },
    end: { para: Number(last.dataset.para), offset: offsetIn(last, range.endContainer, range.endOffset, last.textContent?.length ?? 0) },
  }
}

/** How many characters of `para` come before the point (`node`, `offset`); `fallback` when the point is not in it. */
function offsetIn(para: HTMLElement, node: Node, offset: number, fallback: number): number {
  if (!para.contains(node)) return fallback
  const before = document.createRange()
  before.selectNodeContents(para)
  before.setEnd(node, offset)
  return before.toString().length
}

/** Whether a non-empty selection lies within `page`. */
export function hasSelection(page: HTMLElement | null): boolean {
  return page !== null && selectionRange(page) !== null
}

/** Select the whole of an element's text: the word a held pointer or a right-click is on. */
export function selectElement(el: Element): void {
  const selection = window.getSelection()
  if (selection === null) return
  const range = document.createRange()
  range.selectNodeContents(el)
  selection.removeAllRanges()
  selection.addRange(range)
}

/** Drop the selection, unless the caret is in a field (clearing it there would take the caret away). */
export function clearSelection(): void {
  if (isEditing()) return
  window.getSelection()?.removeAllRanges()
}

/** Whether the focus is in a text field: the selection is then the field's, not the page's. */
export function isEditing(): boolean {
  const el = document.activeElement
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
}

/** The viewport rectangle of the selection, for keeping it clear of the card; null when there is none. */
export function selectionRect(): { top: number; bottom: number } | null {
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null
  const rect = selection.getRangeAt(0).getBoundingClientRect()
  return rect.height === 0 && rect.width === 0 ? null : { top: rect.top, bottom: rect.bottom }
}
