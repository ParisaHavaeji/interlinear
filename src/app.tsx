import { useEffect, useState } from 'preact/hooks'
import { isIOS, isStandalone } from './pwa/register'

/** Phase 0 shell: a blank Library screen with Books-style chrome. */
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
    <div class="screen">
      <header class="top-bar">
        <h1 class="large-title">Library</h1>
      </header>

      <main class="content">
        <div class="empty">
          <div class="empty-cover" aria-hidden="true" />
          <p class="empty-title">No books yet</p>
          <p class="empty-sub">Add a German book and its English translation to start reading.</p>
        </div>
      </main>

      {showInstallHint && (
        <aside class="install-hint" role="note">
          Install: tap <strong>Share</strong> then <strong>Add to Home Screen</strong>.
        </aside>
      )}

      <footer class="status" aria-live="polite">
        {standalone ? 'Standalone' : 'Browser'} · {online ? 'Online' : 'Offline'}
      </footer>
    </div>
  )
}
