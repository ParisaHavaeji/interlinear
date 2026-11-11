import { lazy, Suspense } from 'preact/compat'
import { useEffect, useState } from 'preact/hooks'
import { Bookmarks } from './app/Bookmarks.tsx'
import { Library } from './app/Library.tsx'
import { bookmarksHash, parseRoute, readHash } from './app/routes.ts'
import { Settings } from './app/Settings.tsx'
import { dictStateShort } from './dict/download.ts'
import { useDictState } from './dict/installer.ts'
import { isIOS, isStandalone } from './pwa/register'
import { Reader } from './reader/Reader.tsx'

// Development only: the alignment debug view of plan.md step 13, at #/debug/<bookId>. The
// import is lazy and behind `import.meta.env.DEV`, so production bundles never include it.
const AlignmentDebug = import.meta.env.DEV ? lazy(() => import('./app/AlignmentDebug.tsx').then((m) => m.AlignmentDebug)) : null

function useHash(): string {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const onChange = () => setHash(location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

const toLibrary = () => {
  location.hash = ''
}

/**
 * App shell: hash-routed between the Library (Phase 1), the Reader (Phase 3, `#/read/<id>`),
 * Settings, the bookmarks screen (step 26, `#/bookmarks`, or one book's from its Reader) and,
 * in development, the alignment debug view. The install hint and status footer from Phase 0 show
 * on the Library only.
 */
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
  const route = parseRoute(useHash())
  const dictNote = dictStateShort(useDictState())

  if (route.screen === 'settings') return <Settings onBack={toLibrary} />

  if (route.screen === 'bookmarks') {
    const { book } = route
    return (
      <Bookmarks
        book={book}
        onBack={
          book === undefined
            ? toLibrary
            : () => {
                location.hash = readHash(book.id, book.chapter)
              }
        }
      />
    )
  }

  if (route.screen === 'read') {
    return (
      <Reader
        bookId={route.bookId}
        chapter={route.chapter}
        at={route.at}
        onBack={toLibrary}
        onChapter={(chapter) => {
          location.hash = readHash(route.bookId, chapter)
        }}
        onBookmarks={(chapter) => {
          location.hash = bookmarksHash({ id: route.bookId, chapter })
        }}
        onArrive={(chapter) => {
          // The bookmark has been opened: the route now says only where the reader is, so a
          // reload or a change to the book's bookmarks does not open it again.
          location.replace(readHash(route.bookId, chapter))
        }}
      />
    )
  }

  if (route.screen === 'debug' && AlignmentDebug !== null) {
    return (
      <Suspense fallback={null}>
        <AlignmentDebug bookId={route.bookId} onBack={toLibrary} />
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
        {dictNote !== '' && ` · ${dictNote}`}
      </footer>
    </>
  )
}
