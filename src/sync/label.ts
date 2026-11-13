/** The wording of the Account row's state in Settings (plan.md step 36), kept apart from the DOM. */

import type { SyncState } from './engine.ts'

export interface AccountRowInput {
  sync: SyncState
  signingIn: boolean
  online: boolean
  /** Unix ms now. */
  now: number
}

/** "Signing in…", "Syncing…", "Couldn't sync", "Waiting for a connection", "Synced just now" / "Synced 5 min ago" / "Synced 14:02", "Not synced yet". */
export function accountRowLabel({ sync, signingIn, online, now }: AccountRowInput): string {
  if (signingIn) return 'Signing in…'
  if (sync.phase === 'syncing') return 'Syncing…'
  if (!online) return 'Waiting for a connection'
  if (sync.phase === 'error') return 'Couldn’t sync'
  if (sync.lastSync === null) return 'Not synced yet'
  const ago = now - sync.lastSync
  if (ago < 60_000) return 'Synced just now'
  if (ago < 3_600_000) return `Synced ${Math.floor(ago / 60_000)} min ago`
  const then = new Date(sync.lastSync)
  const sameDay = then.toDateString() === new Date(now).toDateString()
  return `Synced ${sameDay ? then.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : then.toLocaleDateString([], { day: 'numeric', month: 'short' })}`
}

/** The first letter of a name or address, for an account without a picture. */
export function initialOf(name: string | null, email: string | null): string {
  const s = (name ?? email ?? '').trim()
  return s === '' ? '?' : s[0].toUpperCase()
}
