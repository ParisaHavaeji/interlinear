/**
 * The bottom card's content in sentence mode (plan.md step 19, §1.5): the chapter name between
 * Previous / Next arrows in the fixed header, then the English sentence(s) of the tapped bead in
 * the reading font, a note with the neighbouring English sentences when the match is uncertain
 * or missing, and the actions (Bookmark, which waits for step 25; Copy). The Reader owns the
 * highlight and the stepping; this component only draws what `reader/card.ts` worked out.
 */

import { useEffect, useState } from 'preact/hooks'
import type { Lang } from '../import/types.ts'
import type { SentenceCard as Model } from './card.ts'

interface Props {
  card: Model
  /** The chapter's heading, shown as the card's title. */
  heading: string
  /** Language of the translation, for `lang` attributes. */
  lang: Lang
  /** Text of an English sentence by id; undefined when it is gone. */
  text: (idx: number) => string | undefined
  /** Step to the previous or next sentence; absent at the ends of the chapter. */
  onPrev?: () => void
  onNext?: () => void
  /** Copy the sentence and its translation; resolves once on the clipboard. */
  onCopy: () => Promise<void>
}

export function SentenceCardHeader({ heading, onPrev, onNext }: Pick<Props, 'heading' | 'onPrev' | 'onNext'>) {
  return (
    <div class="card-nav">
      <button type="button" class="card-arrow" aria-label="Previous sentence" disabled={onPrev === undefined} onClick={onPrev}>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <h2 class="card-title">{heading}</h2>
      <button type="button" class="card-arrow" aria-label="Next sentence" disabled={onNext === undefined} onClick={onNext}>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
  )
}

export function SentenceCardBody({ card, lang, text, onCopy }: Pick<Props, 'card' | 'lang' | 'text' | 'onCopy'>) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  // A new sentence resets the button.
  useEffect(() => setCopied(false), [card])

  const translation = card.translation.map(text).filter((t): t is string => t !== undefined)
  const before = card.before === null ? undefined : text(card.before)
  const after = card.after === null ? undefined : text(card.after)
  const showContext = card.status === 'uncertain' || card.status === 'unmatched'

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
      {card.status === 'unaligned' ? (
        <p class="card-note card-note--lead">This sentence is not aligned with the translation.</p>
      ) : (
        <p class="card-text" lang={lang} aria-live="polite">
          {showContext && before !== undefined && <span class="card-context">{before} </span>}
          {translation.length > 0 && <span class="card-main">{translation.join(' ')}</span>}
          {showContext && after !== undefined && <span class="card-context"> {after}</span>}
        </p>
      )}
      {card.status === 'uncertain' && (
        <p class="card-note">Uncertain match: the translation may run into the greyed sentences on either side.</p>
      )}
      {card.status === 'unmatched' && (
        <p class="card-note">No matching sentence in the translation. The text around where it would be is shown.</p>
      )}
      <div class="card-actions">
        <button type="button" class="card-action" disabled title="Bookmarks: coming soon">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M6.5 3.5h11v17l-5.5-4.5-5.5 4.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
          </svg>
          Bookmark
        </button>
        <button type="button" class="card-action" onClick={copy} disabled={card.status === 'unaligned'}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <rect x="8" y="8" width="11" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2" />
            <path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="2" />
          </svg>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </>
  )
}
