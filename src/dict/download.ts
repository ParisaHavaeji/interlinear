/**
 * Downloading the whole dictionary (plan.md step 23, §1.3): the platform-free part. The
 * aligner's lexical scoring needs every shard on the device, and a reader offline needs the
 * ones a tap will touch, so on first run the app fetches all of them into the dictionary's
 * Cache Storage cache in the background and reports progress in Settings.
 *
 * This module knows nothing of the browser: {@link downloadShards} is given the index's shard
 * list, the keys already cached, and a function that fetches one shard into the cache, and it
 * drives the rest: the missing shards in a fixed order, a few at a time, progress in bytes
 * taken from the index (the gzipped sizes `tools/build-dict` recorded), retries with a pause
 * when a fetch fails, and a clean stop on an abort signal. `dict/installer.ts` wires it to
 * `DictStore`, the network's online/offline events and the UI.
 *
 * A download is **resumable** by construction: a shard is either in the cache or not, so an
 * interrupted run picks up where it stopped on the next launch, with nothing to record.
 */

import type { ShardInfo } from './format.ts'

/** How a shard download stands, as reported after every shard. */
export interface DownloadProgress {
  /** Shards of the index that are in the cache, including those cached before this run. */
  doneShards: number
  totalShards: number
  /** Bytes of those shards, per the index. */
  doneBytes: number
  totalBytes: number
}

export interface DownloadOptions {
  /** Shards fetched at once. */
  concurrency?: number
  /** Attempts per shard before the download fails. */
  attempts?: number
  /** Milliseconds waited after a failed attempt before the next; doubled on each retry. */
  retryDelay?: number
  /** Called after every shard that lands and once at the start. */
  onProgress?: (progress: DownloadProgress) => void
  /** Stops the download; the promise then rejects with {@link DownloadAborted}. */
  signal?: AbortSignal
  /** Sleep used between retries; injected by tests. */
  sleep?: (ms: number) => Promise<void>
}

export class DownloadAborted extends Error {
  override name = 'DownloadAborted'
  constructor() {
    super('Dictionary download stopped')
  }
}

/** Progress for a set of cached keys over an index, before any download. */
export function progressOf(shards: Readonly<Record<string, ShardInfo>>, cached: ReadonlySet<string>): DownloadProgress {
  let doneShards = 0
  let doneBytes = 0
  let totalShards = 0
  let totalBytes = 0
  for (const [key, info] of Object.entries(shards)) {
    totalShards++
    totalBytes += info.bytes
    if (cached.has(key)) {
      doneShards++
      doneBytes += info.bytes
    }
  }
  return { doneShards, totalShards, doneBytes, totalBytes }
}

/** The keys an index lists that a cache lacks, in the index's order. */
export function missingShards(shards: Readonly<Record<string, ShardInfo>>, cached: ReadonlySet<string>): string[] {
  return Object.keys(shards).filter((key) => !cached.has(key))
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Fetch every shard of `shards` that `cached` lacks, through `fetchShard`, which must leave
 * the shard in the cache. Resolves with the final progress once all are in; rejects with the
 * last error when a shard fails every attempt (the shards already fetched stay cached, so a
 * later call continues), or with {@link DownloadAborted} when the signal fires.
 */
export async function downloadShards(
  shards: Readonly<Record<string, ShardInfo>>,
  cached: ReadonlySet<string>,
  fetchShard: (key: string) => Promise<void>,
  options: DownloadOptions = {},
): Promise<DownloadProgress> {
  const concurrency = Math.max(1, options.concurrency ?? 4)
  const attempts = Math.max(1, options.attempts ?? 3)
  const retryDelay = options.retryDelay ?? 1000
  const sleep = options.sleep ?? defaultSleep
  const signal = options.signal
  const progress = progressOf(shards, cached)
  options.onProgress?.({ ...progress })

  const queue = missingShards(shards, cached)
  let failure: unknown = null
  const aborted = () => signal?.aborted === true

  const fetchWithRetries = async (key: string): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      if (aborted()) throw new DownloadAborted()
      try {
        await fetchShard(key)
        return
      } catch (err) {
        if (aborted()) throw new DownloadAborted()
        if (attempt >= attempts) throw err
        await sleep(retryDelay * 2 ** (attempt - 1))
      }
    }
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      if (failure !== null || aborted()) return
      const key = queue.shift()
      if (key === undefined) return
      try {
        await fetchWithRetries(key)
      } catch (err) {
        if (failure === null) failure = err
        return
      }
      progress.doneShards++
      progress.doneBytes += shards[key].bytes
      options.onProgress?.({ ...progress })
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  if (failure !== null) throw failure
  if (aborted()) throw new DownloadAborted()
  return progress
}

/** "0.4 MB", "10.4 MB", "312 KB": a size for the Settings rows. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`
  return `${bytes} B`
}

// ---------------------------------------------------------------------------------------------
// The dictionary's state on the device, as Settings shows it

/**
 * Where the dictionary stands on this device:
 *
 * - `checking`: the index is being opened and the cache listed (a moment after launch).
 * - `downloading`: shards are coming in; `progress` moves.
 * - `waiting`: shards are missing and the device is offline; the download resumes when the
 *   connection returns.
 * - `failed`: a shard failed every attempt while online; `error` says why, Retry is offered.
 * - `unavailable`: the index could not be opened at all: offline before the first run, or the
 *   browser has no Cache Storage (a private window), so the dictionary cannot be kept.
 * - `ready`: every shard of the current version is cached; lookups and alignment work offline.
 */
export type DictPhase = 'checking' | 'downloading' | 'waiting' | 'failed' | 'unavailable' | 'ready'

export interface DictState {
  phase: DictPhase
  /** Null until the index is open. */
  progress: DownloadProgress | null
  /** The index in use, once open. */
  index: { version: string; built: string; sources: { name: string; version?: string }[] } | null
  /** `failed` and `unavailable`: what went wrong, for the row. */
  error: string | null
  /** `ready` only: a newer dictionary is being looked for right now. */
  checking: boolean
}

export const INITIAL_DICT_STATE: DictState = { phase: 'checking', progress: null, index: null, error: null, checking: false }

/** Whole percent of a progress, by bytes; 0 for an empty index. */
export function percentOf(progress: DownloadProgress | null): number {
  if (progress === null || progress.totalBytes === 0) return 0
  return Math.floor((progress.doneBytes / progress.totalBytes) * 100)
}

/** The detail text of the Settings row: "Downloading… 43% · 4.5 of 10.4 MB". */
export function dictStateLabel(state: DictState): string {
  const p = state.progress
  switch (state.phase) {
    case 'checking':
      return 'Checking…'
    case 'downloading':
      return p === null ? 'Downloading…' : `Downloading… ${percentOf(p)}% · ${formatBytes(p.doneBytes)} of ${formatBytes(p.totalBytes)}`
    case 'waiting':
      return p === null || p.doneBytes === 0 ? 'Waiting for a connection' : `Waiting for a connection · ${percentOf(p)}%`
    case 'failed':
      return `Couldn’t download${state.error === null ? '' : `: ${state.error}`}`
    case 'unavailable':
      return state.error ?? 'Not available'
    case 'ready':
      if (state.checking) return 'Checking for updates…'
      return p === null ? 'Ready' : `Ready · ${formatBytes(p.totalBytes)} on this device`
  }
}

/** A few words for the Library's status line: "Dictionary 43%", "Dictionary ready"; empty when there is nothing to say. */
export function dictStateShort(state: DictState): string {
  switch (state.phase) {
    case 'downloading':
      return `Dictionary ${percentOf(state.progress)}%`
    case 'waiting':
      return 'Dictionary waiting for a connection'
    case 'failed':
      return 'Dictionary download failed'
    case 'ready':
      return 'Dictionary ready'
    default:
      return ''
  }
}
