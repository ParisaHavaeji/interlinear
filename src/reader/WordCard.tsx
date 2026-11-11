/**
 * The bottom card's content in word mode (plan.md step 24, §1.6): what a tap on a word opens.
 * The header shows the word as printed; the body the dictionary's best headword in full (the
 * article coloured by gender, the lemma, part of speech, plural, the English glosses, a line on
 * how the word was reached when that is not obvious, the sources), the other headwords as one-
 * line alternatives the reader can switch to, the sentence the word came from with the word
 * marked and a link to its translation (the sentence card of step 19), and the actions
 * (Bookmark, which saves or removes the word's bookmark (step 25) once the lookup has answered,
 * and shows filled while one exists; Copy). A word the dictionary lacks gets a plain "No entry"
 * with the dictionary's state when that explains it. The Reader owns the lookup, the bookmarks
 * and the state; this component draws a {@link WordCardView} from `reader/word.ts`.
 */

import { useEffect, useState } from 'preact/hooks'
import type { Lang } from '../import/types.ts'
import { BookmarkAction } from './SentenceCard.tsx'
import { articleColour, type Article, type ArticleColours, type WordCardView, type WordRef } from './word.ts'

interface HeaderProps {
  word: WordRef
  lang: Lang
}

export function WordCardHeader({ word, lang }: HeaderProps) {
  return (
    <div class="card-nav card-nav--word">
      <h2 class="card-title card-title--word" lang={lang}>
        {word.token}
      </h2>
    </div>
  )
}

interface BodyProps {
  word: WordRef
  /** The lookup's result; null while it runs. */
  view: WordCardView | null
  /** Why the lookup failed, when it did. */
  error: string | null
  /** The dictionary's state when it explains a missing entry ("still downloading"), else empty. */
  dictHint: string
  colours: ArticleColours
  /** Language of the original, for `lang` attributes. */
  lang: Lang
  /** The sentence the word is in, when known. */
  sentence: string | undefined
  /** Show another headword in full, by its index among the result's headwords. */
  onPick: (index: number) => void
  /** Switch the card to sentence mode for this word's sentence. */
  onShowSentence: () => void
  /** Copy the entry; resolves once on the clipboard. */
  onCopy: () => Promise<void>
  /** Whether this word is bookmarked (step 25). */
  bookmarked: boolean
  /** Add the bookmark, or remove it when `bookmarked`; absent until the lookup has answered. */
  onBookmark?: () => void
}

export function WordCardBody({ word, view, error, dictHint, colours, lang, sentence, onPick, onShowSentence, onCopy, bookmarked, onBookmark }: BodyProps) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  useEffect(() => setCopied(false), [word])

  const copy = async () => {
    try {
      await onCopy()
      setCopied(true)
    } catch (e) {
      console.error('copy failed', e)
    }
  }

  const articles = (list: Article[], cls: string) =>
    list.map((a, i) => (
      <>
        {i > 0 && <span class={cls}> / </span>}
        <span class={`${cls} word-article--${articleColour(a, colours)}`}>{a.text}</span>
      </>
    ))

  return (
    <>
      {error !== null ? (
        <p class="card-note card-note--lead card-note--error" role="alert">
          {error}
        </p>
      ) : view === null ? (
        <p class="card-note card-note--lead" aria-live="polite">
          Looking up…
        </p>
      ) : view.lemma === null ? (
        <p class="card-note card-note--lead" aria-live="polite">
          No entry for “{view.word === '' ? word.token : view.word}”.{dictHint === '' ? '' : ` ${dictHint}`}
        </p>
      ) : (
        <div class="word-entries" aria-live="polite">
          {view.entries.map((e) => (
            <div class="word-entry">
              <p class="word-head">
                {e.articles.length > 0 && <span lang={lang}>{articles(e.articles, 'word-article')} </span>}
                <span class="word-lemma" lang={lang}>
                  {e.lemma}
                </span>
                {(e.pos !== '' || e.note !== '' || e.plural !== null) && (
                  <span class="word-pos">
                    {[e.pos, e.note].filter((s) => s !== '').join(', ')}
                    {e.plural !== null && (
                      <>
                        {e.pos !== '' || e.note !== '' ? ' · ' : ''}pl.{' '}
                        <span lang={lang}>{e.plural}</span>
                      </>
                    )}
                  </span>
                )}
              </p>
              <ol class="word-glosses">
                {e.glosses.map((g) => (
                  <li>{g}</li>
                ))}
              </ol>
            </div>
          ))}
          {(view.via !== '' || view.sources !== '') && (
            <p class="word-meta">
              {view.via}
              {view.via !== '' && view.sources !== '' ? ' · ' : ''}
              {view.sources}
            </p>
          )}
        </div>
      )}
      {view !== null && view.alternatives.length > 0 && (
        <div class="word-alts">
          <span class="word-alts-label">Also</span>
          {view.alternatives.map((a) => (
            <button type="button" class="word-alt" onClick={() => onPick(a.index)}>
              <span class="word-alt-lemma" lang={lang}>
                {a.articles.length > 0 && <>{articles(a.articles, 'word-alt-article')} </>}
                {a.lemma}
              </span>
              {a.pos !== '' && <span class="word-alt-pos">{a.pos}</span>}
              {a.gloss !== '' && <span class="word-alt-gloss">{a.gloss}</span>}
            </button>
          ))}
        </div>
      )}
      {sentence !== undefined && (
        <p class="word-sentence">
          <span lang={lang}>{markWord(sentence, word)}</span>{' '}
          <button type="button" class="word-link" onClick={onShowSentence}>
            Show translation
          </button>
        </p>
      )}
      <div class="card-actions">
        <BookmarkAction bookmarked={bookmarked} onClick={onBookmark ?? (() => undefined)} disabled={onBookmark === undefined} />
        <button type="button" class="card-action" onClick={copy} disabled={view === null && error === null}>
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

/** The sentence with the tapped word marked, when it is where the reference says; plain otherwise. */
function markWord(sentence: string, word: WordRef) {
  const end = word.offset + word.token.length
  if (word.offset < 0 || end > sentence.length || sentence.slice(word.offset, end) !== word.token) return sentence
  return (
    <>
      {sentence.slice(0, word.offset)}
      <mark class="word-mark">{word.token}</mark>
      {sentence.slice(end)}
    </>
  )
}
