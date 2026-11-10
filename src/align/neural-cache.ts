/**
 * The language model's place in Cache Storage (step 15), for the Re-align sheet: whether the
 * model of `neural.ts` has been downloaded to this device, how large it is, and how to remove it
 * again. transformers.js writes the files there itself under their Hugging Face URLs, one entry
 * per file (tokenizer, config, weights), so the questions are answered by listing the cache's
 * keys. Browser only; a missing Cache API means "not downloaded".
 */

import { MODEL_ID } from './neural.ts'

/** The cache transformers.js uses by default (`env.cacheKey`). */
export const MODEL_CACHE = 'transformers-cache'

export interface ModelCacheStatus {
  /** The weights file is present, so a re-align will not download. */
  cached: boolean
  /** Bytes of the cached model files, as far as their responses say; 0 when unknown. */
  bytes: number
}

const isModelFile = (url: string) => url.includes(`/${MODEL_ID}/`)

async function modelEntries(cache: Cache): Promise<Request[]> {
  return (await cache.keys()).filter((r) => isModelFile(r.url))
}

export async function modelCacheStatus(): Promise<ModelCacheStatus> {
  if (typeof caches === 'undefined') return { cached: false, bytes: 0 }
  try {
    if (!(await caches.has(MODEL_CACHE))) return { cached: false, bytes: 0 }
    const cache = await caches.open(MODEL_CACHE)
    let bytes = 0
    let weights = false
    for (const req of await modelEntries(cache)) {
      if (new URL(req.url).pathname.endsWith('.onnx')) weights = true
      const res = await cache.match(req)
      bytes += Number(res?.headers.get('content-length') ?? 0) || 0
    }
    return { cached: weights, bytes }
  } catch (err) {
    console.warn('Could not inspect the model cache', err)
    return { cached: false, bytes: 0 }
  }
}

/** Remove every cached file of the model; the next re-align downloads it again. */
export async function deleteModelCache(): Promise<void> {
  if (typeof caches === 'undefined' || !(await caches.has(MODEL_CACHE))) return
  const cache = await caches.open(MODEL_CACHE)
  for (const req of await modelEntries(cache)) await cache.delete(req)
}
