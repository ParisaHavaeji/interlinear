/* Interlinear service worker — app shell precache.
 * Placeholders are filled by tools/vite-plugin-pwa.ts at build time. */
const VERSION = __CACHE_VERSION__
const BASE = __BASE__
const PRECACHE = __PRECACHE_MANIFEST__
const SHELL_CACHE = `shell-${VERSION}`

// Same-origin shell assets only, so the Vary header is irrelevant. Without this,
// `<script crossorigin>` / `<link crossorigin>` requests (which carry an Origin
// header) never match entries precached without one when the server answers with
// `Vary: Origin`, as Vite's preview server does, and the app is blank offline.
const MATCH = { ignoreVary: true }

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('shell-') && k !== SHELL_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // SPA navigations: serve the cached shell, fall back to network.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches
        .match(BASE, MATCH)
        .then((hit) => hit || fetch(request).catch(() => caches.match(BASE, MATCH))),
    )
    return
  }

  // Everything else: cache first, then network (and cache same-origin hits).
  event.respondWith(
    caches.match(request, MATCH).then((hit) => {
      if (hit) return hit
      return fetch(request).then((res) => {
        if (res.ok && url.pathname.startsWith(BASE)) {
          const copy = res.clone()
          caches.open(SHELL_CACHE).then((c) => c.put(request, copy))
        }
        return res
      })
    }),
  )
})
