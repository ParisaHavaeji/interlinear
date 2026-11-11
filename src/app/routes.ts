/**
 * Hash routes of the app shell: `#/read/<bookId>[/<chapter>[/<bookmarkId>]]`, `#/bookmarks`
 * (every book's) and `#/bookmarks/<bookId>/<chapter>` (one book's, opened from the Reader at
 * that chapter, which is where Back returns), `#/debug/<bookId>`, `#/settings`, else the Library.
 * A bookmark id on the reader route asks the Reader to open at that bookmark (plan.md step 26).
 */

export type Route =
  | { screen: 'library' }
  | { screen: 'read'; bookId: string; chapter: number; at?: string }
  | { screen: 'bookmarks'; book?: { id: string; chapter: number } }
  | { screen: 'debug'; bookId: string }
  | { screen: 'settings' }

export function parseRoute(hash: string): Route {
  const read = /^#\/read\/([^/]+)(?:\/(\d+)(?:\/([^/]+))?)?$/.exec(hash)
  if (read !== null) {
    const route: Route = { screen: 'read', bookId: decodeURIComponent(read[1]), chapter: read[2] === undefined ? 0 : Number(read[2]) }
    if (read[3] !== undefined) route.at = decodeURIComponent(read[3])
    return route
  }
  const bookmarks = /^#\/bookmarks(?:\/([^/]+)\/(\d+))?$/.exec(hash)
  if (bookmarks !== null) {
    return bookmarks[1] === undefined ? { screen: 'bookmarks' } : { screen: 'bookmarks', book: { id: decodeURIComponent(bookmarks[1]), chapter: Number(bookmarks[2]) } }
  }
  const debug = /^#\/debug\/([^/]+)$/.exec(hash)
  if (debug !== null) return { screen: 'debug', bookId: decodeURIComponent(debug[1]) }
  if (hash === SETTINGS_HASH) return { screen: 'settings' }
  return { screen: 'library' }
}

/** The reader at a chapter; with `at`, opened at that bookmark. */
export function readHash(bookId: string, chapter: number, at?: string): string {
  if (at !== undefined) return `#/read/${encodeURIComponent(bookId)}/${chapter}/${encodeURIComponent(at)}`
  return chapter === 0 ? `#/read/${encodeURIComponent(bookId)}` : `#/read/${encodeURIComponent(bookId)}/${chapter}`
}

/** The bookmarks of every book, or of one book when opened from its Reader at `chapter`. */
export function bookmarksHash(book?: { id: string; chapter: number }): string {
  return book === undefined ? BOOKMARKS_HASH : `#/bookmarks/${encodeURIComponent(book.id)}/${book.chapter}`
}

export function debugHash(bookId: string): string {
  return `#/debug/${encodeURIComponent(bookId)}`
}

export const SETTINGS_HASH = '#/settings'
export const BOOKMARKS_HASH = '#/bookmarks'
