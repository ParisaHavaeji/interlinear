/**
 * iOS launch screens for the installed app (plan.md step 31). A web app added to the Home Screen
 * shows a blank white screen while it loads unless the page lists a PNG per device as
 * `<link rel="apple-touch-startup-image">`: iOS wants the exact pixel size of the screen, chosen
 * by a media query on the device's CSS size, pixel ratio and orientation, and keeps the images
 * at install time, so they never load with the page. The PNGs are generated into
 * `public/splash/` by `tools/make-icons.ts` from this list, and the links are injected into
 * `index.html` by `tools/vite-plugin-pwa.ts`, so the list is written once.
 *
 * Portrait only: the manifest locks the orientation. One image per device and colour scheme,
 * so a reader whose phone is in Dark Mode gets a black launch screen, matching the Night theme
 * and the dark `theme-color`.
 */

export interface SplashDevice {
  /** The screen in CSS px, portrait. */
  width: number
  height: number
  /** Device pixel ratio: the PNG is `width * scale` by `height * scale`. */
  scale: 2 | 3
  /** For the file listing only. */
  devices: string
}

export type ColorScheme = 'light' | 'dark'

export const SPLASH_DEVICES: readonly SplashDevice[] = [
  // iPhones
  { width: 440, height: 956, scale: 3, devices: 'iPhone 16 Pro Max, 17 Pro Max' },
  { width: 420, height: 912, scale: 3, devices: 'iPhone Air' },
  { width: 402, height: 874, scale: 3, devices: 'iPhone 16 Pro, 17, 17 Pro' },
  { width: 430, height: 932, scale: 3, devices: 'iPhone 14 Pro Max, 15 Pro Max, 15 Plus, 16 Plus' },
  { width: 393, height: 852, scale: 3, devices: 'iPhone 14 Pro, 15, 15 Pro, 16' },
  { width: 428, height: 926, scale: 3, devices: 'iPhone 12 Pro Max, 13 Pro Max, 14 Plus' },
  { width: 390, height: 844, scale: 3, devices: 'iPhone 12, 12 Pro, 13, 13 Pro, 14, 16e' },
  { width: 375, height: 812, scale: 3, devices: 'iPhone X, XS, 11 Pro, 12 mini, 13 mini' },
  { width: 414, height: 896, scale: 3, devices: 'iPhone XS Max, 11 Pro Max' },
  { width: 414, height: 896, scale: 2, devices: 'iPhone XR, 11' },
  { width: 414, height: 736, scale: 3, devices: 'iPhone 6 Plus, 7 Plus, 8 Plus' },
  { width: 375, height: 667, scale: 2, devices: 'iPhone 6, 7, 8, SE (2nd and 3rd gen.)' },
  { width: 320, height: 568, scale: 2, devices: 'iPhone SE (1st gen.)' },
  // iPads
  { width: 1032, height: 1376, scale: 2, devices: 'iPad Pro 13" (M4)' },
  { width: 1024, height: 1366, scale: 2, devices: 'iPad Pro 12.9"' },
  { width: 834, height: 1210, scale: 2, devices: 'iPad Pro 11" (M4)' },
  { width: 834, height: 1194, scale: 2, devices: 'iPad Pro 11", iPad Air 10.9"' },
  { width: 834, height: 1112, scale: 2, devices: 'iPad Pro 10.5", iPad Air (3rd gen.)' },
  { width: 820, height: 1180, scale: 2, devices: 'iPad 10.9", iPad Air 11"' },
  { width: 810, height: 1080, scale: 2, devices: 'iPad 10.2"' },
  { width: 768, height: 1024, scale: 2, devices: 'iPad 9.7", iPad mini (up to 5th gen.)' },
  { width: 744, height: 1133, scale: 2, devices: 'iPad mini (6th and 7th gen.)' },
]

/** The launch screens' background, matching the manifest's `background_color` and the two `theme-color` metas. */
export const SPLASH_BACKGROUND: Record<ColorScheme, string> = { light: '#ffffff', dark: '#000000' }

/**
 * The icon's side on a launch screen, in device pixels: about a quarter of the screen's width on
 * a phone, capped at 128 pt so it does not balloon on an iPad.
 */
export function splashIconSide(device: SplashDevice): number {
  const shorter = Math.min(device.width, device.height)
  return Math.round(Math.min(shorter * 0.24, 128) * device.scale)
}

/** Where under `public/` a device's image lives, e.g. `splash/splash-1179x2556-dark.png`. */
export function splashFileName(device: SplashDevice, scheme: ColorScheme): string {
  return `splash/splash-${device.width * device.scale}x${device.height * device.scale}-${scheme}.png`
}

/**
 * The media query that picks a device's image. Both schemes are spelled out, so exactly one
 * link matches a device whichever way iOS orders them.
 */
export function splashMedia(device: SplashDevice, scheme: ColorScheme): string {
  return [
    'screen',
    `(device-width: ${device.width}px)`,
    `(device-height: ${device.height}px)`,
    `(-webkit-device-pixel-ratio: ${device.scale})`,
    '(orientation: portrait)',
    `(prefers-color-scheme: ${scheme})`,
  ].join(' and ')
}

export interface SplashLink {
  href: string
  media: string
}

/** The `<link rel="apple-touch-startup-image">` attributes for every image, under Vite's `base`. */
export function splashLinks(base: string): SplashLink[] {
  const b = base.endsWith('/') ? base : base + '/'
  const links: SplashLink[] = []
  for (const scheme of ['light', 'dark'] as const) {
    for (const device of SPLASH_DEVICES) {
      links.push({ href: b + splashFileName(device, scheme), media: splashMedia(device, scheme) })
    }
  }
  return links
}
