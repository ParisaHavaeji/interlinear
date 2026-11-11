/** Hash routes of the app shell: `#/read/<bookId>[/<chapter>]`, `#/debug/<bookId>`, `#/settings`, else the Library. */

export type Route = { screen: 'library' } | { screen: 'read'; bookId: string; chapter: number } | { screen: 'debug'; bookId: string } | { screen: 'settings' }

export function parseRoute(hash: string): Route {
  const read = /^#\/read\/([^/]+)(?:\/(\d+))?$/.exec(hash)
  if (read !== null) return { screen: 'read', bookId: decodeURIComponent(read[1]), chapter: read[2] === undefined ? 0 : Number(read[2]) }
  const debug = /^#\/debug\/([^/]+)$/.exec(hash)
  if (debug !== null) return { screen: 'debug', bookId: decodeURIComponent(debug[1]) }
  if (hash === SETTINGS_HASH) return { screen: 'settings' }
  return { screen: 'library' }
}

export function readHash(bookId: string, chapter: number): string {
  return chapter === 0 ? `#/read/${encodeURIComponent(bookId)}` : `#/read/${encodeURIComponent(bookId)}/${chapter}`
}

export function debugHash(bookId: string): string {
  return `#/debug/${encodeURIComponent(bookId)}`
}

export const SETTINGS_HASH = '#/settings'
