/**
 * The sync in the browser (plan.md step 36): the Supabase project from the build's environment,
 * the session in `localStorage`, the OAuth redirect in and out of the page, the engine's life
 * with the session's, and the pulls that the network and the page's visibility trigger. The
 * Account group in Settings reads {@link useAccountState} and calls the actions below.
 *
 * Without `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` at build time the sync is simply not
 * there: no Account group, nothing started.
 */

import { useEffect, useState } from 'preact/hooks'
import type { Book } from '../store/db.ts'
import { getSetting, setSetting } from '../store/settings.ts'
import { resetPushed } from '../store/sync.ts'
import { SyncEngine, supabaseRemote, type RemoteBook, type SyncState } from './engine.ts'
import { authorizeUrl, challengeOf, newVerifier, parseCallback, SupabaseClient, type SessionUser, type SupabaseConfig } from './supabase.ts'

export interface AccountState {
  /** The build has a Supabase project. */
  configured: boolean
  user: SessionUser | null
  /** Between coming back from Google and the session being there. */
  signingIn: boolean
  sync: SyncState
  /** What stopped the last sign-in, shown once. */
  signInError: string | null
  /** Step 37: the books themselves sync ("Sync books" in Settings). */
  bookSync: boolean
  /** The account's books that are not on this device. */
  remoteBooks: RemoteBook[]
  /** Keys of the books being downloaded now. */
  downloading: string[]
}

/** The settings row of "Sync books" (step 37); on unless turned off. */
export const SYNC_BOOKS_KEY = 'syncBooks'
const syncBooksOf = (v: unknown): boolean => v !== false

const VERIFIER_KEY = 'interlinear.pkce'
/** A verifier older than this is not used: the round trip through Google took too long. */
const VERIFIER_TTL = 10 * 60_000
/** Pulls caused by the app being shown again come at most this often. */
const PULL_THROTTLE = 30_000

function configOf(): SupabaseConfig | null {
  const env = import.meta.env as Record<string, string | undefined>
  const url = env.VITE_SUPABASE_URL?.trim().replace(/\/+$/, '')
  const anonKey = env.VITE_SUPABASE_ANON_KEY?.trim()
  return url && anonKey ? { url, anonKey } : null
}

const config = configOf()
let client: SupabaseClient | null = null
let engine: SyncEngine | null = null
let lastPull = 0

let state: AccountState = {
  configured: config !== null,
  user: null,
  signingIn: false,
  sync: { phase: 'idle', lastSync: null, error: null },
  signInError: null,
  bookSync: true,
  remoteBooks: [],
  downloading: [],
}
const listeners = new Set<(s: AccountState) => void>()

function setState(patch: Partial<AccountState>): void {
  state = { ...state, ...patch }
  for (const fn of listeners) fn(state)
}

export function getAccountState(): AccountState {
  return state
}

export function subscribeAccountState(fn: (s: AccountState) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function useAccountState(): AccountState {
  const [s, setS] = useState(getAccountState)
  useEffect(() => {
    setS(getAccountState())
    return subscribeAccountState(setS)
  }, [])
  return s
}

function getClient(): SupabaseClient | null {
  if (config === null) return null
  if (client === null) {
    client = new SupabaseClient(config, {
      storage: localStorage,
      onSession: (session) => {
        setState({ user: session?.user ?? null })
        if (session === null) stopEngine(true)
      },
    })
  }
  return client
}

/** Where Supabase sends the browser back to: the app's root on this origin. */
function redirectTarget(): string {
  return new URL(import.meta.env.BASE_URL, location.origin).href
}

/**
 * Take the OAuth answer out of the page's URL, if there is one, before the app renders: the
 * query is replaced by the Settings route so a reload does not exchange the code twice and the
 * screen that opens is the one with the Account group. Returns what was found for {@link startSync}.
 */
export function claimOAuthCallback(): ReturnType<typeof parseCallback> {
  if (config === null) return null
  const found = parseCallback(location.search, location.hash)
  if (found === null) return null
  history.replaceState(null, '', `${import.meta.env.BASE_URL}#/settings`)
  if ('code' in found) setState({ signingIn: true })
  else setState({ signInError: found.error })
  return found
}

/** Start the sync: finish a sign-in the page came back with, then run the engine for the session there is. */
export async function startSync(callback: ReturnType<typeof parseCallback>): Promise<void> {
  const c = getClient()
  if (c === null) return
  if (callback !== null && 'code' in callback) {
    try {
      const verifier = takeVerifier()
      if (verifier === null) throw new Error('The sign-in took too long. Please try again.')
      await c.exchangeCode(callback.code, verifier)
      setState({ signInError: null })
    } catch (err) {
      console.error('sign-in failed', err)
      setState({ signInError: err instanceof Error ? err.message : 'Could not sign in.' })
    } finally {
      setState({ signingIn: false })
    }
  }
  setState({ user: c.session?.user ?? null })
  if (c.session !== null) startEngine(c)
  window.addEventListener('online', () => void pull(true))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void pull(false)
  })
}

function startEngine(c: SupabaseClient): void {
  if (engine !== null) return
  const started = new SyncEngine(supabaseRemote(c), {
    books: state.bookSync,
    onState: (sync) => setState({ sync }),
    onRemoteBooks: (remoteBooks) => setState({ remoteBooks }),
  })
  engine = started
  lastPull = Date.now()
  // The switch is read before the first pull, so a device with it off uploads nothing.
  void getSetting(SYNC_BOOKS_KEY, syncBooksOf)
    .catch(() => true)
    .then((bookSync) => {
      if (engine !== started) return
      setState({ bookSync })
      started.setBookSync(bookSync)
      started.start()
      void started.pull()
    })
}

function stopEngine(forgetPushes: boolean): void {
  engine?.stop()
  engine = null
  setState({ sync: { phase: 'idle', lastSync: null, error: null }, remoteBooks: [], downloading: [] })
  if (forgetPushes) void resetPushed()
}

async function pull(force: boolean): Promise<void> {
  if (engine === null) return
  if (!force && Date.now() - lastPull < PULL_THROTTLE) return
  lastPull = Date.now()
  await engine.pull()
}

function takeVerifier(): string | null {
  try {
    const raw = localStorage.getItem(VERIFIER_KEY)
    localStorage.removeItem(VERIFIER_KEY)
    if (raw === null) return null
    const { verifier, at } = JSON.parse(raw) as { verifier?: unknown; at?: unknown }
    if (typeof verifier !== 'string' || typeof at !== 'number' || Date.now() - at > VERIFIER_TTL) return null
    return verifier
  } catch {
    return null
  }
}

/** Leave for Google. The page comes back to the app's root with `?code=`, which {@link claimOAuthCallback} picks up. */
export async function signInWithGoogle(): Promise<void> {
  if (config === null) return
  const verifier = newVerifier()
  localStorage.setItem(VERIFIER_KEY, JSON.stringify({ verifier, at: Date.now() }))
  setState({ signInError: null })
  location.assign(authorizeUrl(config, 'google', redirectTarget(), await challengeOf(verifier)))
}

/** Sign out here and on the server; the state on this device stays, and the pushes are forgotten for the next account. */
export async function signOut(): Promise<void> {
  const c = getClient()
  if (c === null) return
  stopEngine(true)
  await c.signOut()
}

/** Pull and push now, whatever the throttle says (Settings' Sync Now, and after a book is imported). */
export function syncNow(): Promise<void> {
  return pull(true)
}

/** The sync is set up in this build and someone is signed in. */
export function syncActive(): boolean {
  return engine !== null
}

/** Books sync too (step 37): signed in, with "Sync books" on. */
export function bookSyncActive(): boolean {
  return engine !== null && engine.syncsBooks
}

/** Turn "Sync books" on or off (step 37); on, a pull follows to catch up. */
export async function setBookSync(on: boolean): Promise<void> {
  setState({ bookSync: on })
  engine?.setBookSync(on)
  await setSetting(SYNC_BOOKS_KEY, on)
  if (on) await pull(true)
}

/** Download a book of the account onto this device (step 37). Rejects with the reason on failure. */
export async function downloadBook(key: string): Promise<Book> {
  if (engine === null) throw new Error('Not signed in')
  setState({ downloading: [...state.downloading, key] })
  try {
    return await engine.download(key)
  } finally {
    setState({ downloading: state.downloading.filter((k) => k !== key) })
  }
}

/** Download every book of the account not on this device (Settings' Download All). Resolves with the number that failed. */
export async function downloadAll(): Promise<number> {
  let failed = 0
  for (const book of [...state.remoteBooks]) {
    try {
      await downloadBook(book.key)
    } catch (err) {
      console.warn('could not download', book.title, err)
      failed++
    }
  }
  return failed
}

/** Delete a book from the account, bundle and reading state (step 37's "Delete everywhere"). The copy here is the caller's. */
export async function removeFromAccount(bookId: string): Promise<void> {
  if (engine === null) throw new Error('Not signed in')
  await engine.removeFromAccount(bookId)
}
