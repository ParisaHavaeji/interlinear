import { describe, expect, it } from 'vitest'
import {
  beadFeatures,
  cognateMatches,
  combinedCost,
  DEFAULT_WEIGHTS,
  fold,
  glossWords,
  isCognate,
  lcsLength,
  lexicalOverlap,
  MapLexicon,
  prepareSentence,
  punctuationShape,
  shapeOf,
  stemEn,
  tokenize,
  type PreparedSentence,
} from '../src/align/features.ts'

/** A toy dictionary covering the words the tests need. */
const lexicon = new MapLexicon([
  ['Morgen', ['morning', 'tomorrow']],
  ['unruhig', ['restless', 'troubled']],
  ['Traum', ['dream']],
  ['erwachen', ['to wake up', 'to awaken']],
  ['finden', ['to find']],
  ['Bett', ['bed']],
  ['ungeheuer', ['monstrous', 'horrible']],
  ['Ungeziefer', ['vermin', 'pest']],
  ['verwandeln', ['to transform', 'to change']],
  ['Zimmer', ['room']],
  ['Haus', ['house', 'home']],
  ['gehen', ['to go', 'to walk']],
  ['Mutter', ['mother']],
  ['klein', ['small', 'little']],
  ['Wand', ['wall']],
  ['vier', ['four']],
  ['liegen', ['to lie']],
  ['ruhig', ['quiet', 'peaceful', 'calm']],
])

const de = (text: string) => prepareSentence(text, 'de', lexicon)
const en = (text: string) => prepareSentence(text, 'en')
const ratio = 1.1

describe('tokenize', () => {
  it('separates words, numbers and punctuation and marks the sentence-initial word', () => {
    const t = tokenize('»Was ist mit mir geschehen?« dachte er.')
    expect(t.map((x) => x.text)).toEqual(['»', 'Was', 'ist', 'mit', 'mir', 'geschehen', '?«', 'dachte', 'er', '.'])
    expect(t.map((x) => x.kind)).toEqual([
      'punct', 'word', 'word', 'word', 'word', 'word', 'punct', 'word', 'word', 'punct',
    ])
    expect(t.filter((x) => x.initial).map((x) => x.text)).toEqual(['Was'])
    expect(t[1].start).toBe(1)
  })

  it('keeps apostrophes inside words and separators inside numbers, splits hyphens', () => {
    const t = tokenize("It wasn’t 3.000 armour-like dreams, Gregor's 1,5 times.")
    expect(t.filter((x) => x.kind !== 'punct').map((x) => x.text)).toEqual([
      'It', 'wasn’t', '3.000', 'armour', 'like', 'dreams', "Gregor's", '1,5', 'times',
    ])
    expect(t.find((x) => x.text === '3.000')?.kind).toBe('number')
  })
})

describe('stemEn and fold', () => {
  it('brings inflected forms and glosses to the same stem', () => {
    expect(stemEn('houses')).toBe(stemEn('house'))
    expect(stemEn('dreams')).toBe(stemEn('dream'))
    expect(stemEn('transformed')).toBe(stemEn('transform'))
    expect(stemEn('walking')).toBe(stemEn('walk'))
    expect(stemEn('quietly')).toBe(stemEn('quiet'))
    expect(stemEn('ladies')).toBe('lady')
    expect(stemEn("Gregor's")).toBe('gregor')
  })

  it('leaves short words and -ss / -us endings alone', () => {
    expect(stemEn('was')).toBe('was')
    expect(stemEn('glass')).toBe('glass')
    expect(stemEn('bus')).toBe('bus')
  })

  it('folds umlauts, ß and accents', () => {
    expect(fold('Häusern')).toBe('hausern')
    expect(fold('Straße')).toBe('strasse')
    expect(fold('Café')).toBe('cafe')
    expect(fold('Über')).toBe('uber')
  })
})

describe('glossWords and MapLexicon', () => {
  it('splits gloss phrases into stemmed content words without stopwords', () => {
    expect(glossWords(['to wake up', 'the house', 'to go away'])).toEqual(['wak', 'hous', 'go', 'away'])
  })

  it('finds lemmas behind inflected German forms by suffix stripping', () => {
    expect(lexicon.glosses('Träumen')).toEqual([]) // umlaut plurals are the dictionary's job
    expect(lexicon.glosses('Zimmers')).toEqual(['room'])
    expect(lexicon.glosses('kleines')).toEqual(['small', 'little'])
    expect(lexicon.glosses('Wänden')).toEqual([])
    expect(lexicon.glosses('Mutter')).toEqual(['mother'])
    expect(lexicon.glosses('erwachte')).toEqual(['to wake up', 'to awaken'])
    expect(lexicon.glosses('fand')).toEqual([])
    expect(lexicon.glosses('verwandelt')).toEqual(['to transform', 'to change'])
    expect(lexicon.glosses('ruhig')).toEqual(['quiet', 'peaceful', 'calm'])
  })

  it('never strips a word down to under three letters and returns nothing for unknown words', () => {
    expect(lexicon.glosses('Esse')).toEqual([])
    expect(lexicon.glosses('Xylophon')).toEqual([])
  })

  it('merges glosses added for the same lemma', () => {
    const l = new MapLexicon([['Haus', ['house']]])
    l.add('haus', ['home', 'house'])
    expect(l.glosses('Haus')).toEqual(['house', 'home'])
    expect(l.size).toBe(1)
  })
})

describe('prepareSentence', () => {
  it('drops stopwords and punctuation, folds content, and records numbers and names', () => {
    const p = de('Gregors Blick richtete sich dann 1912 zum Fenster, und Samsa war Reisender.')
    expect(p.content).toEqual(['gregors', 'blick', 'richtete', '1912', 'fenster', 'samsa', 'reisender'])
    expect(p.numbers).toEqual(['1912'])
    expect(p.capitalised).toEqual(new Set(['blick', 'fenster', 'samsa', 'reisender']))
    expect(p.chars).toBe(75)
    expect(p.lang).toBe('de')
  })

  it('attaches stemmed gloss words to German tokens and stems to English ones', () => {
    const d = de('Das kleine Zimmer.')
    expect(d.content).toEqual(['kleine', 'zimmer'])
    expect(d.glosses).toEqual([['small', 'littl'], ['room']])
    const e = en('The small rooms.')
    expect(e.content).toEqual(['small', 'rooms'])
    expect(e.stems).toEqual(['small', 'room'])
    expect(e.glosses).toEqual([[], []])
  })

  it('does not mark the sentence-initial word as a name', () => {
    expect(en('Gregor looked at Samsa.').capitalised).toEqual(new Set(['samsa']))
  })
})

describe('shapeOf and punctuationShape', () => {
  it('reads the terminal mark through closing quotes, the opening quote and colons', () => {
    expect(shapeOf('»Was ist mit mir geschehen?« dachte er.')).toEqual({ terminal: '.', quoted: true, colon: false })
    expect(shapeOf('“What’s happened to me?”')).toEqual({ terminal: '?', quoted: true, colon: false })
    expect(shapeOf('Er rief: »Nein!«')).toEqual({ terminal: '!', quoted: false, colon: true })
    expect(shapeOf('Doch...')).toEqual({ terminal: '…', quoted: false, colon: false })
    expect(shapeOf('Und dann…')).toEqual({ terminal: '…', quoted: false, colon: false })
    expect(shapeOf('Zwei Welten')).toEqual({ terminal: '', quoted: false, colon: false })
  })

  it('scores agreement in thirds, using the first sentence for quotes and the last for the terminal', () => {
    expect(punctuationShape([de('Es war kein Traum.')], [en('It wasn’t a dream.')])).toBe(1)
    expect(punctuationShape([de('War es ein Traum?')], [en('It wasn’t a dream.')])).toBeCloseTo(2 / 3)
    expect(punctuationShape([de('»Nein«, sagte er: nie.')], [en('No.')])).toBeCloseTo(1 / 3)
    expect(punctuationShape([de('»Nein.«'), de('Er ging?')], [en('“No.”'), en('Did he go?')])).toBe(1)
    expect(punctuationShape([], [en('No.')])).toBe(0)
  })
})

describe('lexicalOverlap', () => {
  it('counts each German token once against an unclaimed English stem and takes Dice', () => {
    const d = de('Das kleine Zimmer und das kleine Haus.')
    const e = en('The small room and the little house.')
    // de content: kleine, zimmer, kleine, haus (4); en: small, room, little, house (4); all four hit.
    expect(lexicalOverlap([d], [e])).toBe(1)
  })

  it('does not let one English word satisfy two German words', () => {
    const d = de('Haus Haus Haus')
    const e = en('house')
    expect(lexicalOverlap([d], [e])).toBeCloseTo((2 * 1) / 4)
  })

  it('is zero without a lexicon or with unknown words', () => {
    expect(lexicalOverlap([prepareSentence('Das kleine Zimmer.', 'de')], [en('The small room.')])).toBe(0)
    expect(lexicalOverlap([de('Xylophon Quark.')], [en('The small room.')])).toBe(0)
    expect(lexicalOverlap([], [en('The small room.')])).toBe(0)
  })

  it('matches inflected forms on both sides through lemmatising and stemming', () => {
    const d = de('Die Mutter fand ruhig vier Zimmers.')
    const e = en('Mother quietly found four rooms.')
    // mutter→mother, ruhig→quiet(ly), zimmers→room(s): 3 hits; 'vier'→four is a stopword? no: 'vier' is content.
    // de content: mutter, fand, ruhig, vier, zimmers (5); en: mother, quietly, found, four, rooms (5)
    expect(lexicalOverlap([d], [e])).toBeCloseTo((2 * 4) / 10)
  })

  it('pools the words of both sentences in a 1-2 bead', () => {
    const d = de('Das kleine Zimmer lag ruhig zwischen vier Wänden.')
    const e1 = en('The small room lay peacefully.')
    const e2 = en('It had four walls.')
    expect(lexicalOverlap([d], [e1, e2])).toBeGreaterThan(lexicalOverlap([d], [e1]))
  })
})

describe('cognates', () => {
  it('computes LCS lengths', () => {
    expect(lcsLength('mutter', 'mother')).toBe(4)
    expect(lcsLength('', 'abc')).toBe(0)
    expect(lcsLength('nation', 'nation')).toBe(6)
  })

  it('judges cognates by length, first letter and LCS ratio', () => {
    expect(isCognate('mutter', 'mother')).toBe(true)
    expect(isCognate('nation', 'nation')).toBe(true)
    expect(isCognate('illustrierten', 'illustrated')).toBe(true)
    expect(isCognate('melancholisch', 'melancholy')).toBe(true)
    expect(isCognate('haus', 'house')).toBe(false) // too short to trust
    expect(isCognate('wird', 'word')).toBe(false)
    expect(isCognate('vater', 'father')).toBe(false) // different first letter
    expect(isCognate('fenster', 'window')).toBe(false)
  })

  it('matches numbers, identical names (with German genitive -s) and cognates one-to-one', () => {
    const d = de('Gregors Blick richtete sich 1912 zum Fenster, das Bild war aus einer illustrierten Zeitschrift.')
    const e = en('In 1912 Gregor turned to the window; the picture was from an illustrated magazine.')
    const m = cognateMatches([d], [e])
    expect(m.numbers).toBe(1)
    expect(m.identical).toBe(1)
    expect(m.names).toBe(1)
    expect(m.cognates).toBe(1)
    // de content: gregors, blick, richtete, 1912, fenster, bild, illustrierten, zeitschrift (8)
    // en content: 1912, gregor, turned, window, picture, illustrated, magazine (7)
    expect(m.score).toBeCloseTo((2 * 3) / 15)
  })

  it('does not count a sentence-initial English word as a name but still as identical', () => {
    const m = cognateMatches([de('Samsa war Reisender.')], [en('Samsa was a salesman.')])
    expect(m.identical).toBe(1)
    expect(m.names).toBe(0)
  })

  it('claims identical twins before lookalikes', () => {
    const m = cognateMatches([de('Nation Nationen')], [en('nation nation')])
    expect(m.identical).toBe(1)
    expect(m.cognates).toBe(1)
    expect(m.score).toBe(1)
  })

  it('is zero on an empty side', () => {
    expect(cognateMatches([], [en('Gregor.')]).score).toBe(0)
  })
})

describe('beadFeatures and combinedCost', () => {
  const kafkaDe = de(
    'Als Gregor Samsa eines Morgens aus unruhigen Träumen erwachte, fand er sich in seinem Bett zu einem ungeheueren Ungeziefer verwandelt.',
  )
  const kafkaEn = en(
    'One morning, when Gregor Samsa woke from troubled dreams, he found himself transformed in his bed into a horrible vermin.',
  )
  const otherDe = de('»Was ist mit mir geschehen?« dachte er.')
  const otherEn = en('“What’s happened to me?” he thought.')

  it('reports all four signals for a true pair', () => {
    const f = beadFeatures([kafkaDe], [kafkaEn], { ratio })
    expect(f.length).toBeGreaterThan(0)
    expect(f.length).toBeLessThan(2)
    expect(f.lexical).toBeGreaterThan(0.3)
    expect(f.cognate).toBeGreaterThan(0.1) // Gregor, Samsa
    expect(f.punctuation).toBe(1)
  })

  it('prices the true pairing below the crossed pairing and below dropping a sentence', () => {
    const good = combinedCost(beadFeatures([kafkaDe], [kafkaEn], { ratio })) + combinedCost(beadFeatures([otherDe], [otherEn], { ratio }))
    const crossed = combinedCost(beadFeatures([kafkaDe], [otherEn], { ratio })) + combinedCost(beadFeatures([otherDe], [kafkaEn], { ratio }))
    const merged = combinedCost(beadFeatures([kafkaDe, otherDe], [kafkaEn], { ratio })) + combinedCost(beadFeatures([], [otherEn], { ratio }))
    expect(good).toBeLessThan(crossed)
    expect(good).toBeLessThan(merged)
  })

  it('gives a one-sided bead the deletion cost and zero overlap', () => {
    const f = beadFeatures([otherDe], [], { ratio })
    expect(f).toEqual({ length: otherDe.chars / 100, lexical: 0, cognate: 0, punctuation: 0 })
    expect(beadFeatures([otherDe], [], { ratio, deletionScale: 50 }).length).toBe(otherDe.chars / 50)
    expect(combinedCost(f)).toBe(f.length + DEFAULT_WEIGHTS.lexical + DEFAULT_WEIGHTS.cognate + DEFAULT_WEIGHTS.punctuation)
  })

  it('applies custom weights', () => {
    const f = { length: 1, lexical: 0.5, cognate: 0, punctuation: 1 }
    expect(combinedCost(f, { lexical: 2, cognate: 4, punctuation: 1 })).toBe(1 + 1 + 4 + 0)
  })

  it('works on a 2-2 bead by pooling both sides', () => {
    const f = beadFeatures([kafkaDe, otherDe], [kafkaEn, otherEn], { ratio })
    expect(f.lexical).toBeGreaterThan(0.2)
    expect(f.punctuation).toBe(1)
  })

  it('never returns NaN for sentences made only of stopwords', () => {
    const d: PreparedSentence = de('Er war es.')
    const e = en('It was he.')
    const f = beadFeatures([d], [e], { ratio })
    expect(Number.isNaN(f.lexical)).toBe(false)
    expect(f.lexical).toBe(0)
    expect(f.cognate).toBe(0)
  })
})
