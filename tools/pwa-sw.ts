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

/** The little of Rollup's output the shell list needs to know about each emitted file. */
export interface OutputFile {
  type: 'chunk' | 'asset'
  /** Chunks only: a static entry point (the page's script). */
  isEntry?: boolean
  /** Chunks only: file names of the chunks this one imports statically. */
  imports?: readonly string[]
}

/**
 * The files of the build that make up the app shell: every chunk reachable from an entry chunk
 * through static imports, plus every asset. Chunks reached only through `import()` are left
 * out: they are loaded on demand (the language model of plan.md step 15, the dev-only debug
 * view) and the service worker caches them when they are first fetched instead of making
 * every install download them.
 */
export function shellFiles(bundle: Record<string, OutputFile>): string[] {
  const shell = new Set<string>()
  const visit = (file: string): void => {
    if (shell.has(file)) return
    const out = bundle[file]
    if (out === undefined || out.type !== 'chunk') return
    shell.add(file)
    for (const dep of out.imports ?? []) visit(dep)
  }
  for (const [file, out] of Object.entries(bundle)) if (out.type === 'chunk' && out.isEntry) visit(file)
  for (const [file, out] of Object.entries(bundle)) if (out.type === 'asset') shell.add(file)
  return [...shell]
}

/**
 * Files never precached even when emitted as assets: source maps, and everything only a reader
 * who re-aligns with the language model (plan.md step 15) ever fetches: the ONNX runtime's
 * WebAssembly (14 MB) and glue script, and the worker's lazily imported Layer D chunks. Vite
 * builds the worker separately and emits all of its chunks as assets of the main bundle, so
 * those two are known by the names Rollup gives them (`neural-model-*.js`, `neural-wasm-*.js`).
 */
export function isPrecachable(file: string): boolean {
  const name = file.slice(file.lastIndexOf('/') + 1)
  if (name.endsWith('.map') || name.endsWith('.wasm')) return false
  if (/^ort-wasm.*\.mjs$/.test(name)) return false
  return !/^neural-(model|wasm)-[^.]*\.js$/.test(name)
}

/**
 * URLs the service worker precaches: the shell document (`base`), every given built file
 * except those {@link isPrecachable} rules out, and the static shell files above.
 */
export function shellPrecacheList(base: string, bundleFiles: string[]): string[] {
  const b = base.endsWith('/') ? base : base + '/'
  const built = bundleFiles.filter(isPrecachable).map((f) => b + f)
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
