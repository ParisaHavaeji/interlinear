import { useEffect, useState } from 'preact/hooks'
import { Library } from './app/Library.tsx'
import { isIOS, isStandalone } from './pwa/register'

/** App shell: the Library screen (Phase 1) plus the install hint and status footer from Phase 0. */
export function App() {
  const [online, setOnline] = useState(navigator.onLine)
  const [standalone, setStandalone] = useState(false)

  useEffect(() => {
    setStandalone(isStandalone())
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])

  const showInstallHint = isIOS() && !standalone

  return (
    <>
      <Library />

      {showInstallHint && (
        <aside class="install-hint" role="note">
          Install: tap <strong>Share</strong> then <strong>Add to Home Screen</strong>.
        </aside>
      )}

      <footer class="status" aria-live="polite">
        {standalone ? 'Standalone' : 'Browser'} · {online ? 'Online' : 'Offline'}
      </footer>
    </>
  )
}
