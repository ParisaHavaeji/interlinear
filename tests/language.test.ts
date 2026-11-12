// Which language a picked file is in (plan.md step 33): the package code, the function words, and what the two picks together mean.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { guessLanguage, languageFromCode, languageFromText, languageMismatch } from '../src/import/language.ts'

const paragraphsOf = (file: string) =>
  readFileSync(`tests/fixtures/${file}`, 'utf8')
    .split(/\n\s*\n/)
    .map((text) => ({ text }))

describe('languageFromCode', () => {
  it('reads the primary subtag, in any case', () => {
    expect(languageFromCode('de')).toBe('de')
    expect(languageFromCode('de-DE')).toBe('de')
    expect(languageFromCode('en-us')).toBe('en')
    expect(languageFromCode(' EN ')).toBe('en')
  })

  it('leaves other languages and nothing undecided', () => {
    expect(languageFromCode('fr')).toBeNull()
    expect(languageFromCode('und')).toBeNull()
    expect(languageFromCode('')).toBeNull()
    expect(languageFromCode(null)).toBeNull()
    expect(languageFromCode(undefined)).toBeNull()
  })
})

describe('languageFromText', () => {
  it('tells the two fixtures apart', () => {
    expect(languageFromText(paragraphsOf('kafka-verwandlung.de.txt'))).toBe('de')
    expect(languageFromText(paragraphsOf('kafka-verwandlung.en.txt'))).toBe('en')
    expect(languageFromText(paragraphsOf('goethe-werther.de.txt'))).toBe('de')
    expect(languageFromText(paragraphsOf('goethe-werther.en.txt'))).toBe('en')
  })

  it('decides from a few paragraphs', () => {
    expect(languageFromText([{ text: 'Als Gregor Samsa eines Morgens aus unruhigen Träumen erwachte, fand er sich in seinem Bett zu einem ungeheueren Ungeziefer verwandelt. Er lag auf seinem panzerartig harten Rücken und sah, wenn er den Kopf ein wenig hob, seinen gewölbten, braunen, von bogenförmigen Versteifungen geteilten Bauch, auf dessen Höhe sich die Bettdecke, zum gänzlichen Niedergleiten bereit, kaum noch erhalten konnte. Seine vielen, im Vergleich zu seinem sonstigen Umfang kläglich dünnen Beine flimmerten ihm hilflos vor den Augen. Was ist mit mir geschehen, dachte er. Es war kein Traum.' }])).toBe('de')
  })

  it('is undecided on too little, or on a text that is neither', () => {
    expect(languageFromText([{ text: 'Die Verwandlung' }])).toBeNull()
    expect(languageFromText([])).toBeNull()
    expect(languageFromText([{ text: 'Je ne sais pas ce que je dois faire de tout cela, mais il faut que je le fasse pour les enfants et pour la maison que nous avons achetée avec le peu que nous avions. '.repeat(20) }])).toBeNull()
  })
})

describe('guessLanguage', () => {
  it('believes a German or English package code over the words', () => {
    expect(guessLanguage({ paragraphs: paragraphsOf('kafka-verwandlung.en.txt'), meta: { language: 'de' } })).toBe('de')
  })

  it('falls back to the words for plain text and other codes', () => {
    expect(guessLanguage({ paragraphs: paragraphsOf('kafka-verwandlung.en.txt'), meta: null })).toBe('en')
    expect(guessLanguage({ paragraphs: paragraphsOf('kafka-verwandlung.de.txt'), meta: { language: 'und' } })).toBe('de')
  })
})

describe('languageMismatch', () => {
  it('names the slot that holds the other language, or both when swapped', () => {
    expect(languageMismatch('en', 'de')).toBe('swapped')
    expect(languageMismatch('en', 'en')).toBe('de')
    expect(languageMismatch('en', null)).toBe('de')
    expect(languageMismatch('de', 'de')).toBe('en')
    expect(languageMismatch(null, 'de')).toBe('en')
  })

  it('is quiet when the picks fit or nothing can be told', () => {
    expect(languageMismatch('de', 'en')).toBeNull()
    expect(languageMismatch(null, null)).toBeNull()
    expect(languageMismatch('de', null)).toBeNull()
    expect(languageMismatch(null, 'en')).toBeNull()
  })
})
