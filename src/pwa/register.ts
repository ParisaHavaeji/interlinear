/** Service worker registration + storage persistence. Production only. */
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

export function isIOS(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) && !(window as unknown as { MSStream?: unknown }).MSStream
}
