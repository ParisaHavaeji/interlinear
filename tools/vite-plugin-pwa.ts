import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'
import { buildManifest } from './pwa-manifest.ts'

/**
 * Hand-rolled PWA plugin:
 *  - serves / emits `manifest.webmanifest` built from Vite's `base`
 *  - emits `sw.js` from `src/pwa/sw.js` with the list of built assets injected,
 *    so the service worker precaches exactly the app shell Vite produced.
 */
export function pwa(): Plugin {
  let config: ResolvedConfig

  return {
    name: 'interlinear:pwa',

    configResolved(c) {
      config = c
    },

    // Dev server: the manifest is not a real file, so answer it here.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] === `${config.base}manifest.webmanifest`) {
          res.setHeader('Content-Type', 'application/manifest+json')
          res.end(JSON.stringify(buildManifest(config.base), null, 2))
          return
        }
        next()
      })
    },

    generateBundle(_opts, bundle) {
      const base = config.base
      const files = Object.keys(bundle)
        .filter((f) => !f.endsWith('.map'))
        .map((f) => base + f)
      const publicFiles = [
        'icons/apple-touch-icon-180.png',
        'icons/icon-192.png',
        'icons/icon-512.png',
        'icons/favicon.svg',
        'manifest.webmanifest',
      ].map((f) => base + f)
      const precache = [base, ...files, ...publicFiles]

      const template = readFileSync(resolve(config.root, 'src/pwa/sw.js'), 'utf8')
      const version = `${Date.now().toString(36)}`
      const sw = template
        .replace('__PRECACHE_MANIFEST__', JSON.stringify(precache))
        .replace('__CACHE_VERSION__', JSON.stringify(version))
        .replace('__BASE__', JSON.stringify(base))

      this.emitFile({ type: 'asset', fileName: 'sw.js', source: sw })
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: JSON.stringify(buildManifest(base), null, 2),
      })
    },
  }
}
