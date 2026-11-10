/**
 * Our own copy of the ONNX runtime's WebAssembly build (step 15), as absolute URLs the worker
 * hands to transformers.js. Vite emits both files as hashed assets, so they are served from the
 * app's origin: no CDN at run time, and the service worker caches them on first use like any
 * other same-origin asset (they are left out of the install-time precache in `tools/pwa-sw.ts`,
 * being 14 MB a reader who never re-aligns need not download). Browser only.
 */

import mjs from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'
import wasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'

export const ORT_WASM_PATHS = {
  mjs: new URL(mjs, self.location.href).href,
  wasm: new URL(wasm, self.location.href).href,
}
