/**
 * The install hint (plan.md step 30): a Books-style banner at the foot of the Library, shown in
 * Safari on iOS while the app runs in a tab, telling how to add it to the Home Screen. It slides
 * up when the Library opens, and its × puts it away for good: the dismissal is written to the
 * `installHint` settings row, which the banner reads live, so it never returns on that device,
 * and nothing shows until that row has been read, so a later launch never flashes it. The model,
 * who sees it and how the row is read, is `pwa/install-hint.ts`.
 */

import { useMemo, useState } from 'preact/hooks'
import { dismissedInstallHint, INSTALL_HINT_KEY, installHintVisible, sanitizeInstallHint } from '../pwa/install-hint.ts'
import { isIOS, isStandalone } from '../pwa/register.ts'
import { useLiveQuery } from '../store/hooks.ts'
import { getSetting, setSetting } from '../store/settings.ts'
import './install-hint.css'

/** The banner's leaving animation (install-hint.css) runs this long before the row is written. */
const LEAVE_MS = 220

export function InstallHint() {
  const platform = useMemo(() => ({ ios: isIOS(), standalone: isStandalone() }), [])
  const dismissedAt = useLiveQuery(() => getSetting(INSTALL_HINT_KEY, sanitizeInstallHint), [])
  const [leaving, setLeaving] = useState(false)

  if (!installHintVisible({ ...platform, dismissedAt })) return null

  const dismiss = () => {
    if (leaving) return
    setLeaving(true)
    window.setTimeout(() => {
      setSetting(INSTALL_HINT_KEY, dismissedInstallHint()).catch((err: unknown) => console.error('could not save the install hint', err))
    }, LEAVE_MS)
  }

  return (
    <aside class={`install-hint ${leaving ? 'is-leaving' : ''}`} aria-label="Add to Home Screen">
      <img class="install-hint-icon" src={`${import.meta.env.BASE_URL}icons/icon-192.png`} width="44" height="44" alt="" />
      <div class="install-hint-text">
        <div class="install-hint-title">Add to Home Screen</div>
        <p class="install-hint-body">
          Tap{' '}
          <svg class="install-hint-share" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M12 3v12M8 7l4-4 4 4M6 11H5v9h14v-9h-1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <strong>Share</strong>, then <strong>Add to Home Screen</strong>, to read full-screen and offline.
        </p>
      </div>
      <button type="button" class="install-hint-close" aria-label="Dismiss" onClick={dismiss}>
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
        </svg>
      </button>
    </aside>
  )
}
