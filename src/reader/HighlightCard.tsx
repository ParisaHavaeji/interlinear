/**
 * The bottom card's content in highlight mode: what holding on the page and selecting text
 * opens. The selected text, the highlighter's colours, a note, and Copy / Remove.
 *
 * The card opens on a selection that is not saved yet: a tap on a colour saves it as a
 * highlight in that colour, and so does starting a note (in the colour used last). Opened on a
 * highlight that exists (a selection inside one, a right-click on one, a jump from the
 * bookmarks screen) the same controls change it. The note is kept as it is typed: saved a
 * moment after the last keystroke, and at once when the field is left or the card goes.
 *
 * The Reader owns the selection and the rows (`bookmarks/highlights.ts`, `reader/selection.ts`);
 * this component only draws them and reports what was tapped or typed.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import { HIGHLIGHT_COLOURS, type HighlightColour } from '../bookmarks/highlights.ts'
import type { Lang } from '../import/types.ts'

interface Props {
  /** The highlighted (or selected) text. */
  text: string
  lang: Lang
  /** The highlight's colour; null while the selection is not saved yet. */
  colour: HighlightColour | null
  /** The note as stored when the card opened on this highlight. */
  note: string
  /** The highlight exists: its note can be saved and it can be removed. */
  saved: boolean
  /** A colour was tapped: save the selection in it, or recolour the highlight. */
  onColour: (colour: HighlightColour) => void
  /** The note field was entered while nothing is saved yet: save the selection so the note has a home. */
  onStartNote: () => void
  /** The note changed; only called once `saved`. */
  onNote: (note: string) => void
  onCopy: () => Promise<void>
  /** Remove the highlight, or drop the selection. */
  onRemove: () => void
}

/** The note is saved this long after the last keystroke. */
const NOTE_SAVE_MS = 600

export function HighlightCardHeader({ heading }: { heading: string }) {
  return (
    <div class="card-nav card-nav--word">
      <h2 class="card-title">{heading}</h2>
    </div>
  )
}

export function HighlightCardBody({ text, lang, colour, note, saved, onColour, onStartNote, onNote, onCopy, onRemove }: Props) {
  const [value, setValue] = useState(note)
  /** The note as last handed to `onNote` (or as it was stored). */
  const sent = useRef(note)
  const latest = useRef({ value, saved, onNote })
  latest.current = { value, saved, onNote }

  const flush = () => {
    const now = latest.current
    if (!now.saved || now.value === sent.current) return
    sent.current = now.value
    now.onNote(now.value)
  }
  // A moment after the last keystroke, and as soon as a note begun on a fresh selection has a row.
  useEffect(() => {
    if (!saved || value === sent.current) return
    const timer = setTimeout(flush, NOTE_SAVE_MS)
    return () => clearTimeout(timer)
  }, [value, saved])
  // The card closing, or moving on to another highlight, keeps what was typed.
  useEffect(() => flush, [])

  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = async () => {
    try {
      await onCopy()
      setCopied(true)
    } catch (e) {
      console.error('copy failed', e)
    }
  }

  return (
    <>
      <p class={colour === null ? 'hl-quote' : `hl-quote hl-quote--${colour}`} lang={lang}>
        {text}
      </p>
      <div class="hl-swatches" role="group" aria-label="Highlight colour">
        {HIGHLIGHT_COLOURS.map((c) => (
          <button
            type="button"
            key={c}
            class={`hl-swatch hl-swatch--${c}`}
            aria-label={`Highlight in ${c}`}
            title={c[0].toUpperCase() + c.slice(1)}
            aria-pressed={colour === c}
            onClick={() => onColour(c)}
          />
        ))}
      </div>
      <textarea
        class="hl-note"
        rows={2}
        placeholder="Add a note"
        aria-label="Note"
        value={value}
        onFocus={() => {
          if (!saved) onStartNote()
        }}
        onInput={(e) => setValue((e.currentTarget as HTMLTextAreaElement).value)}
        onBlur={flush}
      />
      <div class="card-actions">
        <button type="button" class="card-action" onClick={copy}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <rect x="8" y="8" width="11" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2" />
            <path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="2" />
          </svg>
          {copied ? 'Copied' : 'Copy'}
        </button>
        {saved && (
          <button type="button" class="card-action card-action--danger" onClick={onRemove}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M5 7h14M10 7V4.5h4V7M7 7l1 12.5h8L17 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            Remove
          </button>
        )}
      </div>
    </>
  )
}
