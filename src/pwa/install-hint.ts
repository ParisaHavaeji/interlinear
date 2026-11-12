/**
 * The install hint's model (plan.md step 30), kept apart from the DOM so it can be tested: who
 * sees the "Share → Add to Home Screen" banner, and how its dismissal is read back from the
 * `settings` table. The banner itself is `app/InstallHint.tsx`.
 *
 * The hint is for Safari on iOS, where a web app is installed only by hand from the share
 * sheet and the browser never prompts. It shows while the app runs in the browser tab, not once
 * it was added to the Home Screen (the standalone display mode), and once dismissed it stays
 * away: the dismissal is kept in the settings table, so it holds across launches of that tab.
 * An installed copy has its own storage on iOS and never shows it anyway, being standalone.
 */

export const INSTALL_HINT_KEY = 'installHint'

/**
 * iPhone, iPad or iPod from the user agent. iPadOS asks for desktop pages by default and then
 * calls itself a Mac, so a Macintosh with a touch screen counts too; a Mac never has one.
 */
export function isIOSUserAgent(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return !/MSStream/.test(userAgent)
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1
}

export interface InstallHintContext {
  ios: boolean
  /** Launched from the Home Screen (iOS) or installed (other platforms). */
  standalone: boolean
  /** When the banner was dismissed; null when never, undefined while the setting is still loading. */
  dismissedAt: string | null | undefined
}

/** Whether the banner shows: Safari on iOS, in a tab, with the hint not yet dismissed and known to be so. */
export function installHintVisible({ ios, standalone, dismissedAt }: InstallHintContext): boolean {
  return ios && !standalone && dismissedAt === null
}

/** The stored dismissal read back safely: its time as an ISO string, or null when not dismissed. */
export function sanitizeInstallHint(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const at = (value as { dismissedAt?: unknown }).dismissedAt
  return typeof at === 'string' && at !== '' ? at : null
}

/** The row written when the banner is dismissed. */
export function dismissedInstallHint(now: Date = new Date()): { dismissedAt: string } {
  return { dismissedAt: now.toISOString() }
}
