import { describe, expect, it } from 'vitest'
import { debugHash, parseRoute, readHash } from '../src/app/routes.ts'

describe('parseRoute', () => {
  it('reads the reader route with and without a chapter', () => {
    expect(parseRoute('#/read/abc')).toEqual({ screen: 'read', bookId: 'abc', chapter: 0 })
    expect(parseRoute('#/read/abc/7')).toEqual({ screen: 'read', bookId: 'abc', chapter: 7 })
    expect(parseRoute('#/read/a%2Fb%20c/2')).toEqual({ screen: 'read', bookId: 'a/b c', chapter: 2 })
  })

  it('reads the debug route', () => {
    expect(parseRoute('#/debug/abc')).toEqual({ screen: 'debug', bookId: 'abc' })
  })

  it('falls back to the library', () => {
    for (const hash of ['', '#', '#/', '#/read', '#/read/', '#/read/abc/x', '#/read/abc/1/2', '#/books/abc']) {
      expect(parseRoute(hash)).toEqual({ screen: 'library' })
    }
  })

  it('builds hashes that parse back', () => {
    expect(parseRoute(readHash('a/b', 0))).toEqual({ screen: 'read', bookId: 'a/b', chapter: 0 })
    expect(parseRoute(readHash('a/b', 3))).toEqual({ screen: 'read', bookId: 'a/b', chapter: 3 })
    expect(parseRoute(debugHash('a/b'))).toEqual({ screen: 'debug', bookId: 'a/b' })
    expect(readHash('x', 0)).toBe('#/read/x')
  })
})
