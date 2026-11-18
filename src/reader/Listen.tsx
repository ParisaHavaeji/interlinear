/**
 * The cards' Listen button: a speaker pill that reads the original aloud with the device's own
 * voice (`speech.ts`), and stops it on a second tap. Reading stops by itself when the card moves
 * on to other text or closes, and when the app goes to the background, where iOS cuts speech off
 * anyway and can leave it stuck. The pill is absent where the browser cannot speak, or has no
 * voice for the language.
 */

import { useEffect, useMemo, useState } from 'preact/hooks'
import type { Lang } from '../import/types.ts'
import { browserSpeech, canSpeak, Speaker, type VoiceLike } from './speech.ts'

interface Props {
  /** What to read. */
  text: string
  /** Its language. */
  lang: Lang
}

export function ListenAction({ text, lang }: Props) {
  const engine = useMemo(browserSpeech, [])
  const [speaking, setSpeaking] = useState(false)
  const [voices, setVoices] = useState<VoiceLike[]>(() => engine?.synth.getVoices() ?? [])
  const speaker = useMemo(() => (engine === null ? null : new Speaker(engine, setSpeaking)), [engine])

  // Chrome loads its voices after the page and says so; Safari has them at once.
  useEffect(() => {
    if (engine === null) return
    const refresh = () => setVoices(engine.synth.getVoices())
    refresh()
    engine.synth.addEventListener?.('voiceschanged', refresh)
    return () => engine.synth.removeEventListener?.('voiceschanged', refresh)
  }, [engine])

  // Other text on the card, or the card gone: what was being read no longer belongs to it.
  useEffect(() => () => speaker?.stop(), [speaker, text, lang])

  useEffect(() => {
    if (speaker === null) return
    const stop = () => {
      if (document.visibilityState === 'hidden') speaker.stop()
    }
    document.addEventListener('visibilitychange', stop)
    return () => document.removeEventListener('visibilitychange', stop)
  }, [speaker])

  if (speaker === null || !canSpeak(voices, lang)) return null
  const label = speaking ? 'Stop reading' : 'Read aloud'
  return (
    <button
      type="button"
      class={speaking ? 'card-action card-action--icon card-action--on' : 'card-action card-action--icon'}
      aria-label={label}
      title={label}
      aria-pressed={speaking}
      disabled={text.trim() === ''}
      onClick={() => (speaking ? speaker.stop() : speaker.speak(text, lang))}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        {speaking ? (
          <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
        ) : (
          <>
            <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
            <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </>
        )}
      </svg>
    </button>
  )
}
