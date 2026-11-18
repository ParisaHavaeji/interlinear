/**
 * The bottom card's content in sentence mode (plan.md step 19, §1.5): the chapter name between
 * Previous / Next arrows in the fixed header, then the English sentence(s) of the tapped bead in
 * the reading font, a note with the neighbouring English sentences when the match is uncertain
 * or missing, and the actions (Bookmark, which saves or removes the bead's bookmark (step 25)
 * and shows filled while one exists; Copy; and a "…" button whose menu holds Fix alignment,
 * which switches the card to the repair mode of step 20: the only way there, so the repair
 * never comes up unasked). The Reader owns the highlight, the stepping and the bookmarks; this
 * component only draws what `reader/card.ts` worked out.
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
  /** Whether the bead on the card is bookmarked (step 25). */
  bookmarked: boolean
  /** Add the bookmark, or remove it when `bookmarked`. */
  onBookmark: () => void
  /** Open the repair card for this sentence (step 20); absent when there is nothing to repair. */
  onFix?: () => void
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

export function SentenceCardBody({ card, lang, text, onCopy, bookmarked, onBookmark, onFix }: Pick<Props, 'card' | 'lang' | 'text' | 'onCopy' | 'bookmarked' | 'onBookmark' | 'onFix'>) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  /** The "…" menu is open: the rarely needed actions, kept out of the way until asked for. */
  const [more, setMore] = useState(false)
  // A new sentence resets the button and shuts the menu. By the sentences it is about: the
  // Reader hands over a fresh `card` object on every render of its own (the card growing when
  // the menu opens is one), which is not a new sentence.
  const sentenceKey = card.highlight.join(',')
  useEffect(() => {
    setCopied(false)
    setMore(false)
  }, [sentenceKey])

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
        <BookmarkAction bookmarked={bookmarked} onClick={onBookmark} />
        <button type="button" class="card-action" onClick={copy} disabled={card.status === 'unaligned'}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <rect x="8" y="8" width="11" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2" />
            <path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="2" />
          </svg>
          {copied ? 'Copied' : 'Copy'}
        </button>
        {onFix !== undefined && (
          <button
            type="button"
            class={more ? 'card-action card-action--icon card-action--on' : 'card-action card-action--icon'}
            aria-label="More"
            title="More"
            aria-expanded={more}
            onClick={() => setMore((m) => !m)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <circle cx="5" cy="12" r="2" fill="currentColor" />
              <circle cx="12" cy="12" r="2" fill="currentColor" />
              <circle cx="19" cy="12" r="2" fill="currentColor" />
            </svg>
          </button>
        )}
      </div>
      {more && onFix !== undefined && (
        <div class="card-menu" role="menu" aria-label="More">
          <button type="button" class="card-menu-item" role="menuitem" onClick={onFix}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M4 7h10M4 12h16M4 17h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              <path d="m17 5 2 2-2 2M17 15l2 2-2 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span class="card-menu-text">
              <span class="card-menu-label">Fix alignment</span>
              <span class="card-menu-detail">Change which part of the translation this sentence is matched with</span>
            </span>
          </button>
        </div>
      )}
    </>
  )
}

/** The Bookmark pill of both cards: a ribbon, filled while the bookmark exists; a tap toggles it. */
export function BookmarkAction({ bookmarked, onClick, disabled = false }: { bookmarked: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      class={bookmarked ? 'card-action card-action--on' : 'card-action'}
      aria-pressed={bookmarked}
      onClick={onClick}
      disabled={disabled}
      title={bookmarked ? 'Remove this bookmark' : 'Bookmark this'}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d="M6.5 3.5h11v17l-5.5-4.5-5.5 4.5z" fill={bookmarked ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
      </svg>
      {bookmarked ? 'Bookmarked' : 'Bookmark'}
    </button>
  )
}
