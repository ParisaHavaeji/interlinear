/**
 * The dictionary's first-run download in the browser (plan.md step 23): the app's one
 * {@link DictState}, the run that moves it, and the hook Settings and the Library read it with.
 * Browser only (`navigator.onLine`, `window` events); the download itself is `download.ts`.
 *
 * {@link ensureDictionary} is called at launch (`main.tsx`, a moment after the first paint),
 * when Settings opens, on Retry, and whenever the connection comes back. One run at a time:
 *
 * 1. Open the store ({@link dictStore}: the cached index, else the network's) and list the
 *    cached shards. When every shard of the index is there the state is `ready` at once, so a
 *    launch offline, or any launch after the first, costs one `cache.keys()` and no request.
 * 2. Online, fetch the current `index.json` ({@link DictStore.refresh}). A new dictionary
 *    version (a rebuilt site) replaces the store the app reads through
 *    ({@link adoptDictStore}), drops the old shards, and the download starts over for the new
 *    ones; the old version answered lookups until then.
 * 3. Download the missing shards, four at a time, with progress by the index's byte counts.
 *
 * Going offline aborts the run and leaves the state `waiting`; the `online` event starts it
 * again, and since a shard is either cached or not, it continues where it stopped. A shard
 * that fails every attempt while online leaves `failed` with the error for Settings to show.
 */

import { useEffect, useState } from 'preact/hooks'
import { DownloadAborted, downloadShards, INITIAL_DICT_STATE, progressOf, type DictState } from './download.ts'
import { adoptDictStore, dictStore, type DictStore } from './shards.ts'

type Listener = (state: DictState) => void

let state: DictState = INITIAL_DICT_STATE
const listeners = new Set<Listener>()
let run: Promise<void> | null = null
let controller: AbortController | null = null
let listening = false

/** How often, at most, listeners hear about download progress alone (see {@link setProgress}). */
const PROGRESS_NOTIFY_MS = 250
let progressTimer: ReturnType<typeof setTimeout> | null = null

function notify(): void {
  if (progressTimer !== null) {
    clearTimeout(progressTimer)
    progressTimer = null
  }
  for (const fn of listeners) fn(state)
}

function set(patch: Partial<DictState>): void {
  state = { ...state, ...patch }
  notify()
}

/**
 * Progress alone: the state is current at once for {@link getDictState}, but listeners hear of
 * it at most every {@link PROGRESS_NOTIFY_MS}. The dictionary is some 560 shards, and the hook
 * re-renders the whole app, so one render per shard was most of the main thread's work on a
 * first launch (step 32). A phase change through {@link set} flushes at once.
 */
function setProgress(progress: DictState['progress']): void {
  state = { ...state, progress }
  if (progressTimer === null) progressTimer = setTimeout(notify, PROGRESS_NOTIFY_MS)
}

/** The dictionary's state right now. */
export function getDictState(): DictState {
  return state
}

/** Be told on every change. Returns the unsubscribe function. */
export function subscribeDictState(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Whether every shard of the current dictionary is on the device (the aligner's precondition). */
export function dictionaryReady(): boolean {
  return state.phase === 'ready'
}

/** The dictionary's state, re-rendering on every change. */
export function useDictState(): DictState {
  const [s, setS] = useState(getDictState)
  useEffect(() => {
    setS(getDictState())
    return subscribeDictState(setS)
  }, [])
  return s
}

const online = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const OFFLINE_FIRST_RUN = 'Needs an internet connection the first time'
const NO_CACHE = 'This browser cannot keep the dictionary on the device'

function listen(): void {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('online', () => {
    void ensureDictionary()
  })
  window.addEventListener('offline', () => {
    controller?.abort()
    if (state.phase === 'downloading' || state.phase === 'checking') set({ phase: 'waiting', checking: false })
  })
}

function indexOf(store: DictStore): DictState['index'] {
  return { version: store.index.version, built: store.index.built, sources: store.index.sources }
}

/**
 * Start a run when none is active, and return its promise (the active run's otherwise). A
 * `ready` dictionary is checked for a newer version when online; nothing else happens.
 */
export function ensureDictionary(): Promise<void> {
  listen()
  if (run === null) {
    run = install()
      .catch((err: unknown) => {
        console.error('Dictionary download failed', err)
        set({ phase: 'failed', error: message(err), checking: false })
      })
      .finally(() => {
        run = null
      })
  }
  return run
}

async function install(): Promise<void> {
  if (state.phase === 'ready') set({ checking: true })
  else set({ phase: 'checking', error: null, checking: false })

  let store: DictStore
  try {
    store = await dictStore()
  } catch (err) {
    set({ phase: 'unavailable', error: online() ? message(err) : OFFLINE_FIRST_RUN, checking: false })
    return
  }
  if (!store.persistent) {
    set({ phase: 'unavailable', index: indexOf(store), error: NO_CACHE, checking: false })
    return
  }

  // 1. What the device has.
  let cached = new Set(await store.cachedShards())
  let progress = progressOf(store.index.shards, cached)
  const complete = () => progress.doneShards === progress.totalShards
  if (complete()) set({ phase: 'ready', progress, index: indexOf(store), error: null })
  else set({ progress, index: indexOf(store) })

  // 2. A newer dictionary?
  if (online()) {
    try {
      const next = await store.refresh()
      if (next !== store) {
        adoptDictStore(next)
        store = next
        cached = new Set(await store.cachedShards())
        progress = progressOf(store.index.shards, cached)
        set({ phase: complete() ? 'ready' : 'checking', progress, index: indexOf(store), error: null })
      }
    } catch (err) {
      // The cached index serves; a check that fails offline or against a dead server is not an error.
      console.warn('Could not check for a newer dictionary', err)
    }
  }
  if (complete()) {
    set({ phase: 'ready', checking: false })
    return
  }
  if (!online()) {
    set({ phase: 'waiting', checking: false })
    return
  }

  // 3. The download.
  const current = store
  controller = new AbortController()
  set({ phase: 'downloading', checking: false, error: null })
  try {
    progress = await downloadShards(store.index.shards, cached, (key) => current.cacheShard(key), {
      signal: controller.signal,
      onProgress: setProgress,
    })
    set({ phase: 'ready', progress, error: null })
  } catch (err) {
    if (err instanceof DownloadAborted || !online()) set({ phase: 'waiting' })
    else set({ phase: 'failed', error: message(err) })
  } finally {
    controller = null
  }
}
