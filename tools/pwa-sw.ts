/**
 * Service-worker build helpers, kept free of Vite types so they are unit-testable.
 */

/** Files from `public/` that belong to the app shell and must work offline. */
export const SHELL_PUBLIC_FILES = [
  'icons/apple-touch-icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/favicon.svg',
  'manifest.webmanifest',
]

/**
 * URLs the service worker precaches: the shell document (`base`), every file
 * Rollup emitted except source maps, and the static shell files above.
 */
export function shellPrecacheList(base: string, bundleFiles: string[]): string[] {
  const b = base.endsWith('/') ? base : base + '/'
  const built = bundleFiles.filter((f) => !f.endsWith('.map')).map((f) => b + f)
  const statics = SHELL_PUBLIC_FILES.map((f) => b + f)
  return [...new Set([b, ...built, ...statics])]
}

export interface ServiceWorkerParams {
  base: string
  precache: string[]
  version: string
}

/** Fill the placeholders in `src/pwa/sw.js`. Throws if one is missing from the template. */
export function renderServiceWorker(template: string, params: ServiceWorkerParams): string {
  const b = params.base.endsWith('/') ? params.base : params.base + '/'
  const fills: Record<string, string> = {
    __PRECACHE_MANIFEST__: JSON.stringify(params.precache),
    __CACHE_VERSION__: JSON.stringify(params.version),
    __BASE__: JSON.stringify(b),
  }
  let out = template
  for (const [placeholder, value] of Object.entries(fills)) {
    if (!out.includes(placeholder)) {
      throw new Error(`service worker template is missing ${placeholder}`)
    }
    out = out.split(placeholder).join(value)
  }
  return out
}
