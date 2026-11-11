import { describe, expect, it } from 'vitest'
import {
  dictStateLabel,
  dictStateShort,
  DownloadAborted,
  downloadShards,
  formatBytes,
  INITIAL_DICT_STATE,
  missingShards,
  percentOf,
  progressOf,
  type DictState,
} from '../src/dict/download.ts'
import type { ShardInfo } from '../src/dict/format.ts'

const shards: Record<string, ShardInfo> = {
  aa: { file: 'aa.json.gz', bytes: 100, entries: 1, forms: 1 },
  ab: { file: 'ab.json.gz', bytes: 200, entries: 1, forms: 1 },
  ha: { file: 'ha.json.gz', bytes: 300, entries: 1, forms: 1 },
  zu: { file: 'zu.json.gz', bytes: 400, entries: 1, forms: 1 },
}

const noSleep = () => Promise.resolve()

describe('progressOf and missingShards', () => {
  it('count shards and bytes against the cache', () => {
    expect(progressOf(shards, new Set())).toEqual({ doneShards: 0, totalShards: 4, doneBytes: 0, totalBytes: 1000 })
    expect(progressOf(shards, new Set(['ab', 'zu']))).toEqual({ doneShards: 2, totalShards: 4, doneBytes: 600, totalBytes: 1000 })
    expect(missingShards(shards, new Set(['ab', 'zu']))).toEqual(['aa', 'ha'])
  })

  it('ignore cached keys the index does not list', () => {
    expect(progressOf(shards, new Set(['qx', 'aa'])).doneShards).toBe(1)
  })
})

describe('downloadShards', () => {
  it('fetches the missing shards in index order and reports progress after each', async () => {
    const fetched: string[] = []
    const seen: number[] = []
    const result = await downloadShards(shards, new Set(['ab']), async (key) => void fetched.push(key), {
      concurrency: 1,
      onProgress: (p) => seen.push(p.doneBytes),
    })
    expect(fetched).toEqual(['aa', 'ha', 'zu'])
    expect(seen).toEqual([200, 300, 600, 1000])
    expect(result).toEqual({ doneShards: 4, totalShards: 4, doneBytes: 1000, totalBytes: 1000 })
  })

  it('resolves at once when everything is cached', async () => {
    let calls = 0
    const result = await downloadShards(shards, new Set(Object.keys(shards)), async () => void calls++)
    expect(calls).toBe(0)
    expect(result.doneShards).toBe(4)
  })

  it('never has more fetches in flight than the concurrency', async () => {
    let inFlight = 0
    let peak = 0
    const fetchShard = async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 2))
      inFlight--
    }
    await downloadShards(shards, new Set(), fetchShard, { concurrency: 2 })
    expect(peak).toBe(2)
  })

  it('retries a failing shard with growing pauses, then goes on', async () => {
    const pauses: number[] = []
    let failures = 2
    const fetched: string[] = []
    await downloadShards(
      shards,
      new Set(['ha', 'zu']),
      async (key) => {
        if (key === 'aa' && failures-- > 0) throw new Error('HTTP 503')
        fetched.push(key)
      },
      { concurrency: 1, retryDelay: 10, sleep: async (ms) => void pauses.push(ms) },
    )
    expect(pauses).toEqual([10, 20])
    expect(fetched).toEqual(['aa', 'ab'])
  })

  it('fails with the shard’s error once the attempts are spent, keeping what landed', async () => {
    const fetched: string[] = []
    const seen: number[] = []
    await expect(
      downloadShards(
        shards,
        new Set(),
        async (key) => {
          if (key === 'ab') throw new Error('HTTP 404')
          fetched.push(key)
        },
        { concurrency: 1, attempts: 2, sleep: noSleep, onProgress: (p) => seen.push(p.doneShards) },
      ),
    ).rejects.toThrow('HTTP 404')
    // aa landed before ab failed; nothing after ab was started.
    expect(fetched).toEqual(['aa'])
    expect(seen).toEqual([0, 1])
  })

  it('stops on abort and rejects with DownloadAborted', async () => {
    const controller = new AbortController()
    const fetched: string[] = []
    const p = downloadShards(
      shards,
      new Set(),
      async (key) => {
        fetched.push(key)
        if (key === 'ab') controller.abort()
      },
      { concurrency: 1, signal: controller.signal },
    )
    await expect(p).rejects.toBeInstanceOf(DownloadAborted)
    expect(fetched).toEqual(['aa', 'ab'])
  })

  it('does not retry after an abort', async () => {
    const controller = new AbortController()
    let calls = 0
    const p = downloadShards(
      shards,
      new Set(),
      async () => {
        calls++
        controller.abort()
        throw new Error('network')
      },
      { concurrency: 1, sleep: noSleep, signal: controller.signal },
    )
    await expect(p).rejects.toBeInstanceOf(DownloadAborted)
    expect(calls).toBe(1)
  })
})

describe('labels', () => {
  const progress = { doneShards: 1, totalShards: 4, doneBytes: 4_500_000, totalBytes: 10_400_000 }
  const at = (patch: Partial<DictState>): DictState => ({ ...INITIAL_DICT_STATE, ...patch })

  it('formats sizes', () => {
    expect(formatBytes(10_388_151)).toBe('10.4 MB')
    expect(formatBytes(412_000)).toBe('412 KB')
    expect(formatBytes(1_400_000)).toBe('1.4 MB')
    expect(formatBytes(31_900)).toBe('32 KB')
    expect(formatBytes(12)).toBe('12 B')
  })

  it('computes whole percents by bytes', () => {
    expect(percentOf(null)).toBe(0)
    expect(percentOf(progress)).toBe(43)
    expect(percentOf({ ...progress, totalBytes: 0 })).toBe(0)
  })

  it('describes every phase for the Settings row', () => {
    expect(dictStateLabel(INITIAL_DICT_STATE)).toBe('Checking…')
    expect(dictStateLabel(at({ phase: 'downloading', progress }))).toBe('Downloading… 43% · 4.5 MB of 10.4 MB')
    expect(dictStateLabel(at({ phase: 'waiting', progress }))).toBe('Waiting for a connection · 43%')
    expect(dictStateLabel(at({ phase: 'waiting' }))).toBe('Waiting for a connection')
    expect(dictStateLabel(at({ phase: 'failed', error: 'HTTP 500' }))).toBe('Couldn’t download: HTTP 500')
    expect(dictStateLabel(at({ phase: 'unavailable', error: 'Needs an internet connection the first time' }))).toBe('Needs an internet connection the first time')
    expect(dictStateLabel(at({ phase: 'ready', progress: { ...progress, doneBytes: progress.totalBytes } }))).toBe('Ready · 10.4 MB on this device')
    expect(dictStateLabel(at({ phase: 'ready', checking: true }))).toBe('Checking for updates…')
  })

  it('keeps the status line short and quiet while checking', () => {
    expect(dictStateShort(INITIAL_DICT_STATE)).toBe('')
    expect(dictStateShort(at({ phase: 'unavailable' }))).toBe('')
    expect(dictStateShort(at({ phase: 'downloading', progress }))).toBe('Dictionary 43%')
    expect(dictStateShort(at({ phase: 'ready' }))).toBe('Dictionary ready')
  })
})
