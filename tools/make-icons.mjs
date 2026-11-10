// Generates the PWA icons as PNGs with no native dependencies (tiny PNG encoder).
// Design: warm gradient square with two "text lines" — a stand-in for a book page.
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
const crc32 = (buf) => {
  let c = -1
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y)
      const o = y * (size * 4 + 1) + 1 + x * 4
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const lerp = (a, b, t) => a + (b - a) * t
const mix = (c1, c2, t) => c1.map((v, i) => Math.round(lerp(v, c2[i], t)))

/** Icon painter. `rounded` clips to an iOS-style squircle-ish radius (not for maskable/180). */
function painter(size, { rounded }) {
  const top = [255, 179, 64]   // #ffb340
  const bottom = [255, 106, 61] // #ff6a3d
  const radius = size * 0.22
  const inside = (x, y) => {
    if (!rounded) return true
    const cx = Math.min(Math.max(x, radius), size - radius)
    const cy = Math.min(Math.max(y, radius), size - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
  }
  // Two text lines + a shorter third, as a page glyph, centred.
  const lines = [
    { y0: 0.36, y1: 0.42, x0: 0.24, x1: 0.76 },
    { y0: 0.49, y1: 0.55, x0: 0.24, x1: 0.76 },
    { y0: 0.62, y1: 0.68, x0: 0.24, x1: 0.56 },
  ]
  return (x, y) => {
    if (!inside(x + 0.5, y + 0.5)) return [0, 0, 0, 0]
    const t = (x + y) / (2 * size)
    let [r, g, b] = mix(top, bottom, t)
    const fx = x / size, fy = y / size
    for (const L of lines) {
      if (fx >= L.x0 && fx < L.x1 && fy >= L.y0 && fy < L.y1) { r = 255; g = 250; b = 240 }
    }
    return [r, g, b, 255]
  }
}

mkdirSync('public/icons', { recursive: true })
writeFileSync('public/icons/apple-touch-icon-180.png', png(180, painter(180, { rounded: false })))
writeFileSync('public/icons/icon-192.png', png(192, painter(192, { rounded: false })))
writeFileSync('public/icons/icon-512.png', png(512, painter(512, { rounded: false })))
writeFileSync(
  'public/icons/favicon.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#ffb340"/><stop offset="1" stop-color="#ff6a3d"/>
  </linearGradient></defs>
  <rect width="64" height="64" rx="14" fill="url(#g)"/>
  <rect x="15" y="23" width="34" height="4" rx="2" fill="#fffaf0"/>
  <rect x="15" y="31" width="34" height="4" rx="2" fill="#fffaf0"/>
  <rect x="15" y="39" width="21" height="4" rx="2" fill="#fffaf0"/>
</svg>
`,
)
console.log('icons written to public/icons/')
