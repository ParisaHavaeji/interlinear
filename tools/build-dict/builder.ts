/**
 * Merge Wiktionary and FreeDict entries into shards (plan.md step 21). Pure; the CLI in
 * main.ts streams the sources through it and writes what {@link encodeShards} returns.
 *
 * Wiktionary is primary: every kept entry becomes a dictionary entry with its forms indexed,
 * and the form-of links of its other lines are resolved at the end (a link to a lemma the
 * dictionary does not have is dropped rather than left dangling). FreeDict then fills gaps:
 * a headword with no Wiktionary entry of the same part of speech becomes an entry tagged
 * `freedict`; one that exists but has fewer than {@link MAX_GLOSSES} glosses gets FreeDict's
 * appended and is tagged `wikt+freedict`; FreeDict never changes a gender Wiktionary gave.
 * Add every Wiktionary line before the first FreeDict entry.
 */

import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { DICT_FORMAT, foldForm, shardFile, shardKey, type DictEntry, type DictIndex, type DictShard, type DictSource } from '../../src/dict/format.ts'
import type { FreeDictEntry } from './freedict.ts'
import { MAX_GLOSSES, type WiktEntry, type WiktLink } from './wiktionary.ts'

interface MutableShard {
  entries: Map<string, DictEntry[]>
  forms: Map<string, Set<string>>
}

export interface BuildStats {
  lemmas: number
  entries: number
  forms: number
  /** Form links whose target lemma the dictionary lacks. */
  danglingLinks: number
  /** FreeDict entries merged into a Wiktionary entry / added as their own. */
  freedictMerged: number
  freedictAdded: number
}

export class DictionaryBuilder {
  private readonly shards = new Map<string, MutableShard>()
  private readonly lemmas = new Set<string>()
  private readonly links: WiktLink[] = []
  private freedictMerged = 0
  private freedictAdded = 0

  private shard(key: string): MutableShard {
    let s = this.shards.get(key)
    if (s === undefined) this.shards.set(key, (s = { entries: new Map(), forms: new Map() }))
    return s
  }

  private addForm(form: string, lemma: string): void {
    const key = foldForm(form)
    if (key === '') return
    const shard = this.shard(shardKey(key))
    let lemmas = shard.forms.get(key)
    if (lemmas === undefined) shard.forms.set(key, (lemmas = new Set()))
    lemmas.add(lemma)
  }

  private addEntry(entry: DictEntry): void {
    const shard = this.shard(shardKey(entry.lemma))
    let list = shard.entries.get(entry.lemma)
    if (list === undefined) shard.entries.set(entry.lemma, (list = []))
    if (list.some((e) => sameEntry(e, entry))) return
    list.push(entry)
    this.lemmas.add(entry.lemma)
    this.addForm(entry.lemma, entry.lemma)
  }

  addWiktionary(w: WiktEntry): void {
    const entry: DictEntry = { lemma: w.lemma, pos: w.pos, glosses: [...w.glosses], src: 'wikt' }
    if (w.gender !== undefined) entry.gender = w.gender
    if (w.plural !== undefined) entry.plural = w.plural
    this.addEntry(entry)
    for (const f of w.forms) this.addForm(f, w.lemma)
  }

  /** Remember form-of links; they are resolved in {@link build}, once every lemma is known. */
  addLinks(links: readonly WiktLink[]): void {
    this.links.push(...links)
  }

  addFreeDict(f: FreeDictEntry): void {
    const existing = this.shards.get(shardKey(f.lemma))?.entries.get(f.lemma)?.filter((e) => e.pos === f.pos || (f.pos === 'other' && e.src !== 'freedict')) ?? []
    if (existing.length > 0) {
      let merged = false
      for (const e of existing) {
        for (const g of f.glosses) {
          if (e.glosses.length >= MAX_GLOSSES) break
          if (e.glosses.some((h) => h.toLowerCase() === g.toLowerCase())) continue
          e.glosses.push(g)
          merged = true
        }
        if (merged && e.src === 'wikt') e.src = 'wikt+freedict'
        if (e.gender === undefined && f.gender !== undefined && e.pos === 'noun') e.gender = f.gender
      }
      if (merged) this.freedictMerged++
      return
    }
    const entry: DictEntry = { lemma: f.lemma, pos: f.pos, glosses: [...f.glosses], src: 'freedict' }
    if (f.gender !== undefined && f.pos === 'noun') entry.gender = f.gender
    this.addEntry(entry)
    this.freedictAdded++
  }

  /** Resolve the links and return the shards, sorted so the output is reproducible. */
  build(): { shards: Map<string, DictShard>; stats: BuildStats } {
    let dangling = 0
    for (const link of this.links) {
      if (!this.lemmas.has(link.lemma)) {
        dangling++
        continue
      }
      this.addForm(link.form, link.lemma)
    }

    const shards = new Map<string, DictShard>()
    let entries = 0
    let forms = 0
    for (const key of [...this.shards.keys()].sort()) {
      const s = this.shards.get(key)!
      const out: DictShard = { entries: {}, forms: {} }
      for (const lemma of [...s.entries.keys()].sort(byCodePoint)) {
        const list = s.entries.get(lemma)!
        out.entries[lemma] = list
        entries += list.length
      }
      for (const form of [...s.forms.keys()].sort(byCodePoint)) {
        out.forms[form] = [...s.forms.get(form)!].sort(byCodePoint)
        forms++
      }
      shards.set(key, out)
    }
    return {
      shards,
      stats: { lemmas: this.lemmas.size, entries, forms, danglingLinks: dangling, freedictMerged: this.freedictMerged, freedictAdded: this.freedictAdded },
    }
  }
}

function sameEntry(a: DictEntry, b: DictEntry): boolean {
  return a.pos === b.pos && a.gender === b.gender && a.plural === b.plural && a.glosses.length === b.glosses.length && a.glosses.every((g, i) => g === b.glosses[i])
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export interface EncodedDictionary {
  /** Shard file name → gzipped JSON. */
  files: Map<string, Buffer>
  index: DictIndex
}

/**
 * Gzip every shard and write the index. The version is a hash of the shards' JSON in key
 * order, so it changes exactly when the content does (gzip output has no timestamp).
 */
export function encodeShards(shards: ReadonlyMap<string, DictShard>, stats: Pick<BuildStats, 'lemmas' | 'entries' | 'forms'>, sources: DictSource[], built: Date = new Date()): EncodedDictionary {
  const files = new Map<string, Buffer>()
  const hash = createHash('sha256')
  const index: DictIndex = {
    format: DICT_FORMAT,
    version: '',
    built: built.toISOString().slice(0, 10),
    sources,
    stats: { lemmas: stats.lemmas, entries: stats.entries, forms: stats.forms, bytes: 0 },
    shards: {},
  }
  for (const key of [...shards.keys()].sort()) {
    const shard = shards.get(key)!
    const json = JSON.stringify(shard)
    hash.update(key).update('\n').update(json).update('\n')
    const gz = gzipSync(json, { level: 9 })
    const file = shardFile(key)
    files.set(file, gz)
    index.shards[key] = { file, bytes: gz.byteLength, entries: Object.keys(shard.entries).length, forms: Object.keys(shard.forms).length }
    index.stats.bytes += gz.byteLength
  }
  index.version = hash.digest('hex').slice(0, 16)
  return { files, index }
}
