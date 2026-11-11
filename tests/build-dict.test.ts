import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { DICT_FORMAT, foldForm, shardFile, shardKey, type DictShard } from '../src/dict/format.ts'
import { DictionaryBuilder, encodeShards } from '../tools/build-dict/builder.ts'
import { decodeXml, parseTeiEntry, TeiEntrySplitter, teiTranslations } from '../tools/build-dict/freedict.ts'
import { MAX_GLOSS_LENGTH, parseWiktionaryLine, pickGender, pickGlosses, trimGloss } from '../tools/build-dict/wiktionary.ts'

// ---------------------------------------------------------------------------------------------
// Format

describe('foldForm / shardKey', () => {
  it('lowercases and folds ß to ss, keeping umlauts', () => {
    expect(foldForm('Straße')).toBe('strasse')
    expect(foldForm('STRASSE')).toBe('strasse')
    expect(foldForm(' Schön ')).toBe('schön')
    expect(foldForm('Maße')).toBe('masse')
  })

  it('shards by the first two ASCII-folded letters, padding with _', () => {
    expect(shardKey('Haus')).toBe('ha')
    expect(shardKey('Häusern')).toBe('ha')
    expect(shardKey('Übel')).toBe('ub')
    expect(shardKey('Öl')).toBe('ol')
    expect(shardKey('ab')).toBe('ab')
    expect(shardKey('à')).toBe('a_')
    expect(shardKey('3')).toBe('__')
    expect(shardKey('ßig')).toBe('ss')
    expect(shardKey('zu Hause')).toBe('zu')
    expect(shardFile('ha')).toBe('ha.json.gz')
  })
})

// ---------------------------------------------------------------------------------------------
// Wiktionary

const noun = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    pos: 'noun',
    word: 'Haus',
    lang_code: 'de',
    head_templates: [{ name: 'de-noun', args: { '1': 'n,es,^er' }, expansion: 'Haus n (strong, genitive Hauses, plural Häuser, diminutive Häuschen n)' }],
    forms: [
      { form: 'Hauses', tags: ['genitive'] },
      { form: 'Häuser', tags: ['plural'] },
      { form: 'Häuschen', tags: ['diminutive'] },
      { form: 'strong', source: 'declension', tags: ['table-tags'] },
      { form: 'de-ndecl', source: 'declension', tags: ['inflection-template'] },
      { form: 'Haus', tags: ['nominative', 'singular'], source: 'declension' },
      { form: 'Häuser', tags: ['definite', 'nominative', 'plural'], source: 'declension' },
      { form: 'Häusern', tags: ['dative', 'definite', 'plural'], source: 'declension' },
      { form: 'Hause', tags: ['dative', 'singular'], source: 'declension' },
    ],
    senses: [
      { glosses: ['house, building'], tags: ['neuter', 'strong'] },
      { glosses: ['home (in various phrases)'], tags: ['neuter'] },
      { glosses: ['theatre'], tags: ['neuter'] },
      { glosses: ['dynasty, house'], tags: ['neuter'] },
    ],
    ...over,
  })

describe('parseWiktionaryLine', () => {
  it('turns a noun line into an entry with gender, plural, top three glosses and one-word forms', () => {
    const { entry, links, skipped } = parseWiktionaryLine(noun())
    expect(skipped).toBeUndefined()
    expect(links).toEqual([])
    expect(entry).toEqual({
      lemma: 'Haus',
      pos: 'noun',
      gender: 'n',
      plural: 'Häuser',
      glosses: ['house, building', 'home (in various phrases)', 'theatre'],
      forms: ['Hauses', 'Häuser', 'Häusern', 'Hause'],
    })
  })

  it('reads several genders from the sense tags, else from the headline', () => {
    expect(pickGender([{ tags: ['masculine', 'neuter'] }], undefined)).toBe('m/n')
    expect(pickGender([{ tags: ['feminine'] }, { tags: ['masculine'] }], undefined)).toBe('m/f')
    expect(pickGender([{ tags: ['strong'] }], 'Loh m or n (strong, genitive Lohs, plural Lohe)')).toBe('m/n')
    expect(pickGender([], 'Andacht f (genitive Andacht, plural Andachten)')).toBe('f')
    expect(pickGender([], 'Eltern pl (plural only)')).toBe('pl')
    expect(pickGender([{ tags: ['plural-only'] }], undefined)).toBe('pl')
    expect(pickGender([], 'Vereinigte Staaten pl')).toBe('pl')
    expect(pickGender([], undefined)).toBeUndefined()
  })

  it('keeps the gendered counterpart of a noun out of its forms but keeps gendered adjective forms', () => {
    const line = noun({
      word: 'Schreier',
      forms: [
        { form: 'Schreiers', tags: ['genitive'] },
        { form: 'Schreier', tags: ['plural'] },
        { form: 'Schreierin', tags: ['feminine'] },
        { form: 'Schreiern', tags: ['dative', 'definite', 'plural'], source: 'declension' },
      ],
      senses: [{ glosses: ['agent noun of schreien:', 'crier'], tags: ['historical', 'masculine'] }, { glosses: ['agent noun of schreien:', 'screamer, shouter'], tags: ['masculine'] }],
    })
    const { entry } = parseWiktionaryLine(line)
    expect(entry?.forms).toEqual(['Schreiers', 'Schreiern'])
    expect(entry?.plural).toBe('Schreier')
    // The specific gloss of each sense, the usual sense before the historical one.
    expect(entry?.glosses).toEqual(['screamer, shouter', 'crier'])

    const adj = JSON.stringify({
      pos: 'adj',
      word: 'frei',
      lang_code: 'de',
      forms: [
        { form: 'freier', tags: ['comparative'] },
        { form: 'am freiesten', tags: ['superlative'] },
        { form: 'freie', tags: ['feminine', 'nominative', 'singular', 'strong'], source: 'declension' },
        { form: 'der freie', tags: ['definite', 'masculine', 'nominative', 'singular', 'weak'], source: 'declension' },
        { form: 'frei', tags: ['masculine', 'predicative', 'singular'], source: 'declension' },
      ],
      senses: [{ glosses: ['free; unenslaved'], tags: [] }],
    })
    expect(parseWiktionaryLine(adj).entry?.forms).toEqual(['freier', 'freie'])
  })

  it('keeps the one-word subordinate-clause forms of a separable verb and drops the two-word ones', () => {
    const verb = JSON.stringify({
      pos: 'verb',
      word: 'anreisen',
      lang_code: 'de',
      forms: [
        { form: 'reist an', tags: ['present', 'singular', 'third-person'] },
        { form: 'angereist', tags: ['participle', 'past'] },
        { form: 'sein', tags: ['auxiliary'] },
        { form: 'weak', tags: ['table-tags'] },
        { form: 'anreisen', tags: ['infinitive'] },
        { form: 'anzureisen', tags: ['infinitive', 'infinitive-zu'] },
        { form: 'anreist', tags: ['indicative', 'present', 'singular', 'subordinate-clause', 'third-person'] },
      ],
      senses: [{ glosses: ['to travel, to take a trip'], tags: ['weak'] }, { glosses: ['to arrive'], tags: ['weak'] }],
    })
    const { entry } = parseWiktionaryLine(verb)
    expect(entry).toEqual({ lemma: 'anreisen', pos: 'verb', glosses: ['to travel, to take a trip', 'to arrive'], forms: ['angereist', 'anzureisen', 'anreist'] })
  })

  it('turns a form-of or alt-of line into links and no entry', () => {
    const formOf = JSON.stringify({
      pos: 'name',
      word: 'Engens',
      lang_code: 'de',
      senses: [{ glosses: ['genitive singular of Engen'], tags: ['form-of', 'genitive', 'singular'], form_of: [{ word: 'Engen' }] }],
    })
    expect(parseWiktionaryLine(formOf)).toEqual({ entry: null, links: [{ form: 'Engens', lemma: 'Engen' }], skipped: 'link' })

    const altOf = JSON.stringify({
      pos: 'adj',
      word: 'aufwändig',
      lang_code: 'de',
      senses: [{ glosses: ['alternative spelling of aufwendig'], tags: ['alt-of', 'alternative'], alt_of: [{ word: 'aufwendig' }] }],
    })
    expect(parseWiktionaryLine(altOf).links).toEqual([{ form: 'aufwändig', lemma: 'aufwendig' }])
    expect(parseWiktionaryLine(altOf).entry).toBeNull()
  })

  it('keeps the meanings of a line that mixes real senses with a form-of sense, and still links it', () => {
    const line = noun({
      word: 'Hause',
      senses: [{ glosses: ['dative singular of Haus'], tags: ['form-of'], form_of: [{ word: 'Haus' }] }, { glosses: ['home (only in zu Hause)'], tags: ['neuter'] }],
    })
    const { entry, links } = parseWiktionaryLine(line)
    expect(entry?.glosses).toEqual(['home (only in zu Hause)'])
    expect(links).toEqual([{ form: 'Hause', lemma: 'Haus' }])
  })

  it('skips other languages, unkept parts of speech, glossless lines and bad JSON', () => {
    expect(parseWiktionaryLine(noun({ lang_code: 'en' })).skipped).toBe('lang:en')
    expect(parseWiktionaryLine(noun({ pos: 'prefix' })).skipped).toBe('pos:prefix')
    expect(parseWiktionaryLine(noun({ pos: 'character' })).skipped).toBe('pos:character')
    expect(parseWiktionaryLine(noun({ senses: [{ tags: ['neuter'] }] })).skipped).toBe('no-glosses')
    expect(parseWiktionaryLine('{"pos": "noun", "word": "Ha').skipped).toBe('json')
    expect(parseWiktionaryLine(noun({ pos: 'article' })).entry?.pos).toBe('det')
    expect(parseWiktionaryLine(noun({ pos: 'prep_phrase' })).entry?.pos).toBe('phrase')
  })

  it('does not give gender or plural to anything but nouns and names', () => {
    const { entry } = parseWiktionaryLine(noun({ pos: 'adv' }))
    expect(entry?.gender).toBeUndefined()
    expect(entry?.plural).toBeUndefined()
  })
})

describe('pickGlosses / trimGloss', () => {
  it('puts usual senses before deprecated ones and dedupes ignoring case', () => {
    expect(pickGlosses([{ glosses: ['grove, small wood'], tags: ['obsolete'] }])).toEqual(['grove, small wood'])
    expect(pickGlosses([{ glosses: ['Grove'], tags: ['obsolete'] }, { glosses: ['grove'], tags: [] }, { glosses: ['copse'], tags: [] }])).toEqual(['grove', 'copse'])
    expect(pickGlosses([{ glosses: ['lady'], tags: ['dated'] }, { glosses: ['wench'], tags: ['derogatory'] }, { glosses: ['woman'], tags: [] }])).toEqual(['woman', 'lady', 'wench'])
    expect(pickGlosses([{ glosses: ['a'], tags: ['rare'] }, { glosses: ['b'] }, { glosses: ['c'] }, { glosses: ['d'] }])).toEqual(['b', 'c', 'd'])
    expect(pickGlosses([{ glosses: ['a'] }, { glosses: ['b'] }, { glosses: ['c'] }, { glosses: ['d'] }])).toEqual(['a', 'b', 'c'])
  })

  it('drops pointer glosses and trailing colons', () => {
    expect(pickGlosses([{ glosses: ['alternative form of Hermitesch'] }, { glosses: ['Hermitian'] }])).toEqual(['Hermitian'])
    expect(pickGlosses([{ glosses: ['misspelling of Haus'] }])).toEqual([])
    expect(pickGlosses([{ glosses: ['agent noun of schreien:', 'crier'] }])).toEqual(['crier'])
    expect(trimGloss('agent noun of schreien:')).toBe('agent noun of schreien')
  })

  it('takes the shared parent of sub-senses first, then the specific ones', () => {
    const bild = [
      { glosses: ['depiction, image, picture', 'digital image', 'digital photograph'] },
      { glosses: ['depiction, image, picture', 'digital image', 'image created digitally', 'digital drawing'] },
      { glosses: ['depiction, image, picture', 'physical image', 'painting'] },
      { glosses: ['depiction, image, picture', 'mental image/picture'] },
      { glosses: ['computer file containing a digital image'] },
    ]
    expect(pickGlosses(bild)).toEqual(['depiction, image, picture', 'computer file containing a digital image', 'digital photograph'])
  })

  it('cuts long glosses at a word boundary', () => {
    const long = 'a '.repeat(80) + 'end'
    const cut = trimGloss(long)
    expect(cut.length).toBeLessThanOrEqual(MAX_GLOSS_LENGTH)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut).not.toMatch(/ …$/)
  })
})

// ---------------------------------------------------------------------------------------------
// FreeDict

const tei = (orth: string, gram: string, senses: string) => `<entry xml:id="${orth}.1">\n  <form>\n    <orth>${orth}</orth>\n  </form>\n  <gramGrp>${gram}</gramGrp>\n  ${senses}\n</entry>`
const trans = (en: string) => `<cit type="trans"><quote xml:lang="en">${en}</quote><gramGrp><pos>n</pos></gramGrp></cit>`

describe('TeiEntrySplitter', () => {
  it('yields whole entries whatever the chunk boundaries, dropping the text between them', () => {
    const a = tei('Haus', '<gen>neut</gen><pos>n</pos>', `<sense>${trans('house')}</sense>`)
    const b = tei('Baum', '<gen>masc</gen><pos>n</pos>', `<sense>${trans('tree')}</sense>`)
    const text = `<?xml version="1.0"?>\n<TEI><teiHeader><title>x</title></teiHeader><text><body>\n${a}\n${b}\n</body></text></TEI>`
    for (const size of [1, 7, 50, 1000]) {
      const splitter = new TeiEntrySplitter()
      const out: string[] = []
      for (let i = 0; i < text.length; i += size) out.push(...splitter.push(text.slice(i, i + size)))
      expect(out).toEqual([a, b])
    }
  })
})

describe('parseTeiEntry', () => {
  it('reads headword, part of speech, gender and the translations outside examples', () => {
    const xml = tei(
      'Haus',
      '<gen>neut</gen><pos>n</pos>',
      `<sense>${trans('house')}${trans('building')}<cit type="example"><quote xml:lang="de">zu Hause</quote><cit type="trans"><quote xml:lang="en">at home</quote></cit></cit></sense><sense>${trans('house')}${trans('theatre')}${trans('firm')}</sense>`,
    )
    expect(parseTeiEntry(xml)).toEqual({ lemma: 'Haus', pos: 'noun', gender: 'n', glosses: ['house', 'building', 'theatre'] })
    expect(teiTranslations(xml)).toEqual(['house', 'building', 'theatre', 'firm'])
  })

  it('maps parts of speech, strips a verb’s reflexive pronoun, and classifies entries without one', () => {
    expect(parseTeiEntry(tei('sich anziehen', '<pos>v</pos>', `<sense>${trans('to get dressed')}</sense>`))).toEqual({ lemma: 'anziehen', pos: 'verb', glosses: ['to get dressed'] })
    expect(parseTeiEntry(tei('schnell', '<pos>adj</pos>', `<sense>${trans('fast')}</sense>`))?.pos).toBe('adj')
    expect(parseTeiEntry(tei('oh', '<pos>int</pos>', `<sense>${trans('oh')}</sense>`))?.pos).toBe('intj')
    // Ding's plural headwords carry a number and no part of speech: nouns.
    expect(parseTeiEntry(tei('Aasfresser', '<number>pl</number>', `<sense>${trans('scavengers')}</sense>`))).toEqual({ lemma: 'Aasfresser', pos: 'noun', glosses: ['scavengers'] })
    expect(parseTeiEntry(tei('irgendwie', '', `<sense>${trans('somehow')}</sense>`))).toEqual({ lemma: 'irgendwie', pos: 'other', glosses: ['somehow'] })
  })

  it('skips multi-word and annotated headwords and entries without translations', () => {
    expect(parseTeiEntry(tei('zu Hause', '<pos>adv</pos>', `<sense>${trans('at home')}</sense>`))).toBeNull()
    expect(parseTeiEntry(tei('Haus/Heim', '<pos>n</pos>', `<sense>${trans('home')}</sense>`))).toBeNull()
    expect(parseTeiEntry(tei('Haus', '<pos>n</pos>', '<sense><cit type="example"><quote>Haus</quote><cit type="trans"><quote>house</quote></cit></cit></sense>'))).toBeNull()
  })

  it('decodes entities and keeps several genders', () => {
    expect(decodeXml('Tom &amp; Jerry &lt;3 &quot;x&quot; &#39;y&#39; &#x41;')).toBe('Tom & Jerry <3 "x" \'y\' A')
    const e = parseTeiEntry(tei('Joghurt', '<gen>masc</gen><gen>neut</gen><pos>n</pos>', `<sense>${trans('yoghurt &amp; co')}</sense>`))
    expect(e).toEqual({ lemma: 'Joghurt', pos: 'noun', gender: 'm/n', glosses: ['yoghurt & co'] })
  })
})

// ---------------------------------------------------------------------------------------------
// Builder

describe('DictionaryBuilder', () => {
  const build = () => {
    const b = new DictionaryBuilder()
    b.addWiktionary({ lemma: 'Haus', pos: 'noun', gender: 'n', plural: 'Häuser', glosses: ['house, building', 'home'], forms: ['Hauses', 'Häuser', 'Häusern'] })
    b.addWiktionary({ lemma: 'gehen', pos: 'verb', glosses: ['to go', 'to walk'], forms: ['ging', 'gegangen', 'gehst'] })
    b.addWiktionary({ lemma: 'weg', pos: 'adv', glosses: ['away'], forms: [] })
    b.addWiktionary({ lemma: 'Weg', pos: 'noun', gender: 'm', plural: 'Wege', glosses: ['way, path'], forms: ['Wege', 'Wegen'] })
    b.addLinks([
      { form: 'Hause', lemma: 'Haus' },
      { form: 'aufwändig', lemma: 'aufwendig' }, // dangling: no such lemma
    ])
    b.addFreeDict({ lemma: 'Haus', pos: 'noun', gender: 'n', glosses: ['house', 'premises', 'dynasty'] })
    b.addFreeDict({ lemma: 'Gehen', pos: 'noun', gender: 'n', glosses: ['walking'] })
    b.addFreeDict({ lemma: 'Straße', pos: 'noun', gender: 'f', glosses: ['street', 'road'] })
    b.addFreeDict({ lemma: 'Straße', pos: 'noun', gender: 'f', glosses: ['Street', 'highway', 'avenue', 'strait'] })
    b.addFreeDict({ lemma: 'gehen', pos: 'verb', glosses: ['to go', 'to leave'] })
    return b.build()
  }

  it('indexes every lemma and form under its folded key in the shard of its prefix', () => {
    const { shards } = build()
    expect([...shards.keys()]).toEqual(['ge', 'gi', 'ha', 'st', 'we'])
    const ha = shards.get('ha')!
    expect(ha.forms).toEqual({ haus: ['Haus'], hause: ['Haus'], hauses: ['Haus'], häuser: ['Haus'], häusern: ['Haus'] })
    expect(Object.keys(ha.forms)).toEqual(['haus', 'hause', 'hauses', 'häuser', 'häusern'])
    expect(shards.get('gi')!.forms).toEqual({ ging: ['gehen'] })
    expect(shards.get('gi')!.entries).toEqual({})
    expect(shards.get('we')!.forms).toEqual({ weg: ['Weg', 'weg'], wege: ['Weg'], wegen: ['Weg'] })
    expect(shards.get('st')!.forms).toEqual({ strasse: ['Straße'] })
  })

  it('lets FreeDict fill glosses up to three and add missing words, tagging the source', () => {
    const { shards, stats } = build()
    const haus = shards.get('ha')!.entries.Haus
    expect(haus).toEqual([{ lemma: 'Haus', pos: 'noun', gender: 'n', plural: 'Häuser', glosses: ['house, building', 'home', 'house'], src: 'wikt+freedict' }])
    const ge = shards.get('ge')!.entries
    // "to go" is there already; "to leave" fills the third slot.
    expect(ge.gehen).toEqual([{ lemma: 'gehen', pos: 'verb', glosses: ['to go', 'to walk', 'to leave'], src: 'wikt+freedict' }])
    expect(ge.Gehen).toEqual([{ lemma: 'Gehen', pos: 'noun', gender: 'n', glosses: ['walking'], src: 'freedict' }])
    // Two FreeDict entries of one headword collapse into one with the first three distinct glosses.
    expect(shards.get('st')!.entries['Straße']).toEqual([{ lemma: 'Straße', pos: 'noun', gender: 'f', glosses: ['street', 'road', 'highway'], src: 'freedict' }])
    expect(stats).toEqual({ lemmas: 6, entries: 6, forms: 13, danglingLinks: 1, freedictMerged: 3, freedictAdded: 2 })
  })

  it('does not index a form twice and keeps the output sorted', () => {
    const b = new DictionaryBuilder()
    b.addWiktionary({ lemma: 'Zug', pos: 'noun', gender: 'm', glosses: ['train'], forms: ['Züge', 'Zuges'] })
    b.addWiktionary({ lemma: 'Zug', pos: 'noun', gender: 'm', glosses: ['train'], forms: ['Züge'] })
    b.addWiktionary({ lemma: 'Zug', pos: 'name', gender: 'm', glosses: ['Zug (canton)'], forms: [] })
    const { shards, stats } = b.build()
    expect(Object.keys(shards.get('zu')!.forms)).toEqual(['zug', 'zuges', 'züge'])
    expect(shards.get('zu')!.entries.Zug.map((e) => e.pos)).toEqual(['noun', 'name'])
    expect(stats.entries).toBe(2)
  })
})

describe('encodeShards', () => {
  const shards = new Map<string, DictShard>([
    ['ha', { entries: { Haus: [{ lemma: 'Haus', pos: 'noun', gender: 'n', glosses: ['house'], src: 'wikt' }] }, forms: { haus: ['Haus'] } }],
    ['ge', { entries: {}, forms: { ging: ['gehen'] } }],
  ])
  const sources = [{ name: 'wiktionary' as const, url: 'https://example.test/de.jsonl.gz' }]

  it('gzips each shard and writes an index with sizes, counts and a content hash', () => {
    const { files, index } = encodeShards(shards, { lemmas: 1, entries: 1, forms: 2 }, sources, new Date('2026-11-11T10:00:00Z'))
    expect([...files.keys()]).toEqual(['ge.json.gz', 'ha.json.gz'])
    expect(JSON.parse(gunzipSync(files.get('ha.json.gz')!).toString())).toEqual(shards.get('ha'))
    expect(index.format).toBe(DICT_FORMAT)
    expect(index.built).toBe('2026-11-11')
    expect(index.sources).toEqual(sources)
    expect(index.version).toMatch(/^[0-9a-f]{16}$/)
    expect(index.shards.ha).toEqual({ file: 'ha.json.gz', bytes: files.get('ha.json.gz')!.byteLength, entries: 1, forms: 1 })
    expect(index.shards.ge.entries).toBe(0)
    expect(index.stats).toEqual({ lemmas: 1, entries: 1, forms: 2, bytes: files.get('ha.json.gz')!.byteLength + files.get('ge.json.gz')!.byteLength })
  })

  it('is reproducible, and the version changes with the content', () => {
    const a = encodeShards(shards, { lemmas: 1, entries: 1, forms: 2 }, sources)
    const b = encodeShards(shards, { lemmas: 1, entries: 1, forms: 2 }, sources)
    expect(a.index.version).toBe(b.index.version)
    expect(a.files.get('ha.json.gz')!.equals(b.files.get('ha.json.gz')!)).toBe(true)
    const changed = new Map(shards)
    changed.set('ge', { entries: {}, forms: { ging: ['gehen'], gingen: ['gehen'] } })
    expect(encodeShards(changed, { lemmas: 1, entries: 1, forms: 3 }, sources).index.version).not.toBe(a.index.version)
  })
})
