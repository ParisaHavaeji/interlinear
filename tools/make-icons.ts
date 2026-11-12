/**
 * Generates the app's PNG artwork with no native dependencies (a tiny PNG encoder over zlib):
 * the icons (plan.md step 2) and, since step 31, the iOS launch screens listed in
 * `tools/pwa-splash.ts`. Run with `npm run icons`; the output in `public/` is committed.
 *
 * Design: a warm gradient square with three "text lines", a stand-in for a book page. A launch
 * screen is that icon, rounded as iOS rounds it, centred on a plain white or black page, the
 * way a native app's launch screen shows its icon alone.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { SPLASH_BACKGROUND, SPLASH_DEVICES, splashFileName, splashIconSide, type ColorScheme, type SplashDevice } from './pwa-splash.ts'

// --- PNG encoding ---------------------------------------------------------------------------

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})

function crc32(buf: Uint8Array): number {
  let c = -1
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** An RGBA image as the scanlines PNG wants: one filter byte (0, none) before each row. */
class Raster {
  readonly width: number
  readonly height: number
  readonly stride: number
  readonly data: Buffer

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.stride = width * 4 + 1
    this.data = Buffer.alloc(this.stride * height)
  }

  set(x: number, y: number, r: number, g: number, b: number, a = 255): void {
    const o = y * this.stride + 1 + x * 4
    this.data[o] = r
    this.data[o + 1] = g
    this.data[o + 2] = b
    this.data[o + 3] = a
  }

  /** Blend an opaque colour over the pixel with the given coverage (0–1). */
  blend(x: number, y: number, r: number, g: number, b: number, coverage: number): void {
    const o = y * this.stride + 1 + x * 4
    const k = Math.min(1, Math.max(0, coverage))
    this.data[o] = Math.round(this.data[o] + (r - this.data[o]) * k)
    this.data[o + 1] = Math.round(this.data[o + 1] + (g - this.data[o + 1]) * k)
    this.data[o + 2] = Math.round(this.data[o + 2] + (b - this.data[o + 2]) * k)
  }

  png(): Buffer {
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(this.width, 0)
    ihdr.writeUInt32BE(this.height, 4)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 6 // colour type: RGBA
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(this.data, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ])
  }
}

// --- The icon ---------------------------------------------------------------------------------

type RGB = readonly [number, number, number]

const GRADIENT_TOP: RGB = [255, 179, 64] // #ffb340
const GRADIENT_BOTTOM: RGB = [255, 106, 61] // #ff6a3d
const LINE_COLOUR: RGB = [255, 250, 240] // #fffaf0

/** Two text lines and a shorter third, as fractions of the icon's side. */
const LINES = [
  { y0: 0.36, y1: 0.42, x0: 0.24, x1: 0.76 },
  { y0: 0.49, y1: 0.55, x0: 0.24, x1: 0.76 },
  { y0: 0.62, y1: 0.68, x0: 0.24, x1: 0.56 },
]

/** The icon's colour at a point given as fractions (0–1) of its side. */
function iconColour(fx: number, fy: number): RGB {
  for (const L of LINES) if (fx >= L.x0 && fx < L.x1 && fy >= L.y0 && fy < L.y1) return LINE_COLOUR
  const t = (fx + fy) / 2
  return [
    Math.round(GRADIENT_TOP[0] + (GRADIENT_BOTTOM[0] - GRADIENT_TOP[0]) * t),
    Math.round(GRADIENT_TOP[1] + (GRADIENT_BOTTOM[1] - GRADIENT_TOP[1]) * t),
    Math.round(GRADIENT_TOP[2] + (GRADIENT_BOTTOM[2] - GRADIENT_TOP[2]) * t),
  ]
}

/** A square icon, filled to the edges: iOS and the maskable manifest entry round it themselves. */
function icon(size: number): Buffer {
  const img = new Raster(size, size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = iconColour((x + 0.5) / size, (y + 0.5) / size)
      img.set(x, y, r, g, b)
    }
  }
  return img.png()
}

// --- Launch screens -----------------------------------------------------------------------------

/** iOS's app icon corner radius, as a share of the side. */
const CORNER_RADIUS = 0.2237

/**
 * How much of a pixel at (px, py) within a `side` square lies inside the rounded square: 1 well
 * inside, 0 outside, in between along the edge, from the signed distance to the rounded edge.
 */
function roundedSquareCoverage(px: number, py: number, side: number): number {
  const half = side / 2
  const r = side * CORNER_RADIUS
  const qx = Math.abs(px - half) - (half - r)
  const qy = Math.abs(py - half) - (half - r)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  const inside = Math.min(Math.max(qx, qy), 0)
  const distance = outside + inside - r
  return Math.min(1, Math.max(0, 0.5 - distance))
}

function hexToRGB(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

/** A device's launch screen: the rounded icon centred on a plain page in the scheme's colour. */
function splash(device: SplashDevice, scheme: ColorScheme): Buffer {
  const w = device.width * device.scale
  const h = device.height * device.scale
  const img = new Raster(w, h)
  const [br, bg, bb] = hexToRGB(SPLASH_BACKGROUND[scheme])

  // The background, one row painted and copied down the page.
  const row = Buffer.alloc(img.stride)
  for (let x = 0; x < w; x++) {
    const o = 1 + x * 4
    row[o] = br
    row[o + 1] = bg
    row[o + 2] = bb
    row[o + 3] = 255
  }
  for (let y = 0; y < h; y++) row.copy(img.data, y * img.stride)

  // The icon, antialiased along its rounded edge.
  const side = splashIconSide(device)
  const x0 = Math.round((w - side) / 2)
  const y0 = Math.round((h - side) / 2)
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const coverage = roundedSquareCoverage(x + 0.5, y + 0.5, side)
      if (coverage <= 0) continue
      const [r, g, b] = iconColour((x + 0.5) / side, (y + 0.5) / side)
      img.blend(x0 + x, y0 + y, r, g, b, coverage)
    }
  }
  return img.png()
}

// --- Output -------------------------------------------------------------------------------------

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#ffb340"/><stop offset="1" stop-color="#ff6a3d"/>
  </linearGradient></defs>
  <rect width="64" height="64" rx="14" fill="url(#g)"/>
  <rect x="15" y="23" width="34" height="4" rx="2" fill="#fffaf0"/>
  <rect x="15" y="31" width="34" height="4" rx="2" fill="#fffaf0"/>
  <rect x="15" y="39" width="21" height="4" rx="2" fill="#fffaf0"/>
</svg>
`

function main(): void {
  mkdirSync('public/icons', { recursive: true })
  writeFileSync('public/icons/apple-touch-icon-180.png', icon(180))
  writeFileSync('public/icons/icon-192.png', icon(192))
  writeFileSync('public/icons/icon-512.png', icon(512))
  writeFileSync('public/icons/favicon.svg', FAVICON)
  console.log('icons written to public/icons/')

  mkdirSync('public/splash', { recursive: true })
  let bytes = 0
  for (const scheme of ['light', 'dark'] as const) {
    for (const device of SPLASH_DEVICES) {
      const png = splash(device, scheme)
      bytes += png.length
      writeFileSync(`public/${splashFileName(device, scheme)}`, png)
    }
  }
  console.log(`${SPLASH_DEVICES.length * 2} launch screens written to public/splash/ (${(bytes / 1024).toFixed(0)} KB)`)
}

main()
