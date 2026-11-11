import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isPrecachable, renderServiceWorker, shellFiles, shellPrecacheList, type OutputFile } from '../tools/pwa-sw.ts'

const template = readFileSync(new URL('../src/pwa/sw.js', import.meta.url), 'utf8')

describe('shell files', () => {
  it('follows static imports from the entry and leaves lazily imported chunks out', () => {
    const bundle: Record<string, OutputFile> = {
      'assets/index-1.js': { type: 'chunk', isEntry: true, imports: ['assets/preact-2.js'] },
      'assets/preact-2.js': { type: 'chunk', imports: [] },
      'assets/worker-3.js': { type: 'chunk', isEntry: true, imports: [] },
      'assets/neural-model-4.js': { type: 'chunk', imports: ['assets/transformers-5.js'] },
      'assets/transformers-5.js': { type: 'chunk', imports: [] },
      'assets/index-6.css': { type: 'asset' },
      'assets/ort-wasm-simd-threaded-7.wasm': { type: 'asset' },
    }
    const files = shellFiles(bundle)
    expect(files).toEqual(
      expect.arrayContaining(['assets/index-1.js', 'assets/preact-2.js', 'assets/worker-3.js', 'assets/index-6.css', 'assets/ort-wasm-simd-threaded-7.wasm']),
    )
    expect(files).not.toContain('assets/neural-model-4.js')
    expect(files).not.toContain('assets/transformers-5.js')
  })

  it('never precaches the ONNX runtime wasm, its glue script, the lazy model chunks, or source maps', () => {
    expect(isPrecachable('assets/index-1.js')).toBe(true)
    expect(isPrecachable('assets/worker-CEk9HgiG.js')).toBe(true)
    expect(isPrecachable('assets/neural-model-QHcngEn0.js')).toBe(false)
    expect(isPrecachable('assets/neural-wasm-Y3oN5E-B.js')).toBe(false)
    expect(isPrecachable('assets/ort-wasm-simd-threaded-7.wasm')).toBe(false)
    expect(isPrecachable('assets/ort-wasm-simd-threaded-8.mjs')).toBe(false)
    expect(isPrecachable('assets/a.js.map')).toBe(false)
    expect(shellPrecacheList('/', ['assets/ort-wasm-simd-threaded-7.wasm', 'assets/a.js'])).not.toContain('/assets/ort-wasm-simd-threaded-7.wasm')
  })
})

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

  it('leaves dictionary requests to the page, which caches them for longer than one app version', () => {
    expect(template).toMatch(/url\.pathname\.startsWith\(BASE \+ 'dict\/'\)\)\s*return/)
  })

  it('throws when a placeholder is missing', () => {
    expect(() =>
      renderServiceWorker('nothing here', { base: '/', precache: [], version: 'v' }),
    ).toThrow(/__PRECACHE_MANIFEST__/)
  })
})
