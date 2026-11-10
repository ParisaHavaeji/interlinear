import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { alignBlocks, type AlignedBead, type ParagraphBlock } from '../src/align/beads.ts'
import { MapLexicon } from '../src/align/features.ts'
import {
  alignTwoPass,
  DEFAULT_INDUCE_OPTIONS,
  induceLexicon,
  InducedLexicon,
  mergeLexicons,
} from '../src/align/lexicon.ts'
import { splitParagraphs } from '../src/align/sentences.ts'
import { alignParagraphs, chaptersFromParagraphs } from '../src/align/structure.ts'
import { parseTxt } from '../src/import/txt.ts'

const read = (file: string) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')

/** One-sentence paragraphs, so sentence idx equals paragraph idx. */
const sentences = (lang: 'de' | 'en', texts: readonly string[]) =>
  splitParagraphs(
    texts.map((text, idx) => ({ idx, text })),
    lang,
  )

const bead = (de: number[], en: number[], confidence = 1): AlignedBead => ({
  deSentenceIdx: de,
  enSentenceIdx: en,
  cost: 1,
  margin: confidence === 1 ? Infinity : Math.log(confidence / (1 - confidence)),
  confidence,
})

const pairText = (lexicon: InducedLexicon) => lexicon.pairs.map((p) => `${p.de}→${p.en}`)

describe('induceLexicon', () => {
  const de = sentences('de', [
    'Die Schwester und die Mutter weinten.',
    'Die Schwester lachte.',
    'Die Schwester schlief.',
    'Die Mutter schlief.',
    'Die Mutter lachte laut.',
    'Die Schwester half der Mutter.',
    'Die Mutter weinte.',
    'Der Hund bellte.',
    'Der Hund bellte wieder.',
    'Der Hund bellte laut.',
    'Die Katze miaute.',
    'Die Katze miaute wieder.',
    'Die Katze miaute laut.',
    "Charlottes Buch lag auf Charlottes Tisch.",
    'Charlottes Buch war alt.',
    'Charlottes Buch war neu.',
  ])
  const en = sentences('en', [
    'The sister and the mother wept.',
    'The sister laughed.',
    'The sister slept.',
    'The mother slept.',
    'The mother laughed loudly.',
    'The sister helped the mother.',
    'The mother wept.',
    'The dog barked.',
    'The dog barked again.',
    'The dog barked loudly.',
    'The cat meowed.',
    'The cat meowed again.',
    'The cat meowed loudly.',
    "Charlotte's book lay on Charlotte's table.",
    "Charlotte's book was old.",
    "Charlotte's book was new.",
  ])
  const family = [0, 1, 2, 3, 4, 5, 6].map((i) => bead([i], [i]))
  const dogs = [7, 8, 9].map((i) => bead([i], [i], 0.5))
  const cats = [bead([10, 11], [10]), bead([12], [11, 12])]
  const charlotte = [13, 14, 15].map((i) => bead([i], [i]))

  it('learns pairs that recur in confident 1-1 beads and scores them by Dice', () => {
    const lexicon = induceLexicon(de, en, family, { minCount: 2 })
    const pairs = new Map(lexicon.pairs.map((p) => [`${p.de}→${p.en}`, p]))
    expect(pairs.get('schwester→sister')).toMatchObject({ count: 4, dice: 1 })
    expect(pairs.get('mutter→mother')).toMatchObject({ count: 5, dice: 1 })
    expect(pairs.get('lachte→laughed')).toMatchObject({ count: 2, dice: 1 })
    expect(pairs.get('schlief→slept')).toMatchObject({ count: 2, dice: 1 })
    // Seen once only.
    expect(pairText(lexicon)).not.toContain('laut→loudly')
    expect(pairText(lexicon)).not.toContain('half→helped')
    // Stopwords are never evidence.
    expect(lexicon.pairs.some((p) => p.de === 'die' || p.en === 'the')).toBe(false)
    // Strongest first.
    expect(lexicon.pairs[0].dice).toBe(1)
    expect(lexicon.pairs.map((p) => p.dice)).toEqual([...lexicon.pairs.map((p) => p.dice)].sort((a, b) => b - a))
  })

  it('drops a pair that is much weaker than the best pair of either word', () => {
    // Mother and sister share two of the seven sentences: Dice 4 / 9 ≈ 0.44, over the Dice floor
    // but under half the strength of mutter→mother and schwester→sister.
    const strict = induceLexicon(de, en, family, { minCount: 2 })
    expect(pairText(strict)).not.toContain('mutter→sister')
    expect(pairText(strict)).not.toContain('schwester→mother')
    const lax = induceLexicon(de, en, family, { minCount: 2, minRelative: 0 })
    expect(pairText(lax)).toContain('mutter→sister')
    expect(lax.pairs.find((p) => p.de === 'mutter' && p.en === 'sister')?.dice).toBeCloseTo(4 / 9)
  })

  it('ignores beads below the confidence floor and beads that are not 1-1', () => {
    expect(induceLexicon(de, en, dogs, { minCount: 2 }).size).toBe(0)
    expect(pairText(induceLexicon(de, en, dogs, { minCount: 2, minConfidence: 0 }))).toContain('hund→dog')
    expect(induceLexicon(de, en, cats, { minCount: 2, minConfidence: 0 }).size).toBe(0)
  })

  it('honours minCount and maxGlosses', () => {
    expect(pairText(induceLexicon(de, en, family, { minCount: 3 }))).toEqual(
      expect.arrayContaining(['schwester→sister', 'mutter→mother']),
    )
    expect(pairText(induceLexicon(de, en, family, { minCount: 3 }))).not.toContain('lachte→laughed')
    expect(induceLexicon(de, en, family, { minCount: 6 }).size).toBe(0)
    const one = induceLexicon(de, en, family, { minCount: 2, minRelative: 0, maxGlosses: 1 })
    for (const w of new Set(one.pairs.map((p) => p.de))) expect(one.pairs.filter((p) => p.de === w)).toHaveLength(1)
  })

  it('stores the commonest surface word without its possessive, and counts presence per bead', () => {
    const lexicon = induceLexicon(de, en, charlotte)
    const pair = lexicon.pairs.find((p) => p.de === 'charlottes' && p.en === 'charlotte')
    // "Charlottes" appears twice in the first sentence but counts once per bead.
    expect(pair).toMatchObject({ count: 3, dice: 1 })
    expect(lexicon.pairs.some((p) => /['’]/u.test(p.en))).toBe(false)
    expect(pairText(lexicon)).toContain('buch→book')
  })

  it('answers as a lexicon, with the suffix fallback of MapLexicon', () => {
    const lexicon = induceLexicon(de, en, family, { minCount: 2 })
    expect(lexicon).toBeInstanceOf(MapLexicon)
    expect(lexicon.glosses('Schwester')).toEqual(['sister'])
    expect(lexicon.glosses('Schwestern')).toEqual(['sister'])
    expect(lexicon.glosses('Vater')).toEqual([])
  })

  it('has conservative defaults', () => {
    expect(DEFAULT_INDUCE_OPTIONS).toEqual({ minConfidence: 0.9, minCount: 3, minDice: 0.4, minRelative: 0.5, maxGlosses: 3 })
  })
})

describe('mergeLexicons', () => {
  const dictionary = new MapLexicon([['Haus', ['house', 'home']]])
  const induced = new MapLexicon([
    ['Haus', ['home', 'building']],
    ['Prokurist', ['clerk']],
  ])

  it('returns null for nothing and the lexicon itself for one', () => {
    expect(mergeLexicons()).toBeNull()
    expect(mergeLexicons(null, null)).toBeNull()
    expect(mergeLexicons(null, induced)).toBe(induced)
  })

  it('answers with the glosses of every layer in order, without duplicates', () => {
    const merged = mergeLexicons(dictionary, null, induced)!
    expect(merged.glosses('Haus')).toEqual(['house', 'home', 'building'])
    expect(merged.glosses('Prokurist')).toEqual(['clerk'])
    expect(merged.glosses('Fenster')).toEqual([])
  })
})

describe('alignTwoPass', () => {
  // Three plain blocks teach Schlüssel → key and Fenster → window. In the fourth, "It was the key
  // from the window" could belong to either German sentence by length; pass one leans the
  // wrong way, pass two has the words to put it right.
  const deParas = [
    { idx: 0, text: 'Gregor fand den Schlüssel am Fenster.' },
    { idx: 1, text: 'Gregor legte den Schlüssel ans Fenster.' },
    { idx: 2, text: 'Gregor warf den Schlüssel aus dem Fenster.' },
    {
      idx: 3,
      text:
        'Er nahm den Schlüssel vom Fenster. Die Frau ging dann leise und langsam aus dem dunklen Zimmer hinaus ' +
        'und schloss die schwere Tür hinter sich.',
    },
  ]
  const enParas = [
    { idx: 0, text: 'Gregor found the key by the window.' },
    { idx: 1, text: 'Gregor put the key by the window.' },
    { idx: 2, text: 'Gregor threw the key out of the window.' },
    {
      idx: 3,
      text:
        'He took it in his hand. It was the key from the window. The woman then went quietly and slowly out of the ' +
        'dark room and shut the door.',
    },
  ]
  const de = splitParagraphs(deParas, 'de')
  const en = splitParagraphs(enParas, 'en')
  const blocks: ParagraphBlock[] = [0, 1, 2, 3].map((i) => ({ de: [i], en: [i] }))
  const shape = (beads: readonly AlignedBead[]) =>
    beads.map((b) => `${b.deSentenceIdx.join('+')}:${b.enSentenceIdx.join('+')}`).join(' | ')

  it('learns from pass one and realigns the ambiguous block', () => {
    const result = alignTwoPass(de, en, blocks, null)
    expect(pairText(result.lexicon)).toEqual(expect.arrayContaining(['schlüssel→key', 'fenster→window']))
    expect(shape(result.firstPass)).toBe('0:0 | 1:1 | 2:2 | 3:3 | 4:4+5')
    expect(shape(result.beads)).toBe('0:0 | 1:1 | 2:2 | 3:3+4 | 4:5')
    expect(result.firstPass).toEqual(alignBlocks(de, en, blocks, null))
  })

  it('stacks the induced lexicon on the dictionary rather than replacing it', () => {
    const dictionary = new MapLexicon([['Frau', ['woman']]])
    const result = alignTwoPass(de, en, blocks, dictionary)
    expect(shape(result.beads)).toBe('0:0 | 1:1 | 2:2 | 3:3+4 | 4:5')
    expect(result.firstPass).toEqual(alignBlocks(de, en, blocks, dictionary))
    expect(result.beads).toEqual(alignBlocks(de, en, blocks, mergeLexicons(dictionary, result.lexicon)))
    expect(result.beads).not.toEqual(alignBlocks(de, en, blocks, result.lexicon))
  })

  it('returns pass one unchanged when nothing was learned', () => {
    const result = alignTwoPass(de, en, blocks, null, { induce: { minCount: 100 } })
    expect(result.lexicon.size).toBe(0)
    expect(result.beads).toBe(result.firstPass)
  })
})

describe('on the Kafka fixture', () => {
  const paraDe = parseTxt(read('kafka-verwandlung.de.txt'))
  const paraEn = parseTxt(read('kafka-verwandlung.en.txt'))
  const chaptersDe = chaptersFromParagraphs(paraDe)
  const chaptersEn = chaptersFromParagraphs(paraEn)
  const sentDe = splitParagraphs(paraDe, 'de')
  const sentEn = splitParagraphs(paraEn, 'en')
  const blocks: ParagraphBlock[] = []
  for (const [i, c] of chaptersDe.entries()) {
    const other = chaptersEn[i].paragraphs
    for (const b of alignParagraphs(c.paragraphs, other)) {
      blocks.push({ de: b.de.map((x) => c.paragraphs[x].idx), en: b.en.map((y) => other[y].idx) })
    }
  }
  const t0 = performance.now()
  const result = alignTwoPass(sentDe, sentEn, blocks, null)
  const elapsed = performance.now() - t0

  it('learns the family and the furniture without a dictionary', () => {
    const pairs = pairText(result.lexicon)
    expect(pairs).toEqual(
      expect.arrayContaining([
        'schwester→sister',
        'mutter→mother',
        'vater→father',
        'eltern→parents',
        'fenster→window',
        'bett→bed',
        'küche→kitchen',
      ]),
    )
    expect(pairs).not.toContain('mutter→sister')
    expect(pairs).not.toContain('vater→mother')
    expect(result.lexicon.pairs.length).toBeGreaterThan(100)
    expect(result.lexicon.pairs.length).toBeLessThan(600)
    for (const p of result.lexicon.pairs) {
      expect(p.count).toBeGreaterThanOrEqual(3)
      expect(p.dice).toBeGreaterThanOrEqual(0.4)
      expect(p.dice).toBeLessThanOrEqual(1)
    }
    expect(result.lexicon.glosses('Schwester')).toContain('sister')
  })

  it('keeps the alignment consistent with pass one and still gets the opening right', () => {
    const key = (b: AlignedBead) => `${b.deSentenceIdx.join('+')}:${b.enSentenceIdx.join('+')}`
    const first = new Set(result.firstPass.map(key))
    const same = result.beads.filter((b) => first.has(key(b))).length
    expect(same / result.beads.length).toBeGreaterThan(0.95)
    expect(result.beads.flatMap((b) => b.deSentenceIdx)).toEqual(result.firstPass.flatMap((b) => b.deSentenceIdx))
    expect(result.beads.flatMap((b) => b.enSentenceIdx)).toEqual(result.firstPass.flatMap((b) => b.enSentenceIdx))
    const text = (b: AlignedBead) => [
      b.deSentenceIdx.map((i) => sentDe[i].text).join(' '),
      b.enSentenceIdx.map((i) => sentEn[i].text).join(' '),
    ]
    expect(text(result.beads[0])[0]).toMatch(/^Als Gregor Samsa eines Morgens/)
    expect(text(result.beads[0])[1]).toMatch(/^One morning, when Gregor Samsa/)
    expect(text(result.beads[4])).toEqual(['Es war kein Traum.', 'It wasn’t a dream.'])
    const confident = result.beads.filter((b) => b.confidence > 0.9).length
    expect(confident / result.beads.length).toBeGreaterThan(0.85)
    expect(elapsed).toBeLessThan(6000)
  })
})
