// The iOS launch screens (plan.md step 31): the list the generator and the page share.
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SPLASH_DEVICES, splashFileName, splashIconSide, splashLinks, splashMedia } from '../tools/pwa-splash.ts'

const IPHONE_15 = { width: 393, height: 852, scale: 3, devices: '' } as const
const IPAD_PRO = { width: 1024, height: 1366, scale: 2, devices: '' } as const

describe('the device list', () => {
  it('names every screen once', () => {
    const keys = SPLASH_DEVICES.map((d) => `${d.width}x${d.height}@${d.scale}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('is portrait throughout, as the manifest locks it', () => {
    for (const d of SPLASH_DEVICES) expect(d.height).toBeGreaterThan(d.width)
  })

  it('has a generated image for each device and scheme in public/', () => {
    for (const d of SPLASH_DEVICES) {
      expect(existsSync(`public/${splashFileName(d, 'light')}`), splashFileName(d, 'light')).toBe(true)
      expect(existsSync(`public/${splashFileName(d, 'dark')}`), splashFileName(d, 'dark')).toBe(true)
    }
  })
})

describe('file names and media queries', () => {
  it('names the file by its pixel size and scheme', () => {
    expect(splashFileName(IPHONE_15, 'light')).toBe('splash/splash-1179x2556-light.png')
    expect(splashFileName(IPAD_PRO, 'dark')).toBe('splash/splash-2048x2732-dark.png')
  })

  it('matches on the CSS size, pixel ratio, portrait and the scheme', () => {
    expect(splashMedia(IPHONE_15, 'dark')).toBe(
      'screen and (device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait) and (prefers-color-scheme: dark)',
    )
  })

  it('sizes the icon near a quarter of a phone and caps it on an iPad', () => {
    expect(splashIconSide(IPHONE_15)).toBe(283) // 94 pt
    expect(splashIconSide(IPAD_PRO)).toBe(256) // 128 pt
  })
})

describe('splashLinks', () => {
  it('gives a light and a dark link per device under the base', () => {
    const links = splashLinks('/interlinear/')
    expect(links).toHaveLength(SPLASH_DEVICES.length * 2)
    expect(links.every((l) => l.href.startsWith('/interlinear/splash/'))).toBe(true)
    expect(links.filter((l) => l.media.includes('dark'))).toHaveLength(SPLASH_DEVICES.length)
  })

  it('tolerates a base without trailing slash', () => {
    expect(splashLinks('/x')[0].href.startsWith('/x/splash/')).toBe(true)
  })
})
