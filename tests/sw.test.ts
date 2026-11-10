import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderServiceWorker, shellPrecacheList } from '../tools/pwa-sw.ts'

const template = readFileSync(new URL('../src/pwa/sw.js', import.meta.url), 'utf8')

describe('shell precache list', () => {
  it('includes the shell document, built files and static shell files', () => {
    const list = shellPrecacheList('/', ['assets/index-abc.js', 'assets/index-abc.css', 'index.html'])
    expect(list[0]).toBe('/')
    expect(list).toContain('/assets/index-abc.js')
    expect(list).toContain('/assets/index-abc.css')
    expect(list).toContain('/manifest.webmanifest')
    expect(list).toContain('/icons/apple-touch-icon-180.png')
  })

  it('drops source maps and follows a project base', () => {
    const list = shellPrecacheList('/interlinear/', ['assets/a.js', 'assets/a.js.map'])
    expect(list).toEqual(expect.not.arrayContaining(['/interlinear/assets/a.js.map']))
    expect(list.every((u) => u.startsWith('/interlinear/'))).toBe(true)
  })
})

describe('service worker template', () => {
  it('fills every placeholder and leaves none behind', () => {
    const sw = renderServiceWorker(template, {
      base: '/x/',
      precache: ['/x/', '/x/assets/a.js'],
      version: 'v1',
    })
    expect(sw).not.toMatch(/__[A-Z_]+__/)
    expect(sw).toContain('const BASE = "/x/"')
    expect(sw).toContain('const VERSION = "v1"')
    expect(sw).toContain('"/x/assets/a.js"')
  })

  it('ignores Vary when matching the cache, so crossorigin shell requests hit', () => {
    expect(template).toMatch(/ignoreVary:\s*true/)
    const matchCalls = template.match(/caches\s*\.\s*match\(/g) ?? []
    const matchCallsWithOptions = template.match(/caches\s*\.\s*match\([^)]*MATCH\)/g) ?? []
    expect(matchCalls.length).toBeGreaterThan(0)
    expect(matchCallsWithOptions.length).toBe(matchCalls.length)
  })

  it('throws when a placeholder is missing', () => {
    expect(() =>
      renderServiceWorker('nothing here', { base: '/', precache: [], version: 'v' }),
    ).toThrow(/__PRECACHE_MANIFEST__/)
  })
})
