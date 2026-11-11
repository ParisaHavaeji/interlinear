/**
 * The on-disk format of the shipped dictionary (plan.md step 21), shared by the build tool that
 * writes it (`tools/build-dict`) and the lookup module that reads it (step 22). DOM-free.
 *
 * The dictionary is a set of gzipped JSON shards under `public/dict/`, one per two-letter
 * prefix, plus an `index.json` listing them. A shard holds two maps:
 *
 * - `entries`: exact lemma (case kept, "Haus", "haus" being different words) → its entries,
 *   one per part of speech and etymology, each with the top glosses from Wiktionary and/or
 *   FreeDict and, for nouns, gender and plural.
 * - `forms`: folded surface form ({@link foldForm}: lowercase, ß → ss) → the lemmas it is a form
 *   of, including every lemma's own folded form. "häusern" → ["Haus"], "ging" → ["gehen"],
 *   "weg" → ["Weg", "weg"]. This is the inflection index of plan.md §1.3: a lookup folds the
 *   token, reads `forms`, then `entries` for each lemma.
 *
 * A form lives in the shard of its own prefix ({@link shardKey}) and an entry in the shard of
 * its lemma's prefix, so a lookup needs at most two shards: umlauts and ß are folded to ASCII in
 * the key, so "Häusern" and "Haus" share "ha", but "ging" (gi) and "gehen" (ge) do not.
 *
 * The shards are stored gzipped and served as static files. Some servers (Vite's dev and
 * preview servers) send a `.json.gz` with `Content-Encoding: gzip`, so the browser has decoded
 * it by the time a reader sees the bytes; others (GitHub Pages) send the raw gzip. A reader
 * therefore checks the gzip magic bytes (0x1f 0x8b) before running a `DecompressionStream`.
 */

/** Parts of speech kept from the sources, Wiktionary's names; `other` is FreeDict without one. */
export type Pos =
  | 'noun'
  | 'verb'
  | 'adj'
  | 'adv'
  | 'prep'
  | 'pron'
  | 'conj'
  | 'det'
  | 'num'
  | 'intj'
  | 'particle'
  | 'name'
  | 'phrase'
  | 'abbrev'
  | 'contraction'
  | 'other'

/** Where an entry's glosses come from. */
export type DictSourceTag = 'wikt' | 'freedict' | 'wikt+freedict'

export interface DictEntry {
  lemma: string
  pos: Pos
  /**
   * Nouns: "m", "f" or "n", several joined with "/" when the sources allow more than one
   * ("m/n"), "pl" for plural-only nouns. Absent for other parts of speech and unknown genders.
   */
  gender?: string
  /** Nominative plural of a noun, when the source gives one. */
  plural?: string
  /** Up to three English glosses, most common sense first, as the source writes them. */
  glosses: string[]
  src: DictSourceTag
}

export interface DictShard {
  entries: Record<string, DictEntry[]>
  forms: Record<string, string[]>
}

export interface ShardInfo {
  file: string
  /** Gzipped size, for download progress (step 23). */
  bytes: number
  entries: number
  forms: number
}

export interface DictSource {
  name: 'wiktionary' | 'freedict'
  url: string
  /** The source's own version or date, when known. */
  version?: string
}

export interface DictIndex {
  format: 1
  /** Hash of every shard's content; changes whenever any shard does. */
  version: string
  /** ISO date of the build. */
  built: string
  sources: DictSource[]
  stats: { lemmas: number; entries: number; forms: number; bytes: number }
  shards: Record<string, ShardInfo>
}

/** Current value of {@link DictIndex.format}; readers refuse other values. */
export const DICT_FORMAT = 1

/** The directory under the site root the shards and index live in. */
export const DICT_PATH = 'dict/'

/**
 * Key of the `forms` map for a surface form: Unicode-normalised, trimmed, lowercased, ß → ss.
 * Umlauts stay ("schon" and "schön" are different words); the Swiss spelling and the capital ẞ
 * fold onto the same key as ß, at the price of "Masse" and "Maße" sharing one.
 */
export function foldForm(form: string): string {
  return form.normalize('NFC').trim().toLowerCase().replace(/ß/g, 'ss')
}

/**
 * Shard a form belongs to: the first two characters of its folded form with diacritics
 * stripped, every character outside a–z replaced by "_", padded with "_" ("Haus" → "ha",
 * "Übel" → "ub", "Öl" → "ol", "ab" → "ab", "à" → "a_", "3" → "__").
 */
export function shardKey(form: string): string {
  const ascii = foldForm(form).normalize('NFD').replace(/\p{M}/gu, '')
  let key = ''
  for (let i = 0; i < 2; i++) {
    const c = ascii[i]
    key += c !== undefined && c >= 'a' && c <= 'z' ? c : '_'
  }
  return key
}

/** File name of a shard inside {@link DICT_PATH}. */
export function shardFile(key: string): string {
  return `${key}.json.gz`
}

/** Whether the bytes start with gzip's magic number. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

/**
 * Parse the bytes of a shard file as served or cached: gunzipped first when they are still
 * gzip (see the note on `Content-Encoding` above), parsed as JSON either way. Throws on a shard
 * that is neither.
 */
export async function decodeShard(bytes: Uint8Array): Promise<DictShard> {
  let json: string
  if (isGzip(bytes)) {
    const stream = new Response(bytes as unknown as ArrayBuffer).body!.pipeThrough(new DecompressionStream('gzip'))
    json = await new Response(stream).text()
  } else {
    json = new TextDecoder().decode(bytes)
  }
  const shard = JSON.parse(json) as Partial<DictShard>
  if (typeof shard !== 'object' || shard === null || typeof shard.entries !== 'object' || typeof shard.forms !== 'object') {
    throw new Error('not a dictionary shard')
  }
  return shard as DictShard
}
