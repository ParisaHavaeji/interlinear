import type { CoverColours } from '../store/db.ts'
import { coverStyle } from './cover.ts'

interface Props {
  title: string
  author: string
  colours: CoverColours
  /** CSS class on the outer element; the size comes from there. */
  class?: string
  /**
   * Completion of a background job on this book, 0–1. When given, the cover is dimmed and
   * carries a thin progress line along its bottom, as Books does while a book downloads.
   */
  progress?: number
}

/** A generated cover: title and author set on the gradient, like Books' placeholder covers. */
export function Cover({ title, author, colours, class: cls, progress }: Props) {
  const busy = progress !== undefined
  const percent = busy ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : 0
  return (
    <div class={`cover ${busy ? 'cover--busy' : ''} ${cls ?? ''}`} style={coverStyle(colours)} aria-hidden="true">
      <div class="cover-title">{title || 'Untitled'}</div>
      <div class="cover-author">{author}</div>
      {busy && (
        <div class="cover-progress">
          <div class="cover-progress-bar" style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  )
}
