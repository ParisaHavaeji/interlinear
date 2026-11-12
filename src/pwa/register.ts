/** Service worker registration + storage persistence (production only), and where the app runs. */
import { isIOSUserAgent } from './install-hint.ts'

export async function registerServiceWorker(): Promise<void> {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  try {
    await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
  } catch (err) {
    console.warn('Service worker registration failed', err)
  }
}

/** Ask the browser not to evict IndexedDB / Cache Storage (books, dictionary). */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  try {
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

/** True when launched from the Home Screen (iOS) or installed (other platforms). */
export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean }
  return nav.standalone === true || window.matchMedia('(display-mode: standalone)').matches
}

/** iPhone, iPad (also when it asks for desktop pages) or iPod; see `install-hint.ts`. */
export function isIOS(): boolean {
  return isIOSUserAgent(navigator.userAgent, navigator.maxTouchPoints ?? 0)
}
