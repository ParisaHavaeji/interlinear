/// <reference types="vitest/config" />
import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'
import { pwa } from './tools/vite-plugin-pwa.ts'

// GitHub Pages serves project sites from /<repo>/; CI sets BASE_PATH accordingly.
const base = process.env.BASE_PATH ?? '/'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [preact(), pwa()],
  build: {
    target: 'es2020',
    sourcemap: false,
  },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
})
