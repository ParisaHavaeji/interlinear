// The install hint's model (plan.md step 30): who sees the banner, and the dismissal read back.
import { describe, expect, it } from 'vitest'
import { dismissedInstallHint, installHintVisible, isIOSUserAgent, sanitizeInstallHint } from '../src/pwa/install-hint.ts'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const MAC = IPAD_DESKTOP
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

describe('isIOSUserAgent', () => {
  it('recognises an iPhone and an iPad asking for desktop pages', () => {
    expect(isIOSUserAgent(IPHONE, 5)).toBe(true)
    expect(isIOSUserAgent(IPAD_DESKTOP, 5)).toBe(true)
    expect(isIOSUserAgent('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15', 5)).toBe(true)
  })

  it('leaves out a Mac, Android and Windows', () => {
    expect(isIOSUserAgent(MAC, 0)).toBe(false)
    expect(isIOSUserAgent(ANDROID, 5)).toBe(false)
    expect(isIOSUserAgent(WINDOWS, 10)).toBe(false)
    // Old IE on Windows Phone put "iPhone" in its user agent with MSStream.
    expect(isIOSUserAgent('Mozilla/5.0 (iPhone; MSStream; Windows Phone 10.0)', 2)).toBe(false)
  })
})

describe('installHintVisible', () => {
  it('shows in a Safari tab on iOS once the setting is read and not dismissed', () => {
    expect(installHintVisible({ ios: true, standalone: false, dismissedAt: null })).toBe(true)
  })

  it('stays away when installed, elsewhere, dismissed, or while the setting loads', () => {
    expect(installHintVisible({ ios: true, standalone: true, dismissedAt: null })).toBe(false)
    expect(installHintVisible({ ios: false, standalone: false, dismissedAt: null })).toBe(false)
    expect(installHintVisible({ ios: true, standalone: false, dismissedAt: '2026-11-12T10:00:00.000Z' })).toBe(false)
    expect(installHintVisible({ ios: true, standalone: false, dismissedAt: undefined })).toBe(false)
  })
})

describe('the dismissal row', () => {
  it('reads a written row back and falls back to not dismissed for anything else', () => {
    const row = dismissedInstallHint(new Date('2026-11-12T10:00:00Z'))
    expect(row).toEqual({ dismissedAt: '2026-11-12T10:00:00.000Z' })
    expect(sanitizeInstallHint(row)).toBe('2026-11-12T10:00:00.000Z')
    expect(sanitizeInstallHint(undefined)).toBeNull()
    expect(sanitizeInstallHint(null)).toBeNull()
    expect(sanitizeInstallHint('2026-11-12')).toBeNull()
    expect(sanitizeInstallHint({ dismissedAt: '' })).toBeNull()
    expect(sanitizeInstallHint({ dismissedAt: 42 })).toBeNull()
    expect(sanitizeInstallHint({})).toBeNull()
  })
})
