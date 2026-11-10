/**
 * The language model behind Layer D (plan §1.2, step 15): `paraphrase-multilingual-MiniLM-L12-v2`
 * run locally by transformers.js on ONNX Runtime, wrapped as the {@link Embedder} that
 * `neural.ts` batches sentences through.
 *
 * Browser or Node, never a test: the worker imports this module lazily when a book is
 * re-aligned with high accuracy (so the classical path never pulls in the library), and
 * `tools/neural.ts` imports it to grade the model against the gold files from Node.
 *
 * **Caching.** In the browser transformers.js keeps the downloaded model files in Cache Storage
 * (`transformers-cache`), so the ~120 MB download happens once per device and later runs work
 * offline; `neural-cache.ts` reports and clears that cache for the UI. The ONNX runtime's own
 * `.wasm` is served from our origin (`neural-wasm.ts`) and cached by the service worker like any
 * shell asset, so no CDN is involved and transformers.js's duplicate wasm cache is turned off.
 */

import { env, pipeline } from '@huggingface/transformers'
import { DownloadTracker, MODEL_DTYPE, MODEL_ID, type Embedder } from './neural.ts'

export interface ModelOptions {
  /** `wasm` in the browser, `cpu` under Node. */
  device: 'wasm' | 'cpu'
  /** Where the ONNX runtime's glue script and binary live; the browser passes its own copies. */
  wasmPaths?: { mjs: string; wasm: string }
  /** Download progress over every model file, 0–1. Called at least once with 1 when loading is done. */
  onDownload?: (fraction: number) => void
}

/** What transformers.js reports while fetching model files; only the fields read here. */
interface LoadProgress {
  status: string
  file?: string
  loaded?: number
  total?: number
}

/**
 * Download (or open from the cache) the model and return an embedder over it. Throws when the
 * device is offline and the model is not cached yet, with the library's message.
 */
export async function loadEmbedder(options: ModelOptions): Promise<Embedder> {
  if (options.wasmPaths !== undefined) {
    const wasm = env.backends.onnx.wasm
    if (wasm === undefined) throw new Error('ONNX Runtime has no WebAssembly backend here')
    wasm.wasmPaths = options.wasmPaths
    env.useWasmCache = false
  }
  const tracker = new DownloadTracker()
  const extractor = await pipeline('feature-extraction', MODEL_ID, {
    dtype: MODEL_DTYPE,
    device: options.device,
    progress_callback: (info: LoadProgress) => {
      if (info.status === 'progress' && info.file !== undefined) tracker.update(info.file, info.loaded ?? 0, info.total ?? 0)
      else if (info.status === 'done' && info.file !== undefined) tracker.done(info.file)
      else return
      options.onDownload?.(tracker.fraction)
    },
  })
  options.onDownload?.(1)

  return {
    async embed(texts) {
      if (texts.length === 0) return []
      const output = await extractor([...texts], { pooling: 'mean', normalize: true })
      const [rows, dim] = output.dims
      const data = output.data as Float32Array
      const vectors: Float32Array[] = []
      for (let i = 0; i < rows; i++) vectors.push(Float32Array.from(data.subarray(i * dim, (i + 1) * dim)))
      output.dispose()
      return vectors
    },
    dispose: () => extractor.dispose(),
  }
}
