import { describe, expect, it } from 'vitest'
import { buildManifest } from '../tools/pwa-manifest.ts'

describe('web app manifest', () => {
  it('uses the root when base is /', () => {
    const m = buildManifest('/')
    expect(m.start_url).toBe('/')
    expect(m.scope).toBe('/')
    expect(m.display).toBe('standalone')
    expect(m.icons.map((i) => i.src)).toContain('/icons/icon-512.png')
  })

  it('follows a GitHub Pages project base', () => {
    const m = buildManifest('/interlinear/')
    expect(m.start_url).toBe('/interlinear/')
    expect(m.scope).toBe('/interlinear/')
    expect(m.icons.every((i) => i.src.startsWith('/interlinear/icons/'))).toBe(true)
  })

  it('tolerates a base without trailing slash', () => {
    expect(buildManifest('/x').start_url).toBe('/x/')
  })
})
