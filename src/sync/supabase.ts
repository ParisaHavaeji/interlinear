/**
 * A small Supabase client (plan.md step 36): the part of GoTrue and PostgREST that syncing the
 * reading state needs, written against `fetch` so it is platform-free and tested with a fake.
 * The app never holds a secret: it carries the project's public anon key, and every row it
 * touches is guarded by row-level security on the server (`supabase/schema.sql`), so the anon
 * key alone reads nothing.
 *
 * Sign-in is OAuth with PKCE through a full-page redirect, the flow that works inside an
 * installed iOS web app where popups do not: the app makes a verifier, keeps it, and sends the
 * browser to `/auth/v1/authorize` with the verifier's challenge; Supabase sends Google's answer
 * back to the app's URL with `?code=`, and {@link SupabaseClient.exchangeCode} turns the code
 * and the verifier into a session. A session is an access token (an hour), a refresh token and
 * the user; it is kept in the given storage and refreshed a minute before it runs out, or once
 * on a 401. A refresh that fails for good signs the user out.
 */

export interface SupabaseConfig {
  /** The project URL, `https://<ref>.supabase.co`, without a trailing slash. */
  url: string
  /** The project's public anon key. */
  anonKey: string
}

export interface SessionUser {
  id: string
  email: string | null
  /** The display name Google gave, else null. */
  name: string | null
  avatar: string | null
}

export interface Session {
  accessToken: string
  refreshToken: string
  /** Unix seconds. */
  expiresAt: number
  user: SessionUser
}

/** The slice of `fetch` the client uses; `globalThis.fetch` fits, and tests pass a fake. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>

/** Where the session lives between launches: `localStorage` in the app, a Map in tests. */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface SupabaseClientOptions {
  fetch?: FetchLike
  storage: KeyValueStorage
  /** The storage key of the session. */
  storageKey?: string
  /** Unix seconds now; injected by tests. */
  now?: () => number
  /** Called after every change of session: sign-in, refresh, sign-out (null). */
  onSession?: (session: Session | null) => void
}

export class SupabaseError extends Error {
  override name = 'SupabaseError'
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** Refresh when the access token has less than this left, in seconds. */
const REFRESH_MARGIN = 60

const BASE64URL = (bytes: Uint8Array): string => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A PKCE code verifier: 32 random bytes, base64url (43 characters). */
export function newVerifier(random: (bytes: Uint8Array<ArrayBuffer>) => void = (b) => crypto.getRandomValues(b)): string {
  const bytes = new Uint8Array(new ArrayBuffer(32))
  random(bytes)
  return BASE64URL(bytes)
}

/** The S256 challenge of a verifier (RFC 7636 §4.2). */
export async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return BASE64URL(new Uint8Array(digest))
}

/** The URL that starts Google sign-in; the browser is sent there and comes back to `redirectTo` with `?code=`. */
export function authorizeUrl(config: SupabaseConfig, provider: 'google', redirectTo: string, challenge: string): string {
  const params = new URLSearchParams({
    provider,
    redirect_to: redirectTo,
    code_challenge: challenge,
    code_challenge_method: 's256',
  })
  return `${config.url}/auth/v1/authorize?${params}`
}

/**
 * What the OAuth redirect brought back: the code to exchange, or the provider's error. Supabase
 * puts them in the query; an error from Google itself may come in the fragment.
 */
export function parseCallback(search: string, hash: string = ''): { code: string } | { error: string } | null {
  const query = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const code = query.get('code')
  if (code !== null && code !== '') return { code }
  const fragment = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const error = query.get('error_description') ?? query.get('error') ?? fragment.get('error_description') ?? fragment.get('error')
  return error === null ? null : { error }
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in?: number
  expires_at?: number
  user?: {
    id: string
    email?: string | null
    user_metadata?: Record<string, unknown>
  }
}

function errorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    for (const key of ['error_description', 'msg', 'message', 'error', 'hint']) {
      const v = parsed[key]
      if (typeof v === 'string' && v !== '') return v
    }
  } catch {
    // not JSON
  }
  return body.trim() !== '' ? body.trim().slice(0, 200) : `HTTP ${status}`
}

function sessionOf(token: TokenResponse, now: number): Session {
  const meta = token.user?.user_metadata ?? {}
  const str = (k: string): string | null => (typeof meta[k] === 'string' && meta[k] !== '' ? (meta[k] as string) : null)
  const expiresAt = typeof token.expires_at === 'number' ? token.expires_at : now + (token.expires_in ?? 3600)
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt,
    user: {
      id: token.user?.id ?? '',
      email: token.user?.email ?? null,
      name: str('full_name') ?? str('name') ?? null,
      avatar: str('avatar_url') ?? str('picture') ?? null,
    },
  }
}

function isSession(v: unknown): v is Session {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  const user = s.user as Record<string, unknown> | undefined
  return (
    typeof s.accessToken === 'string' &&
    typeof s.refreshToken === 'string' &&
    typeof s.expiresAt === 'number' &&
    typeof user === 'object' &&
    user !== null &&
    typeof user.id === 'string'
  )
}

export interface RestRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** Extra headers (`Prefer`, say). */
  headers?: Record<string, string>
  body?: unknown
}

export class SupabaseClient {
  readonly config: SupabaseConfig
  private readonly fetchImpl: FetchLike
  private readonly storage: KeyValueStorage
  private readonly storageKey: string
  private readonly now: () => number
  private readonly onSession: (session: Session | null) => void
  private current: Session | null
  private refreshing: Promise<Session | null> | null = null

  constructor(config: SupabaseConfig, options: SupabaseClientOptions) {
    this.config = config
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init))
    this.storage = options.storage
    this.storageKey = options.storageKey ?? 'interlinear.session'
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
    this.onSession = options.onSession ?? (() => undefined)
    this.current = this.load()
  }

  /** The session as stored, or null when signed out. */
  get session(): Session | null {
    return this.current
  }

  private load(): Session | null {
    try {
      const raw = this.storage.getItem(this.storageKey)
      if (raw === null) return null
      const parsed: unknown = JSON.parse(raw)
      return isSession(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  private set(session: Session | null): void {
    this.current = session
    try {
      if (session === null) this.storage.removeItem(this.storageKey)
      else this.storage.setItem(this.storageKey, JSON.stringify(session))
    } catch (err) {
      console.warn('could not store the session', err)
    }
    this.onSession(session)
  }

  private async token(grant: string, body: Record<string, string>): Promise<Session> {
    const res = await this.fetchImpl(`${this.config.url}/auth/v1/token?grant_type=${grant}`, {
      method: 'POST',
      headers: { apikey: this.config.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new SupabaseError(errorMessage(res.status, text), res.status)
    return sessionOf(JSON.parse(text) as TokenResponse, this.now())
  }

  /** Finish the redirect: the `code` Supabase sent back and the verifier kept before leaving. */
  async exchangeCode(code: string, verifier: string): Promise<Session> {
    const session = await this.token('pkce', { auth_code: code, code_verifier: verifier })
    this.set(session)
    return session
  }

  /**
   * A fresh session from the refresh token. One refresh at a time; a second caller waits for
   * it. Resolves null, signed out, when the server refuses the token (revoked, or already used
   * from elsewhere); rejects when the network failed, so the session is kept and tried later.
   */
  refresh(): Promise<Session | null> {
    if (this.refreshing !== null) return this.refreshing
    const session = this.current
    if (session === null) return Promise.resolve(null)
    this.refreshing = this.token('refresh_token', { refresh_token: session.refreshToken })
      .then((fresh) => {
        this.set(fresh)
        return fresh
      })
      .catch((err: unknown) => {
        if (err instanceof SupabaseError && err.status >= 400 && err.status < 500) {
          this.set(null)
          return null
        }
        throw err
      })
      .finally(() => {
        this.refreshing = null
      })
    return this.refreshing
  }

  /** A session that is good for the next minute, refreshing when needed; null when signed out. */
  async validSession(): Promise<Session | null> {
    const session = this.current
    if (session === null) return null
    if (session.expiresAt - this.now() > REFRESH_MARGIN) return session
    return this.refresh()
  }

  /** Forget the session here and revoke it on the server (best effort: offline, the local half still happens). */
  async signOut(): Promise<void> {
    const session = this.current
    this.set(null)
    if (session === null) return
    try {
      await this.fetchImpl(`${this.config.url}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: this.config.anonKey, Authorization: `Bearer ${session.accessToken}` },
      })
    } catch {
      // The refresh token lives on until it expires; nothing more can be done offline.
    }
  }

  /**
   * A PostgREST request as the signed-in user: `path` is the table and query
   * (`reading_state?select=book_key`). Returns the parsed JSON body (null for an empty one).
   * Throws {@link SupabaseError} on a non-2xx answer and a plain error when signed out.
   */
  async rest<T = unknown>(path: string, request: RestRequest = {}): Promise<T> {
    let session = await this.validSession()
    if (session === null) throw new SupabaseError('Not signed in', 401)
    const send = (s: Session) =>
      this.fetchImpl(`${this.config.url}/rest/v1/${path}`, {
        method: request.method ?? 'GET',
        headers: {
          apikey: this.config.anonKey,
          Authorization: `Bearer ${s.accessToken}`,
          'Content-Type': 'application/json',
          ...request.headers,
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      })
    let res = await send(session)
    if (res.status === 401) {
      session = await this.refresh()
      if (session === null) throw new SupabaseError('Signed out', 401)
      res = await send(session)
    }
    const text = await res.text()
    if (!res.ok) throw new SupabaseError(errorMessage(res.status, text), res.status)
    return (text === '' ? null : JSON.parse(text)) as T
  }
}
