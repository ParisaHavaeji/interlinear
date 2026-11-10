import { lazy, Suspense } from 'preact/compat'
import { useEffect, useState } from 'preact/hooks'
import { Library } from './app/Library.tsx'
import { isIOS, isStandalone } from './pwa/register'

// Development only: the alignment debug view of plan.md step 13, at #/debug/<bookId>. The
// import is lazy and behind `import.meta.env.DEV`, so production bundles never include it.
const AlignmentDebug = import.meta.env.DEV ? lazy(() => import('./app/AlignmentDebug.tsx').then((m) => m.AlignmentDebug)) : null

/** The book id of a `#/debug/<id>` hash, or null. */
export function debugBookId(hash: string): string | null {
  const m = /^#\/debug\/([^/]+)$/.exec(hash)
  return m === null ? null : decodeURIComponent(m[1])
}

function useHash(): string {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const onChange = () => setHash(location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

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
  const hash = useHash()
  const debugId = AlignmentDebug === null ? null : debugBookId(hash)
  if (AlignmentDebug !== null && debugId !== null) {
    return (
      <Suspense fallback={null}>
        <AlignmentDebug bookId={debugId} onBack={() => (location.hash = '')} />
      </Suspense>
    )
  }

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
