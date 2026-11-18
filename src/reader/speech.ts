/**
 * Reading the original aloud: the model behind the cards' Listen button (`Listen.tsx`), kept
 * apart from the DOM so it can be tested. It speaks with the browser's own speech synthesis,
 * which on a phone is the system voice: nothing to download, nothing sent anywhere, and it works
 * offline and in a copy added to the Home Screen.
 *
 * The browser's types are restated here in the little that is used, so this module typechecks
 * without the DOM library and a test can stand in for the synthesizer.
 *
 * Which voice: the utterance always carries its language tag, and the system picks its voice for
 * that language (on iOS the one chosen under Settings → Accessibility → Spoken Content). A voice
 * is named outright only when the list has a better-quality variant ("Enhanced", "Premium"),
 * which the system does not always prefer by itself. Picking by list order instead would land on
 * one of iOS's novelty voices as readily as on a proper one.
 */

import type { Lang } from '../import/types.ts'

export interface VoiceLike {
  name: string
  lang: string
}

export interface UtteranceLike {
  lang: string
  voice: VoiceLike | null
  onend: (() => void) | null
  onerror: (() => void) | null
}

export interface SynthLike {
  speak(utterance: UtteranceLike): void
  cancel(): void
  getVoices(): VoiceLike[]
  speaking?: boolean
  pending?: boolean
  addEventListener?(type: 'voiceschanged', listener: () => void): void
  removeEventListener?(type: 'voiceschanged', listener: () => void): void
}

export interface SpeechEngine {
  synth: SynthLike
  utter(text: string): UtteranceLike
}

/** The browser's speech synthesis, or null where there is none. */
export function browserSpeech(): SpeechEngine | null {
  const g = globalThis as unknown as { speechSynthesis?: SynthLike; SpeechSynthesisUtterance?: new (text: string) => UtteranceLike }
  const synth = g.speechSynthesis
  const Utterance = g.SpeechSynthesisUtterance
  if (synth === undefined || synth === null || typeof Utterance !== 'function') return null
  return { synth, utter: (text) => new Utterance(text) }
}

/** The tag an utterance in `lang` carries. */
export function speechLang(lang: Lang): string {
  return lang === 'de' ? 'de-DE' : 'en-US'
}

/** Whether a voice speaks `lang`, whatever the region and however the tag is written (`de-DE`, `de_AT`, `de`). */
function speaks(voice: VoiceLike, lang: Lang): boolean {
  return voice.lang.toLowerCase().split(/[-_]/)[0] === lang
}

/**
 * Whether `lang` can be read aloud with these voices. An empty list means the browser has not
 * said yet (Chrome fills it in a moment later, and says so with `voiceschanged`), which is not a
 * reason to hide the button; a list with no voice for the language is.
 */
export function canSpeak(voices: readonly VoiceLike[], lang: Lang): boolean {
  return voices.length === 0 || voices.some((v) => speaks(v, lang))
}

/**
 * The voice to name on an utterance in `lang`: the best of the better-quality variants, the
 * language's main region first; null when there is none, leaving the choice to the system.
 */
export function pickVoice(voices: readonly VoiceLike[], lang: Lang): VoiceLike | null {
  const tag = speechLang(lang).toLowerCase()
  let best: VoiceLike | null = null
  let bestScore = 0
  for (const v of voices) {
    if (!speaks(v, lang)) continue
    const quality = /premium/i.test(v.name) ? 2 : /enhanced/i.test(v.name) ? 1 : 0
    if (quality === 0) continue
    const score = quality * 2 + (v.lang.toLowerCase().replace('_', '-') === tag ? 1 : 0)
    if (score > bestScore) {
      best = v
      bestScore = score
    }
  }
  return best
}

/**
 * One thing read aloud at a time. `onChange` hears when speech starts and when it ends, however
 * it ends: read to the end, stopped, failed, or replaced by the next `speak`.
 */
export class Speaker {
  private readonly engine: SpeechEngine
  private readonly onChange: (speaking: boolean) => void
  /**
   * The utterance being spoken. Held on to for two reasons: Chrome drops an utterance nobody
   * references before its `end` arrives, and the events of one that was cancelled (they come
   * late, after the next has started) must not be taken for the current one's.
   */
  private current: UtteranceLike | null = null

  constructor(engine: SpeechEngine, onChange: (speaking: boolean) => void) {
    this.engine = engine
    this.onChange = onChange
  }

  get speaking(): boolean {
    return this.current !== null
  }

  /** Read `text` aloud in `lang`, in place of whatever is being read. */
  speak(text: string, lang: Lang): void {
    const { synth } = this.engine
    // Also clears a queue left stuck by something else (iOS, after the app was in the background).
    if (this.current !== null || synth.speaking === true || synth.pending === true) synth.cancel()
    const utterance = this.engine.utter(text)
    utterance.lang = speechLang(lang)
    const voice = pickVoice(synth.getVoices(), lang)
    if (voice !== null) utterance.voice = voice
    const done = () => {
      if (this.current !== utterance) return
      this.current = null
      this.onChange(false)
    }
    utterance.onend = done
    utterance.onerror = done
    this.current = utterance
    synth.speak(utterance)
    this.onChange(true)
  }

  /** Stop reading; nothing happens when nothing is being read. */
  stop(): void {
    if (this.current === null) return
    this.current = null
    this.engine.synth.cancel()
    this.onChange(false)
  }
}
