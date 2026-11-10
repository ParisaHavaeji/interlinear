import type { CoverColours } from '../store/db.ts'
import { coverStyle } from './cover.ts'

interface Props {
  title: string
  author: string
  colours: CoverColours
  /** CSS class on the outer element; the size comes from there. */
  class?: string
}

/** A generated cover: title and author set on the gradient, like Books' placeholder covers. */
export function Cover({ title, author, colours, class: cls }: Props) {
  return (
    <div class={`cover ${cls ?? ''}`} style={coverStyle(colours)} aria-hidden="true">
      <div class="cover-title">{title || 'Untitled'}</div>
      <div class="cover-author">{author}</div>
    </div>
  )
}
