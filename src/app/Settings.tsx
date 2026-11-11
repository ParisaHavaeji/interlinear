import { useEffect } from 'preact/hooks'
import { dictStateLabel, formatBytes, percentOf } from '../dict/download.ts'
import { ensureDictionary, useDictState } from '../dict/installer.ts'
import { ARTICLE_COLOURS, DEFAULT_ARTICLE_COLOURS, sanitizeArticleColours, type ArticleColour, type ArticleColours } from '../reader/word.ts'
import { ARTICLE_COLOURS_KEY, setSetting, useSetting } from '../store/settings.ts'
import './settings.css'

interface Props {
  onBack: () => void
}

const ARTICLE_ROWS: { gender: keyof ArticleColours; article: string }[] = [
  { gender: 'm', article: 'der' },
  { gender: 'f', article: 'die' },
  { gender: 'n', article: 'das' },
]

/**
 * Settings (plan.md step 23): the dictionary's place on this device, with the download's
 * progress, a Retry when it failed, and a check for a newer dictionary. Opening the screen also
 * starts the download when it has not started (a launch offline, say). Step 24 adds the colours
 * the word card gives der / die / das. Later steps add the reading preferences that are not in
 * the aA menu.
 */
export function Settings({ onBack }: Props) {
  const dict = useDictState()
  const colours = useSetting(ARTICLE_COLOURS_KEY, sanitizeArticleColours)
  const setColour = (gender: keyof ArticleColours, colour: ArticleColour) => void setSetting(ARTICLE_COLOURS_KEY, { ...colours, [gender]: colour })
  const customised = (['m', 'f', 'n'] as const).some((g) => colours[g] !== DEFAULT_ARTICLE_COLOURS[g])

  useEffect(() => {
    void ensureDictionary()
  }, [])

  const busy = dict.phase === 'checking' || dict.phase === 'downloading' || dict.checking
  const online = navigator.onLine !== false
  const percent = percentOf(dict.progress)
  const sources = dict.index?.sources.map((s) => (s.name === 'wiktionary' ? 'Wiktionary' : 'FreeDict') + (s.version === undefined ? '' : ` ${s.version}`)) ?? []

  return (
    <div class="screen">
      <header class="top-bar top-bar--settings">
        <button type="button" class="back-btn" aria-label="Back to Library" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M15 4.5 7.5 12l7.5 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          Library
        </button>
        <h1 class="large-title">Settings</h1>
      </header>

      <main class="content content--settings">
        <h2 class="group-title">Dictionary</h2>
        <div class="group">
          <div class={`row row--static row--settings ${dict.phase === 'failed' || dict.phase === 'unavailable' ? 'is-error' : ''}`}>
            <span class="row-label">German–English</span>
            <span class="row-detail" role="status" aria-live="polite">
              {dictStateLabel(dict)}
            </span>
            {dict.phase === 'failed' || dict.phase === 'unavailable' ? (
              <button type="button" class="row-remove" disabled={busy || !online} onClick={() => void ensureDictionary()}>
                Retry
              </button>
            ) : (
              <span />
            )}
            {dict.phase === 'downloading' && (
              <div class="row-progress" role="progressbar" aria-label="Dictionary download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                <div class="row-progress-bar" style={{ width: `${percent}%` }} />
              </div>
            )}
          </div>
        </div>
        <p class="group-footer">
          Word meanings come from Wiktionary and FreeDict
          {dict.progress === null ? '' : `, ${formatBytes(dict.progress.totalBytes)}`} downloaded once and kept on this device. Aligning a book uses the same
          dictionary, so it is fetched in the background the first time the app opens.
          {dict.phase === 'ready' && dict.index !== null && (
            <>
              {' '}
              Built {dict.index.built}
              {sources.length > 0 ? ` from ${sources.join(' and ')}` : ''}.{' '}
              {online && (
                <button type="button" class="link-btn" disabled={busy} onClick={() => void ensureDictionary()}>
                  Check for Updates
                </button>
              )}
            </>
          )}
        </p>

        <h2 class="group-title">Articles</h2>
        <div class="group">
          {ARTICLE_ROWS.map(({ gender, article }) => (
            <div class="row row--static row--swatches" key={gender}>
              <span class={`row-label article-label--${colours[gender]}`} lang="de">
                {article}
              </span>
              <div class="swatches" role="radiogroup" aria-label={`Colour of ${article}`}>
                {ARTICLE_COLOURS.map((c) => (
                  <button
                    type="button"
                    class={`swatch swatch--${c.key}`}
                    aria-label={c.label}
                    aria-pressed={colours[gender] === c.key}
                    title={c.label}
                    onClick={() => setColour(gender, c.key)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <p class="group-footer">
          The word card shows a noun’s article in these colours, so the gender is seen before it is read.{' '}
          {customised && (
            <button type="button" class="link-btn" onClick={() => void setSetting(ARTICLE_COLOURS_KEY, DEFAULT_ARTICLE_COLOURS)}>
              Reset
            </button>
          )}
        </p>
      </main>
    </div>
  )
}
