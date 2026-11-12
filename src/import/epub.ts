/**
 * EPUB import: unzip → container.xml → package document (OPF) → spine → one Section per
 * content document, with paragraphs flattened per plan §1.1b and a detected heading and kind.
 * Works for EPUB 2 (NCX navigation) and EPUB 3 (nav document).
 */

import type JSZip from 'jszip'
import { htmlToBlocks, parseElements, type Block } from './markup.ts'
import { assignKinds, countWords, isBodySection, splitHeading } from './sections.ts'
import type { EpubBook, Paragraph, Section } from './types.ts'

const CONTAINER_PATH = 'META-INF/container.xml'
const PACKAGE_MEDIA_TYPE = 'application/oebps-package+xml'
const NCX_MEDIA_TYPE = 'application/x-dtbncx+xml'

export class EpubError extends Error {
  override name = 'EpubError'
}

/** Parse an EPUB from a File / Blob or its bytes. */
export async function parseEpub(data: Blob | ArrayBuffer | Uint8Array): Promise<EpubBook> {
  const bytes = data instanceof Blob ? await data.arrayBuffer() : data
  // JSZip (about 100 KB) is loaded the first time an EPUB is opened, so it stays out of the app
  // shell's main chunk (plan.md step 32); the service worker precaches it all the same.
  const { default: Zip } = await import('jszip')
  let zip: JSZip
  try {
    zip = await Zip.loadAsync(bytes)
  } catch (e) {
    throw new EpubError(`Not a zip archive: ${(e as Error).message}`)
  }

  const container = await readText(zip, CONTAINER_PATH)
  if (container === null) throw new EpubError('Not an EPUB: META-INF/container.xml is missing')
  const rootfile = parseElements(container).find(
    (el) => el.name === 'rootfile' && (el.attrs['media-type'] ?? PACKAGE_MEDIA_TYPE) === PACKAGE_MEDIA_TYPE,
  )
  const opfPath = rootfile?.attrs['full-path']
  if (!opfPath) throw new EpubError('Not an EPUB: container.xml names no package document')

  const opf = await readText(zip, opfPath)
  if (opf === null) throw new EpubError(`Package document not found: ${opfPath}`)
  const pkg = parsePackage(opf, dirname(opfPath))

  const navTitles = await readNavTitles(zip, pkg)

  const sections: Section[] = []
  const isBody: boolean[] = []
  for (const [idx, item] of pkg.spine.entries()) {
    const html = (await readText(zip, item.href)) ?? ''
    const blocks = htmlToBlocks(html)
    const section = buildSection(idx, item.href, item.linear, navTitles.get(item.href) ?? null, blocks)
    sections.push(section)
    isBody.push(isBodySection(section.heading, section.title, blocks, section.paragraphs, section.words))
  }
  assignKinds(sections, isBody)

  return { title: pkg.title, author: pkg.author, language: pkg.language, sections }
}

/** Build a section from its blocks: heading split off, paragraphs numbered, words counted. */
export function buildSection(idx: number, href: string, linear: boolean, title: string | null, blocks: Block[]): Section {
  const { heading, body } = splitHeading(blocks)
  const paragraphs: Paragraph[] = body.map((b, i) =>
    b.cls === '' ? { idx: i, text: b.text } : { idx: i, text: b.text, cls: b.cls },
  )
  return { idx, href, title, heading, kind: 'front', linear, paragraphs, words: countWords(paragraphs) }
}

export interface SpineItem {
  /** Resolved path inside the container. */
  href: string
  linear: boolean
}

export interface PackageInfo {
  title: string | null
  author: string | null
  language: string | null
  spine: SpineItem[]
  /** EPUB 3 nav document (manifest item with properties="nav"), resolved path. */
  navHref: string | null
  /** EPUB 2 NCX, resolved path. */
  ncxHref: string | null
}

/** Read the metadata, manifest and spine out of a package document. */
export function parsePackage(opf: string, baseDir: string): PackageInfo {
  const manifest = new Map<string, { href: string; mediaType: string }>()
  let ncxId: string | null = null
  let title: string | null = null
  let author: string | null = null
  let authorIsAut = false
  let language: string | null = null
  const spine: SpineItem[] = []
  let navHref: string | null = null

  for (const el of parseElements(opf)) {
    switch (el.name) {
      case 'item': {
        const id = el.attrs['id']
        const href = el.attrs['href']
        if (!id || !href) break
        const resolved = resolvePath(baseDir, href)
        manifest.set(id, { href: resolved, mediaType: el.attrs['media-type'] ?? '' })
        if (/(?:^|\s)nav(?:\s|$)/.test(el.attrs['properties'] ?? '')) navHref = resolved
        break
      }
      case 'spine':
        ncxId = el.attrs['toc'] ?? null
        break
      case 'itemref': {
        const item = manifest.get(el.attrs['idref'] ?? '')
        if (item) spine.push({ href: item.href, linear: (el.attrs['linear'] ?? 'yes').toLowerCase() !== 'no' })
        break
      }
      case 'title':
        if (title === null && el.text.trim() !== '') title = el.text.trim()
        break
      case 'creator': {
        const text = el.text.trim()
        if (text === '') break
        const isAut = (el.attrs['opf:role'] ?? el.attrs['role'] ?? '').toLowerCase() === 'aut'
        if (author === null || (isAut && !authorIsAut)) {
          author = text
          authorIsAut = isAut
        }
        break
      }
      case 'language':
        if (language === null && el.text.trim() !== '') language = el.text.trim().toLowerCase()
        break
    }
  }

  let ncxHref: string | null = null
  const declaredNcx = ncxId === null ? undefined : manifest.get(ncxId)
  if (declaredNcx?.mediaType === NCX_MEDIA_TYPE) ncxHref = declaredNcx.href
  else for (const item of manifest.values()) if (item.mediaType === NCX_MEDIA_TYPE) ncxHref = item.href

  if (spine.length === 0) throw new EpubError('Package document has an empty spine')
  return { title, author, language, spine, navHref, ncxHref }
}

/**
 * Map each content document to its first label in the navigation document. The EPUB 3 nav
 * is preferred; NCX is the fallback. Fragments are dropped, so the first nav point into a
 * document wins.
 */
async function readNavTitles(zip: JSZip, pkg: PackageInfo): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  if (pkg.navHref !== null) {
    const nav = await readText(zip, pkg.navHref)
    if (nav !== null) {
      for (const el of parseElements(nav)) {
        if (el.name !== 'a' || !el.attrs['href']) continue
        const href = resolvePath(dirname(pkg.navHref), el.attrs['href'])
        const label = el.text.replace(/\s+/g, ' ').trim()
        if (label !== '' && !titles.has(href)) titles.set(href, label)
      }
    }
  }
  if (titles.size === 0 && pkg.ncxHref !== null) {
    const ncx = await readText(zip, pkg.ncxHref)
    if (ncx !== null) {
      let lastLabel = ''
      for (const el of parseElements(ncx)) {
        if (el.name === 'text') lastLabel = el.text.replace(/\s+/g, ' ').trim()
        else if (el.name === 'content' && el.attrs['src']) {
          const href = resolvePath(dirname(pkg.ncxHref), el.attrs['src'])
          if (lastLabel !== '' && !titles.has(href)) titles.set(href, lastLabel)
        }
      }
    }
  }
  return titles
}

/** Read a container entry as text; falls back to a case-insensitive path match. */
async function readText(zip: JSZip, path: string): Promise<string | null> {
  let file = zip.file(path)
  if (!file) {
    const lower = path.toLowerCase()
    const match = Object.keys(zip.files).find((k) => k.toLowerCase() === lower)
    file = match ? zip.file(match) : null
  }
  if (!file) return null
  return file.async('string')
}

function dirname(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

/**
 * Resolve an href relative to a directory inside the container: strips fragment and query,
 * percent-decodes, and normalises "." and "..".
 */
export function resolvePath(baseDir: string, href: string): string {
  let h = href.replace(/[#?].*$/, '')
  try {
    h = decodeURIComponent(h)
  } catch {
    /* keep as-is */
  }
  const parts = h.startsWith('/') ? [] : baseDir.split('/').filter((p) => p !== '')
  for (const seg of h.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}
