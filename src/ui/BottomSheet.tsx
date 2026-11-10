import type { ComponentChildren } from 'preact'
import { useEffect } from 'preact/hooks'

interface Props {
  open: boolean
  onClose: () => void
  title?: string
  children: ComponentChildren
}

/**
 * Books-style bottom sheet: dimmed backdrop, rounded top corners, frosted background,
 * grabber. Tap outside or press Escape to dismiss. Mounted only while open so the
 * slide-up animation plays on each open.
 */
export function BottomSheet({ open, onClose, title, children }: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div
        class="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="sheet-grabber" aria-hidden="true" />
        {title && <h2 class="sheet-title">{title}</h2>}
        <div class="sheet-body">{children}</div>
      </div>
    </div>
  )
}
