import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodeShard, isGzip, type DictShard } from '../src/dict/format.ts'
import { candidates, Dictionary, normalizeToken, particlesAfter, rankHeadwords, ShardCache, type Headword, type ShardLoader } from '../src/dict/lookup.ts'
import { DictionaryBuilder, encodeShards } from '../tools/build-dict/builder.ts'

// ---------------------------------------------------------------------------------------------
// A small dictionary in the shipped format, built with the step 21 tool and read back through
// the shipped decoder, so the lookup is tested against real shard bytes.

function fixture(): { files: Map<string, Buffer>; keys: string[] } {
  const b = new DictionaryBuilder()
  b.addWiktionary({ lemma: 'Haus', pos: 'noun', gender: 'n', plural: 'Häuser', glosses: ['house, building', 'home'], forms: ['Hauses', 'Häuser', 'Häusern', 'Hause'] })
  b.addWiktionary({ lemma: 'hausen', pos: 'verb', glosses: ['to dwell'], forms: ['haus', 'haust', 'hauste'] })
  b.addWiktionary({ lemma: 'Tür', pos: 'noun', gender: 'f', plural: 'Türen', glosses: ['door'], forms: ['Türen'] })
  b.addWiktionary({ lemma: 'Kind', pos: 'noun', gender: 'n', plural: 'Kinder', glosses: ['child'], forms: ['Kinder', 'Kindern', 'Kindes'] })
  b.addWiktionary({ lemma: 'Welt', pos: 'noun', gender: 'f', plural: 'Welten', glosses: ['world'], forms: ['Welten'] })
  b.addWiktionary({ lemma: 'Liebe', pos: 'noun', gender: 'f', glosses: ['love'], forms: ['Lieben'] })
  b.addWiktionary({ lemma: 'lieb', pos: 'adj', glosses: ['dear, kind'], forms: ['liebe', 'lieber', 'liebes'] })
  b.addWiktionary({ lemma: 'Brief', pos: 'noun', gender: 'm', plural: 'Briefe', glosses: ['letter'], forms: ['Briefe', 'Briefes', 'Briefen'] })
  b.addWiktionary({ lemma: 'Dampf', pos: 'noun', gender: 'm', glosses: ['steam'], forms: ['Dampfes'] })
  b.addWiktionary({ lemma: 'Schiff', pos: 'noun', gender: 'n', glosses: ['ship'], forms: ['Schiffe', 'Schiffes'] })
  b.addWiktionary({ lemma: 'Fahrt', pos: 'noun', gender: 'f', glosses: ['journey, trip'], forms: ['Fahrten'] })
  b.addWiktionary({ lemma: 'gehen', pos: 'verb', glosses: ['to go', 'to walk'], forms: ['ging', 'gegangen', 'gehst', 'geht'] })
  b.addWiktionary({ lemma: 'sehen', pos: 'verb', glosses: ['to see'], forms: ['sah', 'sieht', 'gesehen', 'sahen'] })
  b.addWiktionary({ lemma: 'ansehen', pos: 'verb', glosses: ['to look at'], forms: ['ansah', 'ansieht', 'angesehen'] })
  b.addWiktionary({ lemma: 'fangen', pos: 'verb', glosses: ['to catch'], forms: ['fing', 'fängt', 'gefangen'] })
  b.addWiktionary({ lemma: 'anfangen', pos: 'verb', glosses: ['to begin', 'to start'], forms: ['anfing', 'anfängt', 'angefangen', 'anzufangen'] })
  b.addWiktionary({ lemma: 'nachgehen', pos: 'verb', glosses: ['to pursue'], forms: ['nachging'] })
  b.addWiktionary({ lemma: 'müssen', pos: 'verb', glosses: ['must, to have to'], forms: ['musste', 'muss', 'gemusst'] })
  b.addWiktionary({ lemma: 'Weg', pos: 'noun', gender: 'm', plural: 'Wege', glosses: ['way, path'], forms: ['Wege', 'Wegen', 'Weges'] })
  b.addWiktionary({ lemma: 'weg', pos: 'adv', glosses: ['away'], forms: [] })
  b.addWiktionary({ lemma: 'an', pos: 'prep', glosses: ['on, at'], forms: [] })
  b.addWiktionary({ lemma: 'Arbeitnehmer', pos: 'noun', gender: 'm', glosses: ['employee'], forms: ['AN'] })
  b.addWiktionary({ lemma: 'nach', pos: 'prep', glosses: ['after, to'], forms: [] })
  b.addWiktionary({ lemma: 'zu', pos: 'prep', glosses: ['to'], forms: [] })
  b.addWiktionary({ lemma: 'Stadt', pos: 'noun', gender: 'f', plural: 'Städte', glosses: ['city, town'], forms: ['Städte', 'Städten'] })
  b.addWiktionary({ lemma: 'Straße', pos: 'noun', gender: 'f', glosses: ['street'], forms: ['Straßen'] })
  b.addWiktionary({ lemma: 'schwarz', pos: 'adj', glosses: ['black'], forms: ['schwarze'] })
  b.addWiktionary({ lemma: 'weiß', pos: 'adj', glosses: ['white'], forms: ['weiße'] })
  b.addWiktionary({ lemma: 'Öl', pos: 'noun', gender: 'n', glosses: ['oil'], forms: ['Öle'] })
  b.addWiktionary({ lemma: 'Farbe', pos: 'noun', gender: 'f', glosses: ['colour; paint'], forms: ['Farben'] })
  b.addWiktionary({ lemma: 'Prokurist', pos: 'noun', gender: 'm', glosses: ['authorised signatory'], forms: [] })
  b.addWiktionary({ lemma: 'es', pos: 'pron', glosses: ['it'], forms: [] })
  b.addWiktionary({ lemma: 'Linke', pos: 'noun', gender: 'f', glosses: ['left hand', 'the Left'], forms: ['Linken'] })
  b.addWiktionary({ lemma: 'link', pos: 'adj', glosses: ['left'], forms: ['linke', 'linken'] })
  b.addWiktionary({ lemma: 'lang', pos: 'adj', glosses: ['long'], forms: ['lange'] })
  b.addWiktionary({ lemma: 'Lange', pos: 'name', glosses: ['a surname'], forms: [] })
  b.addWiktionary({ lemma: 'hinaufkriechen', pos: 'verb', glosses: ['to creep up'], forms: ['hinaufkroch'] })
  b.addWiktionary({ lemma: 'anlangen', pos: 'verb', glosses: ['to arrive'], forms: ['anlange', 'anlangte'] })
  b.addWiktionary({ lemma: 'langen', pos: 'verb', glosses: ['to suffice; to reach'], forms: ['lange', 'langte'] })
  b.addWiktionary({ lemma: 'kommen', pos: 'verb', glosses: ['to come'], forms: ['kam', 'kommt'] })
  b.addWiktionary({ lemma: 'ankommen', pos: 'verb', glosses: ['to arrive'], forms: ['ankam', 'ankommt'] })
  b.addWiktionary({ lemma: 'laufen', pos: 'verb', glosses: ['to run'], forms: ['lief', 'läuft'] })
  b.addWiktionary({ lemma: 'kriechen', pos: 'verb', glosses: ['to creep'], forms: ['kroch', 'kriecht'] })
  b.addWiktionary({ lemma: 'hinunter', pos: 'adv', glosses: ['down'], forms: [] })
  b.addWiktionary({ lemma: 'Häusern', pos: 'name', gender: 'n', glosses: ['a municipality of Baden-Württemberg'], forms: [] })
  b.addWiktionary({ lemma: 'Kriechen', pos: 'noun', gender: 'n', glosses: ['creep (motion)'], forms: [] })
  b.addLinks([{ form: 'daß', lemma: 'dass' }])
  b.addWiktionary({ lemma: 'dass', pos: 'conj', glosses: ['that'], forms: [] })
  // FreeDict's inflected headwords and part-less entries.
  b.addFreeDict({ lemma: 'sah', pos: 'other', glosses: ['viewed'] })
  b.addFreeDict({ lemma: 'Städte', pos: 'noun', glosses: ['towns', 'cities'] })
  b.addFreeDict({ lemma: 'Omer', pos: 'noun', gender: 'm', glosses: ['omer (measure)'] })
  const { shards, stats } = b.build()
  const { files } = encodeShards(shards, stats, [])
  return { files, keys: [...shards.keys()] }
}

const { files, keys } = fixture()

/** Loads from the gzipped fixture files, counting; `missing` keys load as null. */
function loader(): { load: ShardLoader; count: () => number; asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    count: () => asked.length,
    load: async (key) => {
      asked.push(key)
      const gz = files.get(`${key}.json.gz`)
      return gz === undefined ? null : decodeShard(new Uint8Array(gz))
    },
  }
}

const dict = () => new Dictionary(loader().load)
const lemmas = (hs: Headword[]) => hs.map((h) => h.lemma)

// ---------------------------------------------------------------------------------------------

describe('decodeShard', () => {
  const shard: DictShard = { entries: { Haus: [{ lemma: 'Haus', pos: 'noun', glosses: ['house'], src: 'wikt' }] }, forms: { haus: ['Haus'] } }

  it('reads a shard whether it is still gzipped or already decoded', async () => {
    const json = Buffer.from(JSON.stringify(shard))
    expect(isGzip(new Uint8Array(gzipSync(json)))).toBe(true)
    expect(isGzip(new Uint8Array(json))).toBe(false)
    expect(await decodeShard(new Uint8Array(gzipSync(json)))).toEqual(shard)
    expect(await decodeShard(new Uint8Array(json))).toEqual(shard)
  })

  it('rejects bytes that are not a shard', async () => {
    await expect(decodeShard(new Uint8Array(Buffer.from('<html>')))).rejects.toThrow()
    await expect(decodeShard(new Uint8Array(Buffer.from('{"x":1}')))).rejects.toThrow(/not a dictionary shard/)
  })
})

describe('ShardCache', () => {
  it('loads a shard once, shares concurrent loads and remembers missing shards', async () => {
    const l = loader()
    const cache = new ShardCache(l.load, 4)
    const [a, b] = await Promise.all([cache.shard('ha'), cache.shard('ha')])
    expect(a).toBe(b)
    expect(a?.forms.haus).toEqual(['Haus', 'hausen'])
    expect(l.count()).toBe(1)
    await cache.shard('ha')
    expect(l.count()).toBe(1)
    expect(await cache.shard('qx')).toBeNull()
    expect(await cache.shard('qx')).toBeNull()
    expect(l.count()).toBe(2)
    expect(cache.loads).toBe(2)
  })

  it('drops the least recently used shard past its capacity', async () => {
    const l = loader()
    const cache = new ShardCache(l.load, 2)
    await cache.shard('ha')
    await cache.shard('tu')
    await cache.shard('ha') // touch: tu is now the oldest
    await cache.shard('ki')
    expect(cache.keys()).toEqual(['ha', 'ki'])
    await cache.shard('tu')
    expect(l.asked).toEqual(['ha', 'tu', 'ki', 'tu'])
    cache.clear()
    expect(cache.keys()).toEqual([])
  })
})

describe('normalizeToken / candidates', () => {
  it('strips quotes, punctuation and invisible characters around a word, keeping its case', () => {
    expect(normalizeToken('„Haus“,')).toBe('Haus')
    expect(normalizeToken('(Tür).')).toBe('Tür')
    expect(normalizeToken('»Weg!«')).toBe('Weg')
    expect(normalizeToken(' Stra­ße… ')).toBe('Straße')
    expect(normalizeToken('—')).toBe('')
    expect(normalizeToken('geht’s')).toBe('geht’s')
    expect(normalizeToken('Schwarz-Weiß')).toBe('Schwarz-Weiß')
  })

  it('offers the word, then without its clitic or zu-infix, then a hyphenated compound joined and its head', () => {
    expect(candidates('Haus')).toEqual(['Haus'])
    expect(candidates('geht’s')).toEqual(['geht’s', 'geht'])
    expect(candidates("Goethe's")).toEqual(["Goethe's", 'Goethe'])
    expect(candidates('hinaufzukriechen')).toEqual(['hinaufzukriechen', 'hinaufkriechen'])
    expect(candidates('anzufangen')).toEqual(['anzufangen', 'anfangen'])
    expect(candidates('Anzug')).toEqual(['Anzug'])
    expect(candidates('Schwarz-Weiß')).toEqual(['Schwarz-Weiß', 'SchwarzWeiß', 'Weiß'])
    expect(candidates('')).toEqual([])
  })
})

describe('Dictionary.lookup: exact and inflected forms', () => {
  it('finds a lemma by its exact spelling, by case and ß/ss, and by the inflection index', async () => {
    const d = dict()
    const haus = await d.lookup('Haus')
    expect(haus.word).toBe('Haus')
    expect(haus.headwords.map((h) => [h.lemma, h.via])).toEqual([
      ['Haus', 'exact'],
      ['hausen', 'form'],
    ])
    expect(haus.headwords[0].entries[0]).toMatchObject({ pos: 'noun', gender: 'n', plural: 'Häuser', glosses: ['house, building', 'home'] })

    expect((await d.lookup('HAUS')).headwords[0]).toMatchObject({ lemma: 'Haus', via: 'case' })
    // The municipality Häusern is an exact match, but a name; the dative plural of Haus wins.
    expect(lemmas((await d.lookup('Häusern')).headwords)).toEqual(['Haus', 'Häusern'])
    expect((await d.lookup('Häusern')).headwords[0].via).toBe('form')
    expect((await d.lookup('Strasse')).headwords[0]).toMatchObject({ lemma: 'Straße', via: 'case' })
    expect(lemmas((await d.lookup('mußte')).headwords)).toEqual(['müssen'])
    expect(lemmas((await d.lookup('daß')).headwords)).toEqual(['dass'])
  })

  it('normalises the tapped token and tries a clitic-free spelling', async () => {
    const d = dict()
    expect(lemmas((await d.lookup('„Haus“,')).headwords)).toEqual(['Haus', 'hausen'])
    const gehts = await d.lookup('geht’s')
    expect(gehts.word).toBe('geht’s')
    expect(lemmas(gehts.headwords)).toEqual(['gehen'])
    expect(lemmas((await d.lookup('hinaufzukriechen')).headwords)).toEqual(['hinaufkriechen'])
  })

  it('reads a form in one shard and its lemma in another', async () => {
    const l = loader()
    const d = new Dictionary(l.load)
    expect(lemmas((await d.lookup('ging')).headwords)).toEqual(['gehen'])
    expect(l.asked).toEqual(['gi', 'ge'])
  })

  it('returns no headwords for an unknown word, punctuation or an empty token', async () => {
    const d = dict()
    expect((await d.lookup('Sinclair')).headwords).toEqual([])
    expect(await d.lookup('—')).toEqual({ token: '—', word: '', headwords: [] })
    expect((await d.lookup('')).headwords).toEqual([])
  })

  it('answers a key with no shard without failing', async () => {
    const d = dict()
    expect(keys).not.toContain('qx')
    expect((await d.lookup('Qxyz')).headwords).toEqual([])
  })
})

describe('Dictionary.lookup: ranking', () => {
  it('puts the exactly spelled lemma first: Weg before weg, and the other way round', async () => {
    const d = dict()
    expect(lemmas((await d.lookup('Weg')).headwords)).toEqual(['Weg', 'weg'])
    expect(lemmas((await d.lookup('weg')).headwords)).toEqual(['weg', 'Weg'])
  })

  it('puts a Wiktionary lemma reached by inflection above a FreeDict headword for the form', async () => {
    const d = dict()
    // "sah" is in FreeDict as its own part-less headword ("viewed"); sehen is the answer.
    expect((await d.lookup('sah')).headwords.map((h) => [h.lemma, h.via])).toEqual([
      ['sehen', 'form'],
      ['sah', 'exact'],
    ])
    expect(lemmas((await d.lookup('Städte')).headwords)).toEqual(['Stadt', 'Städte'])
  })

  it('prefers a case-insensitive match to an abbreviation-only form', async () => {
    const d = dict()
    expect(lemmas((await d.lookup('An')).headwords)).toEqual(['an', 'Arbeitnehmer'])
  })

  it('never takes a lowercase word for a noun, and a capitalised word inside a sentence for anything else', async () => {
    const d = dict()
    // "linke" is a form of the adjective; die Linke only differs in case, which the word rules out.
    expect(lemmas((await d.lookup('linke')).headwords)).toEqual(['link', 'Linke'])
    expect(lemmas((await d.lookup('Linke')).headwords)).toEqual(['Linke', 'link'])
    // Opening a sentence, a capital says nothing, and the adjective outranks the surname.
    expect(lemmas((await d.lookup('Lange', { sentence: 'Lange sah er hin.' })).headwords)).toEqual(['lang', 'langen', 'Lange'])
    expect(lemmas((await d.lookup('Lange')).headwords)).toEqual(['lang', 'langen', 'Lange'])
    expect(lemmas((await d.lookup('lange', { sentence: 'Er sah lange hin.' })).headwords)).toEqual(['lang', 'langen', 'Lange'])
    // Inside a sentence the capital makes it the name.
    expect(lemmas((await d.lookup('Lange', { sentence: 'Herr Lange kam.' })).headwords)).toEqual(['Lange', 'lang', 'langen'])
    expect(lemmas((await d.lookup('Weg', { sentence: 'Der Weg war weit.' })).headwords)).toEqual(['Weg', 'weg'])
    expect(lemmas((await d.lookup('weg', { sentence: 'Er war weg.' })).headwords)).toEqual(['weg', 'Weg'])
  })

  it('is stable for equal ranks', () => {
    const e = (lemma: string): Headword => ({ lemma, entries: [{ lemma, pos: 'noun', glosses: ['x'], src: 'wikt' }], via: 'form' })
    expect(lemmas(rankHeadwords([e('b'), e('a'), e('c')]))).toEqual(['b', 'a', 'c'])
  })
})

describe('Dictionary.lookup: stem guess', () => {
  it('strips an ending the index lacks and marks the result uncertain', async () => {
    const d = dict()
    const r = await d.lookup('Prokuristen')
    expect(r.headwords.map((h) => [h.lemma, h.via])).toEqual([['Prokurist', 'stem']])
    expect(lemmas((await d.lookup('Omers')).headwords)).toEqual(['Omer'])
  })

  it('does not guess a stem that is not a content word or is too short', async () => {
    const d = dict()
    expect((await d.lookup('zus')).headwords).toEqual([])
    expect((await d.lookup('ans')).headwords).toEqual([])
  })
})

describe('Dictionary.lookup: compounds', () => {
  it('splits an unknown compound into known parts, the head being the headword', async () => {
    const d = dict()
    const r = await d.lookup('Haustür')
    expect(r.headwords).toHaveLength(1)
    const h = r.headwords[0]
    expect(h).toMatchObject({ lemma: 'Tür', via: 'compound' })
    expect(h.parts?.map((p) => [p.text, p.lemma])).toEqual([
      ['haus', 'Haus'],
      ['tür', 'Tür'],
    ])
    expect(h.entries[0].glosses).toEqual(['door'])
  })

  it('accepts a linking element and an inflected modifier', async () => {
    const d = dict()
    expect((await d.lookup('Liebesbrief')).headwords[0].parts?.map((p) => [p.text, p.lemma])).toEqual([
      ['liebes', 'Liebe'],
      ['brief', 'Brief'],
    ])
    expect((await d.lookup('Kinderwelt')).headwords[0].parts?.map((p) => [p.text, p.lemma])).toEqual([
      ['kinder', 'Kind'],
      ['welt', 'Welt'],
    ])
    expect((await d.lookup('Ölfarbe')).headwords[0].parts?.map((p) => p.lemma)).toEqual(['Öl', 'Farbe'])
  })

  it('takes a verb head for a lowercase compound and a noun head for a capitalised one', async () => {
    const d = dict()
    expect((await d.lookup('hinunterkriechen')).headwords[0]).toMatchObject({ lemma: 'kriechen', via: 'compound' })
    expect((await d.lookup('Hinunterkriechen')).headwords[0]).toMatchObject({ lemma: 'Kriechen', via: 'compound' })
  })

  it('cuts a compound of three parts', async () => {
    const d = dict()
    expect((await d.lookup('Dampfschifffahrt')).headwords[0].parts?.map((p) => p.lemma)).toEqual(['Dampf', 'Schiff', 'Fahrt'])
  })

  it('reads a hyphenated compound as a whole, else by its head', async () => {
    const d = dict()
    const r = await d.lookup('Schwarz-Weiß')
    expect(r.headwords[0]).toMatchObject({ lemma: 'weiß', via: 'compound' })
    expect(r.headwords[0].parts?.map((p) => p.lemma)).toEqual(['schwarz', 'weiß'])
  })

  it('does not invent a split whose modifier is unknown', async () => {
    const d = dict()
    // "Kromer" ends in "omer", a dictionary word, but "kr" is nothing.
    expect((await d.lookup('Kromer')).headwords).toEqual([])
    expect((await d.lookup('Xyztür')).headwords).toEqual([])
  })
})

describe('Dictionary.lookup: separable verbs', () => {
  it('lists the particles at the end of a clause after an offset', () => {
    expect(particlesAfter('Er fing sofort an, die Tür zu öffnen.', 3)).toEqual(['an'])
    expect(particlesAfter('Er fing an zu weinen.', 3)).toEqual(['an'])
    expect(particlesAfter('Er fing an', 3)).toEqual(['an'])
    expect(particlesAfter('Er ging nach Hause.', 3)).toEqual([])
    expect(particlesAfter('Er fing sofort an, die Tür zu öffnen.', 20)).toEqual([])
    // A particle in a later clause is not this verb's.
    expect(particlesAfter('Er sah, dass sie ging, und lief weg.', 3)).toEqual([])
    expect(particlesAfter('Er sah, dass sie ging, und lief weg.', 27)).toEqual(['weg'])
  })

  it('reads the clause from its start for the verb, and not past a clause break', async () => {
    const d = dict()
    // "lange" is a verb form too (anlange → anlangen); the finite verb comes first in the clause.
    expect(lemmas((await d.lookup('an', { sentence: 'Er sah den Vater lange an.' })).headwords)[0]).toBe('ansehen')
    expect(lemmas((await d.lookup('an', { sentence: 'Als er kam, sah er mich an.' })).headwords)[0]).toBe('ansehen')
    // "kam … an" would be ankommen, but "kam" is in the other clause.
    expect(lemmas((await d.lookup('an', { sentence: 'Als er kam, lief er an.' })).headwords)[0]).toBe('an')
  })

  it('reunites the tapped verb with its particle and keeps the plain verb as an alternative', async () => {
    const d = dict()
    const r = await d.lookup('fing', { sentence: 'Er fing sofort an, die Tür zu öffnen.' })
    expect(r.headwords.map((h) => [h.lemma, h.via, h.particle])).toEqual([
      ['anfangen', 'separable', 'an'],
      ['fangen', 'form', undefined],
    ])
    expect(r.headwords[0].entries.map((e) => e.pos)).toEqual(['verb'])
  })

  it('finds the verb when the particle is tapped, with or without the offset', async () => {
    const d = dict()
    // "lange" + an would be anlangen if the dictionary had it; the word before the particle
    // must be a verb form, so the search goes on back to "sah".
    const r = await d.lookup('an', { sentence: 'Er sah mich lange an.', offset: 17 })
    expect(r.headwords.map((h) => [h.lemma, h.via])).toEqual([
      ['ansehen', 'separable'],
      ['an', 'exact'],
      ['Arbeitnehmer', 'form'],
    ])
    // Without an offset the word is found as a whole word, not inside "lange".
    expect(lemmas((await d.lookup('an', { sentence: 'Er sah mich lange an.' })).headwords)).toEqual(['ansehen', 'an', 'Arbeitnehmer'])
    expect(lemmas((await d.lookup('an.', { sentence: 'Er sah mich lange an.' })).headwords)).toEqual(['ansehen', 'an', 'Arbeitnehmer'])
  })

  it('leaves a preposition before a noun phrase alone', async () => {
    const d = dict()
    expect(lemmas((await d.lookup('ging', { sentence: 'Er ging nach Hause.' })).headwords)).toEqual(['gehen'])
    expect(lemmas((await d.lookup('nach', { sentence: 'Er ging nach Hause.' })).headwords)).toEqual(['nach'])
  })

  it('does nothing without a sentence or when the sentence has no such pair', async () => {
    const d = dict()
    expect(lemmas((await d.lookup('fing')).headwords)).toEqual(['fangen'])
    expect(lemmas((await d.lookup('fing', { sentence: 'Er fing den Ball.' })).headwords)).toEqual(['fangen'])
  })
})
