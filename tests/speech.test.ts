// Reading aloud (the cards' Listen button): the voice choice and the one-at-a-time speaker.
import { describe, expect, it } from 'vitest'
import { canSpeak, pickVoice, Speaker, speechLang, type SpeechEngine, type UtteranceLike, type VoiceLike } from '../src/reader/speech.ts'

const ANNA: VoiceLike = { name: 'Anna', lang: 'de-DE' }
const ANNA_ENHANCED: VoiceLike = { name: 'Anna (Enhanced)', lang: 'de-DE' }
const PETRA_PREMIUM: VoiceLike = { name: 'Petra (Premium)', lang: 'de-DE' }
const SAMANTHA_ENHANCED: VoiceLike = { name: 'Samantha (Enhanced)', lang: 'en-US' }

/** A synthesizer that records what it was asked and lets the test end utterances by hand. */
function fakeEngine(voices: VoiceLike[] = []) {
  const spoken: (UtteranceLike & { text: string })[] = []
  let cancels = 0
  const engine: SpeechEngine = {
    synth: {
      speak: (u) => void spoken.push(u as UtteranceLike & { text: string }),
      cancel: () => void cancels++,
      getVoices: () => voices,
    },
    utter: (text) => ({ text, lang: '', voice: null, onend: null, onerror: null }) as UtteranceLike,
  }
  return { engine, spoken, cancels: () => cancels }
}

describe('canSpeak', () => {
  it('holds while the voices are not known yet, and once one speaks the language', () => {
    expect(canSpeak([], 'de')).toBe(true)
    expect(canSpeak([SAMANTHA_ENHANCED, ANNA], 'de')).toBe(true)
    expect(canSpeak([{ name: 'Deutsch', lang: 'de_AT' }], 'de')).toBe(true)
  })

  it('fails when the voices are known and none speaks the language', () => {
    expect(canSpeak([SAMANTHA_ENHANCED], 'de')).toBe(false)
  })
})

describe('pickVoice', () => {
  it('leaves the choice to the system when there is no better-quality variant', () => {
    expect(pickVoice([], 'de')).toBeNull()
    expect(pickVoice([ANNA, { name: 'Grandma', lang: 'de-DE' }, SAMANTHA_ENHANCED], 'de')).toBeNull()
  })

  it('names the best variant of the language', () => {
    expect(pickVoice([ANNA, ANNA_ENHANCED, SAMANTHA_ENHANCED], 'de')).toBe(ANNA_ENHANCED)
    expect(pickVoice([ANNA_ENHANCED, PETRA_PREMIUM], 'de')).toBe(PETRA_PREMIUM)
    expect(pickVoice([ANNA_ENHANCED, SAMANTHA_ENHANCED], 'en')).toBe(SAMANTHA_ENHANCED)
  })

  it('prefers the main region among equals', () => {
    const austrian: VoiceLike = { name: 'Lena (Enhanced)', lang: 'de-AT' }
    expect(pickVoice([austrian, ANNA_ENHANCED], 'de')).toBe(ANNA_ENHANCED)
    expect(pickVoice([austrian], 'de')).toBe(austrian)
  })
})

describe('Speaker', () => {
  it('speaks in the language, with the better voice when there is one', () => {
    const { engine, spoken } = fakeEngine([ANNA, ANNA_ENHANCED])
    const states: boolean[] = []
    const speaker = new Speaker(engine, (s) => states.push(s))
    speaker.speak('Guten Morgen.', 'de')
    expect(spoken).toHaveLength(1)
    expect(spoken[0].text).toBe('Guten Morgen.')
    expect(spoken[0].lang).toBe(speechLang('de'))
    expect(spoken[0].voice).toBe(ANNA_ENHANCED)
    expect(states).toEqual([true])
    expect(speaker.speaking).toBe(true)
  })

  it('reports the end, whether read out or failed', () => {
    const { engine, spoken, cancels } = fakeEngine()
    const states: boolean[] = []
    const speaker = new Speaker(engine, (s) => states.push(s))
    speaker.speak('Eins.', 'de')
    spoken[0].onend?.()
    speaker.speak('Zwei.', 'de')
    spoken[1].onerror?.()
    expect(states).toEqual([true, false, true, false])
    expect(speaker.speaking).toBe(false)
    // Nothing was interrupted, so nothing was cancelled.
    expect(cancels()).toBe(0)
  })

  it('stops, once', () => {
    const { engine, cancels } = fakeEngine()
    const states: boolean[] = []
    const speaker = new Speaker(engine, (s) => states.push(s))
    speaker.stop()
    expect(cancels()).toBe(0)
    speaker.speak('Eins.', 'de')
    speaker.stop()
    speaker.stop()
    expect(cancels()).toBe(1)
    expect(states).toEqual([true, false])
  })

  it('replaces what is being read, and ignores the late end of what it replaced', () => {
    const { engine, spoken, cancels } = fakeEngine()
    const states: boolean[] = []
    const speaker = new Speaker(engine, (s) => states.push(s))
    speaker.speak('Eins.', 'de')
    speaker.speak('Zwei.', 'de')
    expect(cancels()).toBe(1)
    // The cancelled utterance's events arrive after the next one has started.
    spoken[0].onerror?.()
    spoken[0].onend?.()
    expect(speaker.speaking).toBe(true)
    expect(states).toEqual([true, true])
    spoken[1].onend?.()
    expect(states).toEqual([true, true, false])
  })

  it('clears a queue someone else left behind before speaking', () => {
    const { engine, cancels } = fakeEngine()
    engine.synth.pending = true
    new Speaker(engine, () => undefined).speak('Eins.', 'de')
    expect(cancels()).toBe(1)
  })
})
