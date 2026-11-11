/**
 * The aA menu (plan.md step 28, §1.8): Books' appearance popover, dropped from the aA button
 * in the top bar. A text-size stepper, the five themes as swatches, three line spacings, the
 * font list, and the Scroll / Paged switch §1.4 reserves (Paged is not in v1 and stays off).
 * Every change applies to the page behind at once and is saved by the Reader; nothing here is
 * confirmed. A tap outside or Escape closes it. The model is `reader/appearance.ts`.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import {
  type Appearance,
  canStepFontSize,
  FONTS,
  fontOf,
  LINE_SPACINGS,
  stepFontSize,
  THEMES,
} from './appearance.ts'
import './appearance.css'

interface Props {
  open: boolean
  value: Appearance
  onChange: (next: Appearance) => void
  onClose: () => void
}

export function AppearanceMenu({ open, value, onChange, onClose }: Props) {
  const [fontsOpen, setFontsOpen] = useState(false)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // The font list starts folded on every opening. Keyed on `open` alone: the parent re-renders
  // on every change made here, and a fresh `onClose` must not fold the list or re-lock the page.
  useEffect(() => {
    if (!open) return
    setFontsOpen(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open])

  if (!open) return null

  const set = <K extends keyof Appearance>(key: K, v: Appearance[K]) => onChange({ ...value, [key]: v })
  const font = fontOf(value.font)

  return (
    <div class="aa-backdrop" onClick={onClose}>
      <div class="aa-menu" role="dialog" aria-label="Appearance" onClick={(e) => e.stopPropagation()}>
        <div class="aa-size" role="group" aria-label="Text size">
          <button
            type="button"
            class="aa-size-btn aa-size-btn--small"
            aria-label="Smaller text"
            disabled={!canStepFontSize(value.size, -1)}
            onClick={() => set('size', stepFontSize(value.size, -1))}
          >
            A
          </button>
          <button
            type="button"
            class="aa-size-btn aa-size-btn--large"
            aria-label="Larger text"
            disabled={!canStepFontSize(value.size, 1)}
            onClick={() => set('size', stepFontSize(value.size, 1))}
          >
            A
          </button>
          <span class="aa-sr" role="status">
            Text size {value.size}
          </span>
        </div>

        <div class="aa-themes" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              type="button"
              key={t.key}
              role="radio"
              class={`aa-theme aa-theme--${t.key}`}
              aria-checked={value.theme === t.key}
              aria-label={t.label}
              title={t.label}
              onClick={() => set('theme', t.key)}
            >
              A
            </button>
          ))}
        </div>

        <div class="aa-spacing" role="radiogroup" aria-label="Line spacing">
          {LINE_SPACINGS.map((s, i) => (
            <button
              type="button"
              key={s.key}
              role="radio"
              class="aa-spacing-btn"
              aria-checked={value.spacing === s.key}
              aria-label={`${s.label} line spacing`}
              title={s.label}
              onClick={() => set('spacing', s.key)}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                {[0, 1, 2, 3].map((n) => {
                  const gap = [4, 5.5, 7][i]
                  const y = 12 + (n - 1.5) * gap
                  return <path key={n} d={`M4 ${y}h16`} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                })}
              </svg>
            </button>
          ))}
        </div>

        <button type="button" class="aa-fonts-toggle" aria-expanded={fontsOpen} onClick={() => setFontsOpen(!fontsOpen)}>
          <span>Font</span>
          <span class="aa-fonts-current" style={{ fontFamily: font.stack }}>
            {font.label}
          </span>
          <svg class="aa-chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        {fontsOpen && (
          <div class="aa-fonts" role="radiogroup" aria-label="Font">
            {FONTS.map((f) => (
              <button
                type="button"
                key={f.key}
                role="radio"
                class="aa-font"
                aria-checked={value.font === f.key}
                style={{ fontFamily: f.stack }}
                onClick={() => set('font', f.key)}
              >
                <span>{f.label}</span>
                {value.font === f.key && (
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}

        <div class="aa-layout" role="radiogroup" aria-label="Layout">
          <button type="button" role="radio" class="aa-layout-btn" aria-checked="true">
            Scroll
          </button>
          <button type="button" role="radio" class="aa-layout-btn" aria-checked="false" disabled title="Paged reading comes later">
            Paged
          </button>
        </div>
      </div>
    </div>
  )
}
