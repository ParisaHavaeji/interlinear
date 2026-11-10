import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'
import { buildManifest } from './pwa-manifest.ts'
import { renderServiceWorker, shellFiles, shellPrecacheList } from './pwa-sw.ts'

/**
 * Hand-rolled PWA plugin:
 *  - serves / emits `manifest.webmanifest` built from Vite's `base`
 *  - emits `sw.js` from `src/pwa/sw.js` with the list of built assets injected,
 *    so the service worker precaches exactly the app shell Vite produced: the statically
 *    reachable chunks and the small assets, not the lazily imported language model nor the
 *    ONNX runtime's wasm (see `shellFiles` / `isPrecachable` in pwa-sw.ts).
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
      const precache = shellPrecacheList(base, shellFiles(bundle))
      const template = readFileSync(resolve(config.root, 'src/pwa/sw.js'), 'utf8')
      const sw = renderServiceWorker(template, {
        base,
        precache,
        version: Date.now().toString(36),
      })

      this.emitFile({ type: 'asset', fileName: 'sw.js', source: sw })
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: JSON.stringify(buildManifest(base), null, 2),
      })
    },
  }
}
