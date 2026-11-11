/**
 * The dictionary's shards in the browser (plan.md step 22): Cache Storage first, the network
 * second, decoded for `dict/lookup.ts`. Browser only; the lookup itself is platform-free.
 *
 * The shards live in their own cache, {@link DICT_CACHE}, not the service worker's shell cache:
 * the shell cache is replaced on every app update, and 10 MB of dictionary should outlive the
 * app's versions (the service worker leaves `dict/` requests alone for the same reason). Every
 * request is keyed by the shard's URL with the dictionary's version as a query, so a shard of
 * one build can never be read as a shard of another; {@link DictStore.refresh} fetches a new
 * `index.json` and, when its version differs, drops the old version's shards.
 *
 * `index.json` is read from the cache when it is there, so the dictionary opens offline and
 * without a round trip; the first open fetches it. A shard the index does not list is answered
 * without a request ("qx" has no shard). Step 23 downloads every shard into the same cache
 * through {@link DictStore.fetchShard} and reports progress with the sizes in the index.
 */

import { DICT_FORMAT, DICT_PATH, decodeShard, type DictIndex, type DictShard } from './format.ts'
import { Dictionary, type DictionaryOptions } from './lookup.ts'

/** The Cache Storage cache the index and shards live in. */
export const DICT_CACHE = 'interlinear-dict'

/** The index's own URL (versionless: there is one current index). */
export function indexUrl(base: string): string {
  return new URL(`${DICT_PATH}index.json`, new URL(base, location.href)).href
}

/** A shard's URL for one version of the dictionary; the query keeps versions apart in the cache. */
export function shardUrl(base: string, file: string, version: string): string {
  const url = new URL(`${DICT_PATH}${file}`, new URL(base, location.href))
  url.searchParams.set('v', version)
  return url.href
}

async function openCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null
  try {
    return await caches.open(DICT_CACHE)
  } catch (err) {
    console.warn('Cache Storage is not available; the dictionary will not be kept offline', err)
    return null
  }
}

/** Fetch a same-origin static file; throws on a non-OK status so callers never cache an error page. */
async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res
}

function checkIndex(index: unknown): DictIndex {
  const i = index as Partial<DictIndex>
  if (typeof i !== 'object' || i === null || i.format !== DICT_FORMAT || typeof i.version !== 'string' || typeof i.shards !== 'object') {
    throw new Error('not a dictionary index')
  }
  return i as DictIndex
}

/** The dictionary's files for one site base, over Cache Storage. */
export class DictStore {
  readonly base: string
  readonly index: DictIndex
  private readonly cache: Cache | null

  private constructor(base: string, index: DictIndex, cache: Cache | null) {
    this.base = base
    this.index = index
    this.cache = cache
  }

  /**
   * Open the store: the cached `index.json` when there is one, else the network's, which is
   * then cached. Throws when neither is available (offline before the first open).
   */
  static async open(base: string = import.meta.env.BASE_URL): Promise<DictStore> {
    const cache = await openCache()
    const url = indexUrl(base)
    const cached = await cache?.match(url)
    if (cached !== undefined) return new DictStore(base, checkIndex(await cached.json()), cache)
    const res = await fetchOk(url)
    const index = checkIndex(await res.clone().json())
    await cache?.put(url, res)
    return new DictStore(base, index, cache)
  }

  /**
   * Fetch the current `index.json` from the network. When its version differs from the one in
   * use, the cached index is replaced, the previous version's shards are deleted, and the new
   * store is returned; otherwise this store is. Throws offline.
   */
  async refresh(): Promise<DictStore> {
    const url = indexUrl(this.base)
    const res = await fetchOk(url)
    const index = checkIndex(await res.clone().json())
    if (index.version === this.index.version) return this
    await this.cache?.put(url, res)
    const next = new DictStore(this.base, index, this.cache)
    await next.deleteOtherVersions()
    return next
  }

  /** Whether the shards can be kept at all; false without Cache Storage (a private window). */
  get persistent(): boolean {
    return this.cache !== null
  }

  /**
   * Make sure a shard of this version is in the cache, fetching it when it is not; nothing is
   * decoded or returned. The download of step 23 goes through here, one shard at a time.
   */
  async cacheShard(key: string): Promise<void> {
    const info = this.index.shards[key]
    if (info === undefined || this.cache === null) return
    const url = shardUrl(this.base, info.file, this.index.version)
    if ((await this.cache.match(url)) !== undefined) return
    await this.cache.put(url, await fetchOk(url))
  }

  /** Whether a shard of this version is in the cache. */
  async hasShard(key: string): Promise<boolean> {
    const info = this.index.shards[key]
    if (info === undefined || this.cache === null) return false
    return (await this.cache.match(shardUrl(this.base, info.file, this.index.version))) !== undefined
  }

  /**
   * The bytes of a shard: from the cache, else fetched and cached. Null for a key the index
   * does not list; throws when the shard is neither cached nor fetchable.
   */
  async fetchShard(key: string): Promise<Uint8Array | null> {
    const info = this.index.shards[key]
    if (info === undefined) return null
    const url = shardUrl(this.base, info.file, this.index.version)
    const cached = await this.cache?.match(url)
    if (cached !== undefined) return new Uint8Array(await cached.arrayBuffer())
    const res = await fetchOk(url)
    const bytes = new Uint8Array(await res.clone().arrayBuffer())
    await this.cache?.put(url, res)
    return bytes
  }

  /** A decoded shard, through {@link fetchShard}. */
  async loadShard(key: string): Promise<DictShard | null> {
    const bytes = await this.fetchShard(key)
    return bytes === null ? null : decodeShard(bytes)
  }

  /** Keys of the shards of this version that are in the cache. */
  async cachedShards(): Promise<string[]> {
    if (this.cache === null) return []
    const keys = new Set<string>()
    const files = new Map(Object.entries(this.index.shards).map(([key, info]) => [shardUrl(this.base, info.file, this.index.version), key]))
    for (const req of await this.cache.keys()) {
      const key = files.get(req.url)
      if (key !== undefined) keys.add(key)
    }
    return [...keys].sort()
  }

  /** Remove cached shards whose version query is not this store's version. */
  async deleteOtherVersions(): Promise<number> {
    if (this.cache === null) return 0
    const dir = new URL(DICT_PATH, new URL(this.base, location.href)).href
    let n = 0
    for (const req of await this.cache.keys()) {
      if (!req.url.startsWith(dir) || req.url === indexUrl(this.base)) continue
      if (new URL(req.url).searchParams.get('v') === this.index.version) continue
      if (await this.cache.delete(req)) n++
    }
    return n
  }

  /** A {@link Dictionary} reading its shards from this store. */
  dictionary(options?: DictionaryOptions): Dictionary {
    return new Dictionary((key) => this.loadShard(key), options)
  }
}

let opening: Promise<DictStore> | null = null

/**
 * The app's one dictionary store, opened on first use and shared. A failed open is not kept,
 * so the next call tries again (the first open needs the network once).
 */
export function dictStore(base?: string): Promise<DictStore> {
  if (opening === null) {
    opening = DictStore.open(base).catch((err: unknown) => {
      opening = null
      throw err
    })
  }
  return opening
}

let shared: Dictionary | null = null

/**
 * The app's one {@link Dictionary}. Its loader goes through {@link dictStore} on every shard,
 * so a store adopted later (a new version, step 23) is read at once; the LRU is cleared then.
 */
export function dictionary(): Dictionary {
  if (shared === null) shared = new Dictionary((key) => dictStore().then((store) => store.loadShard(key)))
  return shared
}

/**
 * Make `next` the store {@link dictStore} and {@link dictionary} read from, after a
 * {@link DictStore.refresh} found a newer version. Decoded shards of the old one are dropped.
 */
export function adoptDictStore(next: DictStore): void {
  opening = Promise.resolve(next)
  shared?.shards.clear()
}
