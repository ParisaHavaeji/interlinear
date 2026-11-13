import { describe, expect, it } from 'vitest'
import {
  authorizeUrl,
  challengeOf,
  newVerifier,
  parseCallback,
  SupabaseClient,
  SupabaseError,
  type FetchLike,
  type KeyValueStorage,
  type Session,
} from '../src/sync/supabase.ts'

const CONFIG = { url: 'https://abc.supabase.co', anonKey: 'anon-key' }

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

/** A fake server: answers by URL substring, in order of the handlers given, recording every call. */
function fakeFetch(handlers: { match: string; status?: number; body?: unknown }[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: JSON.parse(init.body) }) })
    const h = handlers.find((h) => url.includes(h.match))
    if (h === undefined) return { status: 404, ok: false, text: async () => '{"message":"no handler"}' }
    const status = h.status ?? 200
    return { status, ok: status < 300, text: async () => (h.body === undefined ? '' : JSON.stringify(h.body)) }
  }
  return { fetch, calls }
}

const TOKEN = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_in: 3600,
  user: { id: 'user-1', email: 'reader@example.com', user_metadata: { full_name: 'A Reader', avatar_url: 'https://img/avatar.png' } },
}

const session = (over: Partial<Session> = {}): Session => ({
  accessToken: 'access-0',
  refreshToken: 'refresh-0',
  expiresAt: 10_000,
  user: { id: 'user-1', email: 'reader@example.com', name: null, avatar: null },
  ...over,
})

describe('PKCE', () => {
  it('makes a 43-character base64url verifier', () => {
    const v = newVerifier()
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newVerifier()).not.toBe(v)
  })

  it('derives the S256 challenge of RFC 7636 appendix B', async () => {
    expect(await challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('builds the authorize URL for Google with the challenge and the return address', () => {
    const url = new URL(authorizeUrl(CONFIG, 'google', 'https://x.github.io/interlinear/', 'chal'))
    expect(url.origin + url.pathname).toBe('https://abc.supabase.co/auth/v1/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      provider: 'google',
      redirect_to: 'https://x.github.io/interlinear/',
      code_challenge: 'chal',
      code_challenge_method: 's256',
    })
  })
})

describe('parseCallback', () => {
  it('finds the code in the query', () => {
    expect(parseCallback('?code=abc-123')).toEqual({ code: 'abc-123' })
    expect(parseCallback('?code=abc-123', '#/settings')).toEqual({ code: 'abc-123' })
  })

  it('finds an error in the query or the fragment, preferring the description', () => {
    expect(parseCallback('?error=access_denied&error_description=User+said+no')).toEqual({ error: 'User said no' })
    expect(parseCallback('', '#error=server_error')).toEqual({ error: 'server_error' })
  })

  it('is null for an ordinary page load', () => {
    expect(parseCallback('', '')).toBeNull()
    expect(parseCallback('', '#/read/abc')).toBeNull()
    expect(parseCallback('?utm=1')).toBeNull()
  })
})

describe('SupabaseClient', () => {
  it('exchanges the code with the verifier and keeps the session with the user', async () => {
    const { fetch, calls } = fakeFetch([{ match: 'grant_type=pkce', body: TOKEN }])
    const storage = memoryStorage()
    const seen: (Session | null)[] = []
    const client = new SupabaseClient(CONFIG, { fetch, storage, now: () => 1000, onSession: (s) => seen.push(s) })
    expect(client.session).toBeNull()

    const s = await client.exchangeCode('the-code', 'the-verifier')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://abc.supabase.co/auth/v1/token?grant_type=pkce')
    expect(calls[0].headers.apikey).toBe('anon-key')
    expect(calls[0].body).toEqual({ auth_code: 'the-code', code_verifier: 'the-verifier' })
    expect(s).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: 4600,
      user: { id: 'user-1', email: 'reader@example.com', name: 'A Reader', avatar: 'https://img/avatar.png' },
    })
    expect(JSON.parse(storage.map.get('interlinear.session')!)).toEqual(s)
    expect(seen).toEqual([s])
    expect(client.session).toEqual(s)
  })

  it('reports the server’s reason when the exchange fails', async () => {
    const { fetch } = fakeFetch([{ match: 'grant_type=pkce', status: 400, body: { error: 'invalid_grant', error_description: 'code verifier mismatch' } }])
    const client = new SupabaseClient(CONFIG, { fetch, storage: memoryStorage() })
    await expect(client.exchangeCode('c', 'v')).rejects.toMatchObject({ name: 'SupabaseError', status: 400, message: 'code verifier mismatch' })
  })

  it('loads a stored session and signs REST requests with it', async () => {
    const storage = memoryStorage({ 'interlinear.session': JSON.stringify(session()) })
    const { fetch, calls } = fakeFetch([{ match: '/rest/v1/reading_state', body: [{ book_key: 'k', updated: 5 }] }])
    const client = new SupabaseClient(CONFIG, { fetch, storage, now: () => 1000 })
    expect(client.session?.accessToken).toBe('access-0')

    const rows = await client.rest('reading_state?select=book_key,updated')
    expect(rows).toEqual([{ book_key: 'k', updated: 5 }])
    expect(calls[0]).toMatchObject({
      url: 'https://abc.supabase.co/rest/v1/reading_state?select=book_key,updated',
      method: 'GET',
      headers: { apikey: 'anon-key', Authorization: 'Bearer access-0' },
    })
  })

  it('sends a body and extra headers, and reads an empty answer as null', async () => {
    const storage = memoryStorage({ 'interlinear.session': JSON.stringify(session()) })
    const { fetch, calls } = fakeFetch([{ match: '/rest/v1/reading_state', status: 201 }])
    const client = new SupabaseClient(CONFIG, { fetch, storage, now: () => 1000 })
    const out = await client.rest('reading_state', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: { a: 1 } })
    expect(out).toBeNull()
    expect(calls[0]).toMatchObject({ method: 'POST', headers: { Prefer: 'return=minimal', 'Content-Type': 'application/json' }, body: { a: 1 } })
  })

  it('refreshes a session about to expire before using it', async () => {
    const storage = memoryStorage({ 'interlinear.session': JSON.stringify(session({ expiresAt: 1030 })) })
    const { fetch, calls } = fakeFetch([
      { match: 'grant_type=refresh_token', body: { ...TOKEN, access_token: 'access-2', refresh_token: 'refresh-2' } },
      { match: '/rest/v1/', body: [] },
    ])
    const client = new SupabaseClient(CONFIG, { fetch, storage, now: () => 1000 })
    await client.rest('reading_state?select=book_key')
    expect(calls.map((c) => c.url)).toEqual(['https://abc.supabase.co/auth/v1/token?grant_type=refresh_token', 'https://abc.supabase.co/rest/v1/reading_state?select=book_key'])
    expect(calls[0].body).toEqual({ refresh_token: 'refresh-0' })
    expect(calls[1].headers.Authorization).toBe('Bearer access-2')
    expect(client.session).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: 4600 })
  })

  it('refreshes once on a 401 and retries the request', async () => {
    const storage = memoryStorage({ 'interlinear.session': JSON.stringify(session()) })
    let rest = 0
    const fetch: FetchLike = async (url, init) => {
      if (url.includes('grant_type=refresh_token')) return { status: 200, ok: true, text: async () => JSON.stringify({ ...TOKEN, access_token: 'access-2' }) }
      rest++
      if (init.headers.Authorization === 'Bearer access-0') return { status: 401, ok: false, text: async () => '{"message":"JWT expired"}' }
      return { status: 200, ok: true, text: async () => '[1]' }
    }
    const client = new SupabaseClient(CONFIG, { fetch, storage, now: () => 1000 })
    expect(await client.rest('reading_state')).toEqual([1])
    expect(rest).toBe(2)
  })

  it('signs out when the refresh token is refused, and keeps the session when the network failed', async () => {
    const refused = memoryStorage({ 'interlinear.session': JSON.stringify(session({ expiresAt: 1000 })) })
    const seen: (Session | null)[] = []
    const a = new SupabaseClient(CONFIG, {
      fetch: fakeFetch([{ match: 'grant_type=refresh_token', status: 400, body: { error: 'invalid_grant' } }]).fetch,
      storage: refused,
      now: () => 1000,
      onSession: (s) => seen.push(s),
    })
    await expect(a.rest('reading_state')).rejects.toBeInstanceOf(SupabaseError)
    expect(a.session).toBeNull()
    expect(refused.map.has('interlinear.session')).toBe(false)
    expect(seen).toEqual([null])

    const offline = memoryStorage({ 'interlinear.session': JSON.stringify(session({ expiresAt: 1000 })) })
    const b = new SupabaseClient(CONFIG, {
      fetch: async () => {
        throw new TypeError('Failed to fetch')
      },
      storage: offline,
      now: () => 1000,
    })
    await expect(b.rest('reading_state')).rejects.toThrow('Failed to fetch')
    expect(b.session?.refreshToken).toBe('refresh-0')
  })

  it('shares one refresh between concurrent requests', async () => {
    const storage = memoryStorage({ 'interlinear.session': JSON.stringify(session({ expiresAt: 1000 })) })
    const { fetch, calls } = fakeFetch([
      { match: 'grant_type=refresh_token', body: { ...TOKEN, access_token: 'access-2' } },
      { match: '/rest/v1/', body: [] },
    ])
    const client = new SupabaseClient(CONFIG, { fetch, storage, now: () => 1000 })
    await Promise.all([client.rest('a'), client.rest('b')])
    expect(calls.filter((c) => c.url.includes('refresh_token'))).toHaveLength(1)
  })

  it('signs out: forgets the session first, then tells the server', async () => {
    const storage = memoryStorage({ 'interlinear.session': JSON.stringify(session()) })
    const { fetch, calls } = fakeFetch([{ match: '/auth/v1/logout', status: 204 }])
    const client = new SupabaseClient(CONFIG, { fetch, storage })
    await client.signOut()
    expect(client.session).toBeNull()
    expect(calls[0]).toMatchObject({ url: 'https://abc.supabase.co/auth/v1/logout', method: 'POST', headers: { Authorization: 'Bearer access-0' } })
    await expect(client.rest('x')).rejects.toMatchObject({ status: 401 })
  })

  it('ignores a malformed stored session', () => {
    const client = new SupabaseClient(CONFIG, { fetch: fakeFetch([]).fetch, storage: memoryStorage({ 'interlinear.session': '{"accessToken":1}' }) })
    expect(client.session).toBeNull()
  })
})
