/**
 * Web app manifest, generated at build time so `start_url`, `scope` and icon
 * paths follow Vite's `base` (GitHub Pages serves from /<repo>/).
 */
export function buildManifest(base: string) {
  const b = base.endsWith('/') ? base : base + '/'
  return {
    name: 'Interlinear',
    short_name: 'Interlinear',
    description: 'Read a German book with its English translation, offline.',
    id: b,
    start_url: b,
    scope: b,
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    lang: 'en',
    icons: [
      { src: `${b}icons/icon-192.png`, sizes: '192x192', type: 'image/png' },
      { src: `${b}icons/icon-512.png`, sizes: '512x512', type: 'image/png' },
      { src: `${b}icons/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
