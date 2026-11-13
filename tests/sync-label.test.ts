import { describe, expect, it } from 'vitest'
import { accountRowLabel, initialOf } from '../src/sync/label.ts'

const idle = { phase: 'idle' as const, lastSync: null, error: null }
const at = (lastSync: number | null, phase: 'idle' | 'syncing' | 'error' = 'idle') => ({ phase, lastSync, error: phase === 'error' ? 'boom' : null })

describe('accountRowLabel', () => {
  const now = Date.UTC(2026, 10, 12, 14, 2)

  it('says what is happening, in order of importance', () => {
    expect(accountRowLabel({ sync: idle, signingIn: true, online: true, now })).toBe('Signing in…')
    expect(accountRowLabel({ sync: at(null, 'syncing'), signingIn: false, online: true, now })).toBe('Syncing…')
    expect(accountRowLabel({ sync: at(now, 'error'), signingIn: false, online: false, now })).toBe('Waiting for a connection')
    expect(accountRowLabel({ sync: at(now, 'error'), signingIn: false, online: true, now })).toBe('Couldn’t sync')
    expect(accountRowLabel({ sync: idle, signingIn: false, online: true, now })).toBe('Not synced yet')
  })

  it('tells how long ago the last sync was', () => {
    expect(accountRowLabel({ sync: at(now - 5_000), signingIn: false, online: true, now })).toBe('Synced just now')
    expect(accountRowLabel({ sync: at(now - 5 * 60_000), signingIn: false, online: true, now })).toBe('Synced 5 min ago')
    expect(accountRowLabel({ sync: at(now - 3 * 3_600_000), signingIn: false, online: true, now })).toMatch(/^Synced \d/)
    const days = accountRowLabel({ sync: at(now - 3 * 86_400_000), signingIn: false, online: true, now })
    expect(days).toMatch(/^Synced /)
    expect(days).not.toMatch(/ago|just now|:/)
  })
})

describe('initialOf', () => {
  it('takes the first letter of the name, else the address, else a question mark', () => {
    expect(initialOf('parisa b', null)).toBe('P')
    expect(initialOf(null, 'reader@example.com')).toBe('R')
    expect(initialOf(' ', null)).toBe('?')
  })
})
