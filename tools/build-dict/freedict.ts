/**
 * FreeDict deu-eng (the TEI export of the Ding dictionary) → dictionary entries (plan.md
 * step 21). Pure; the tests feed it entry XML.
 *
 * The TEI file is 450 MB of `<entry>` elements:
 *
 *     <entry xml:id="Haus.1">
 *       <form><orth>Haus</orth></form>
 *       <gramGrp><gen>neut</gen><pos>n</pos></gramGrp>
 *       <sense>
 *         <cit type="trans"><quote xml:lang="en">house</quote><gramGrp><pos>n</pos></gramGrp></cit>
 *         <cit type="example"><quote xml:lang="de">zu Hause</quote><cit type="trans"><quote>at home</quote></cit></cit>
 *       </sense>
 *     </entry>
 *
 * {@link TeiEntrySplitter} cuts a stream of text into whole entries; {@link parseTeiEntry}
 * reads one. The entry's own `gramGrp` (before the first sense) gives the part of speech and
 * gender; the translations are the `trans` citations that are not inside an example. Ding is
 * a phrase dictionary as much as a word list, so only one-word headwords are kept; a verb's
 * reflexive "sich " is dropped first ("sich anziehen" → "anziehen"). Headwords with a number but
 * no part of speech are Ding's plural entries ("Aasfresser: scavengers") and count as nouns;
 * those with neither are kept as `other`.
 */

import type { Pos } from '../../src/dict/format.ts'
import { MAX_GLOSSES, trimGloss } from './wiktionary.ts'

export interface FreeDictEntry {
  lemma: string
  pos: Pos
  gender?: string
  glosses: string[]
}

/** FreeDict parts of speech → the dictionary's. */
export const FREEDICT_POS: Readonly<Record<string, Pos>> = {
  n: 'noun',
  v: 'verb',
  adj: 'adj',
  adv: 'adv',
  prep: 'prep',
  pron: 'pron',
  conj: 'conj',
  num: 'num',
  int: 'intj',
  art: 'det',
  ptcl: 'particle',
}

const FREEDICT_GENDER: Readonly<Record<string, string>> = { masc: 'm', fem: 'f', neut: 'n' }

const SINGLE_WORD = /^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** Decode the XML entities the TEI uses, named and numeric. */
export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[body.toLowerCase()] ?? m
  })
}

/**
 * Cut a stream of TEI text into whole `<entry>…</entry>` strings, whatever the chunk
 * boundaries. Text between entries (the header, whitespace) is dropped.
 */
export class TeiEntrySplitter {
  private buffer = ''

  push(chunk: string): string[] {
    this.buffer += chunk
    const out: string[] = []
    for (;;) {
      const start = this.buffer.indexOf('<entry')
      if (start < 0) {
        // Keep a possible partial "<entr" at the very end.
        this.buffer = this.buffer.slice(Math.max(0, this.buffer.length - 6))
        break
      }
      const end = this.buffer.indexOf('</entry>', start)
      if (end < 0) {
        this.buffer = this.buffer.slice(start)
        break
      }
      out.push(this.buffer.slice(start, end + '</entry>'.length))
      this.buffer = this.buffer.slice(end + '</entry>'.length)
    }
    return out
  }
}

const TOKEN = /<cit type="(trans|example)"[^>]*>|<\/cit>|<quote(?: [^>]*)?>([^<]*)<\/quote>/g

/** The translations of an entry: `trans` quotes not inside an example, in order, distinct. */
export function teiTranslations(entryXml: string): string[] {
  const out: string[] = []
  const stack: string[] = []
  for (const m of entryXml.matchAll(TOKEN)) {
    if (m[0] === '</cit>') {
      stack.pop()
    } else if (m[1] !== undefined) {
      stack.push(m[1])
    } else if (m[2] !== undefined && stack.length > 0 && stack[stack.length - 1] === 'trans' && !stack.includes('example')) {
      const gloss = trimGloss(decodeXml(m[2]))
      if (gloss !== '' && !out.some((g) => g.toLowerCase() === gloss.toLowerCase())) out.push(gloss)
    }
  }
  return out
}

/** Parse one entry. Multi-word and annotated headwords and entries without translations yield null. */
export function parseTeiEntry(entryXml: string): FreeDictEntry | null {
  const orth = /<orth>([^<]*)<\/orth>/.exec(entryXml)
  if (orth === null) return null
  let lemma = decodeXml(orth[1]).normalize('NFC').trim()

  const senseAt = entryXml.indexOf('<sense')
  const head = senseAt < 0 ? entryXml : entryXml.slice(0, senseAt)
  const posTag = /<pos>([^<]*)<\/pos>/.exec(head)
  // Ding lists many plurals as headwords of their own, with a number but no part of speech.
  const pos: Pos = posTag === null ? (/<number>/.test(head) ? 'noun' : 'other') : (FREEDICT_POS[posTag[1].trim()] ?? 'other')
  if (pos === 'verb') lemma = lemma.replace(/^sich\s+/, '')
  if (!SINGLE_WORD.test(lemma)) return null

  const glosses = teiTranslations(entryXml).slice(0, MAX_GLOSSES)
  if (glosses.length === 0) return null

  const entry: FreeDictEntry = { lemma, pos, glosses }
  const genders = new Set<string>()
  for (const m of head.matchAll(/<gen>([^<]*)<\/gen>/g)) {
    const g = FREEDICT_GENDER[m[1].trim()]
    if (g !== undefined) genders.add(g)
  }
  if (genders.size > 0) entry.gender = ['m', 'f', 'n'].filter((g) => genders.has(g)).join('/')
  return entry
}
