import { describe, expect, it } from 'vitest'
import { BOOKMARKS_HASH, bookmarksHash, debugHash, parseRoute, readHash, SETTINGS_HASH } from '../src/app/routes.ts'

describe('parseRoute', () => {
  it('reads the reader route with and without a chapter', () => {
    // Without a chapter the book opens where it was last read (step 29).
    expect(parseRoute('#/read/abc')).toEqual({ screen: 'read', bookId: 'abc', chapter: null })
    expect(parseRoute('#/read/abc/0')).toEqual({ screen: 'read', bookId: 'abc', chapter: 0 })
    expect(parseRoute('#/read/abc/7')).toEqual({ screen: 'read', bookId: 'abc', chapter: 7 })
    expect(parseRoute('#/read/a%2Fb%20c/2')).toEqual({ screen: 'read', bookId: 'a/b c', chapter: 2 })
  })

  it('reads the bookmark to open at (step 26)', () => {
    expect(parseRoute('#/read/abc/7/bm-1')).toEqual({ screen: 'read', bookId: 'abc', chapter: 7, at: 'bm-1' })
    expect(parseRoute('#/read/abc/0/x%2Fy')).toEqual({ screen: 'read', bookId: 'abc', chapter: 0, at: 'x/y' })
    // A bookmark needs the chapter in front of it.
    expect(parseRoute('#/read/abc/bm-1')).toEqual({ screen: 'library' })
  })

  it('reads the bookmarks routes', () => {
    expect(parseRoute(BOOKMARKS_HASH)).toEqual({ screen: 'bookmarks' })
    expect(parseRoute('#/bookmarks/abc/3')).toEqual({ screen: 'bookmarks', book: { id: 'abc', chapter: 3 } })
    expect(parseRoute('#/bookmarks/a%2Fb/0')).toEqual({ screen: 'bookmarks', book: { id: 'a/b', chapter: 0 } })
    for (const hash of ['#/bookmarks/', '#/bookmarks/abc', '#/bookmarks/abc/x', '#/bookmarks/abc/1/2']) expect(parseRoute(hash)).toEqual({ screen: 'library' })
  })

  it('reads the debug route', () => {
    expect(parseRoute('#/debug/abc')).toEqual({ screen: 'debug', bookId: 'abc' })
  })

  it('reads the settings route', () => {
    expect(parseRoute(SETTINGS_HASH)).toEqual({ screen: 'settings' })
    expect(parseRoute('#/settings/')).toEqual({ screen: 'library' })
  })

  it('falls back to the library', () => {
    for (const hash of ['', '#', '#/', '#/read', '#/read/', '#/read/abc/x', '#/read/abc/1/2/3', '#/books/abc']) {
      expect(parseRoute(hash)).toEqual({ screen: 'library' })
    }
  })

  it('builds hashes that parse back', () => {
    expect(parseRoute(readHash('a/b', 0))).toEqual({ screen: 'read', bookId: 'a/b', chapter: 0 })
    expect(parseRoute(readHash('a/b', 3))).toEqual({ screen: 'read', bookId: 'a/b', chapter: 3 })
    expect(parseRoute(readHash('a/b', 0, 'id/1'))).toEqual({ screen: 'read', bookId: 'a/b', chapter: 0, at: 'id/1' })
    expect(parseRoute(bookmarksHash())).toEqual({ screen: 'bookmarks' })
    expect(parseRoute(bookmarksHash({ id: 'a/b', chapter: 4 }))).toEqual({ screen: 'bookmarks', book: { id: 'a/b', chapter: 4 } })
    expect(parseRoute(debugHash('a/b'))).toEqual({ screen: 'debug', bookId: 'a/b' })
    expect(parseRoute(readHash('a/b'))).toEqual({ screen: 'read', bookId: 'a/b', chapter: null })
    expect(readHash('x')).toBe('#/read/x')
    expect(readHash('x', 0)).toBe('#/read/x/0')
    expect(readHash('x', 0, 'b')).toBe('#/read/x/0/b')
    expect(readHash('x', null, 'b')).toBe('#/read/x/0/b')
  })
})
