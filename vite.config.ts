/// <reference types="vitest/config" />
import preact from '@preact/preset-vite'
import { defineConfig, type Plugin } from 'vite'
import { pwa } from './tools/vite-plugin-pwa.ts'

// GitHub Pages serves project sites from /<repo>/; CI sets BASE_PATH accordingly.
const base = process.env.BASE_PATH ?? '/'

/**
 * ONNX Runtime's bundle refers to its default WebAssembly build (`ort-wasm-simd-threaded.asyncify`,
 * 27 MB) through `new URL(..., import.meta.url)`, so Vite copies it into `dist` although the
 * alignment worker always points the runtime at our own copy of the plain build
 * (`src/align/neural-wasm.ts`). Drop the unused file from the output.
 */
function dropUnusedOrtWasm(): Plugin {
  return {
    name: 'interlinear:drop-unused-ort-wasm',
    generateBundle(_opts, bundle) {
      for (const file of Object.keys(bundle)) if (/ort-wasm-simd-threaded\.asyncify[^/]*\.wasm$/.test(file)) delete bundle[file]
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [preact(), pwa(), dropUnusedOrtWasm()],
  build: {
    target: 'es2020',
    sourcemap: false,
  },
  // The alignment worker imports the language model lazily (plan.md step 15); only ES-format
  // workers can be code-split, so the classical path never loads it.
  worker: {
    format: 'es',
  },
  // Pre-bundle transformers.js when the dev server starts: discovering it on the first re-align
  // would make Vite re-optimise and force-reload the page, killing the job in progress.
  optimizeDeps: {
    include: ['@huggingface/transformers'],
  },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
})
