/**
 * A small, tolerant HTML / XML tokenizer and a block-text extractor.
 *
 * Written by hand instead of using DOMParser so that the same code runs in the browser,
 * in a Web Worker (no DOM there) and under Vitest in Node. EPUB content documents are
 * almost always well-formed XHTML, but the tokenizer survives unclosed tags, bare `<`
 * and stray `&`.
 */

export interface TagToken {
  type: 'open' | 'close'
  /** Lowercased, namespace prefix kept ("dc:title"). */
  name: string
  attrs: Record<string, string>
  selfClosing: boolean
}

export interface TextToken {
  type: 'text'
  text: string
}

export type Token = TagToken | TextToken

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '­',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  zwnj: '‌',
  zwj: '‍',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  lsaquo: '‹',
  rsaquo: '›',
  hellip: '…',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  sect: '§',
  para: '¶',
  dagger: '†',
  Dagger: '‡',
  euro: '€',
  pound: '£',
  times: '×',
  frac12: '½',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  szlig: 'ß',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  aacute: 'á',
  agrave: 'à',
  acirc: 'â',
  ccedil: 'ç',
  oacute: 'ó',
  ocirc: 'ô',
  iacute: 'í',
  uacute: 'ú',
  ntilde: 'ñ',
  Eacute: 'É',
}

/** Decode numeric and the common named character references. Unknown names are left as-is. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    return NAMED_ENTITIES[body] ?? whole
  })
}

const RAW_TEXT = new Set(['script', 'style'])
const ATTR_RE = /\s*([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/y

/**
 * Tokenize markup into open/close tags and (entity-decoded) text. Comments, doctype and
 * processing instructions are dropped; the content of `<script>` and `<style>` too.
 */
export function tokenize(src: string): Token[] {
  const out: Token[] = []
  const n = src.length
  let i = 0
  let text = ''
  const flushText = () => {
    if (text !== '') {
      out.push({ type: 'text', text: decodeEntities(text) })
      text = ''
    }
  }

  while (i < n) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      text += src.slice(i)
      break
    }
    text += src.slice(i, lt)

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      i = end < 0 ? n : end + 3
      continue
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9)
      // CDATA is literal text: bypass entity decoding by flushing around it.
      flushText()
      const literal = src.slice(lt + 9, end < 0 ? n : end)
      if (literal !== '') out.push({ type: 'text', text: literal })
      i = end < 0 ? n : end + 3
      continue
    }
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const end = src.indexOf('>', lt)
      i = end < 0 ? n : end + 1
      continue
    }

    // Tag: "<" optional "/" name attrs optional "/" ">"
    let j = lt + 1
    let closing = false
    if (src[j] === '/') {
      closing = true
      j++
    }
    const nameStart = j
    while (j < n && !/[\s/>]/.test(src[j])) j++
    const name = src.slice(nameStart, j).toLowerCase()
    if (name === '' || !/^[a-z]/.test(name)) {
      // A bare "<" in text.
      text += '<'
      i = lt + 1
      continue
    }

    const attrs: Record<string, string> = {}
    let selfClosing = false
    for (;;) {
      ATTR_RE.lastIndex = j
      const m = ATTR_RE.exec(src)
      if (!m || m[1] === '') break
      const key = m[1]
      if (key.endsWith('/') && m[2] === undefined && m[3] === undefined && m[4] === undefined) {
        // e.g. `<br class=x/>`: the trailing slash was lexed into the attribute name.
        if (key.length > 1) attrs[key.slice(0, -1).toLowerCase()] = ''
        selfClosing = true
        j = m.index + m[0].length
        break
      }
      attrs[key.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
      j = m.index + m[0].length
    }
    while (j < n && /\s/.test(src[j])) j++
    if (src[j] === '/') {
      selfClosing = true
      j++
    }
    const gt = src.indexOf('>', j)
    i = gt < 0 ? n : gt + 1

    flushText()
    if (closing) {
      out.push({ type: 'close', name, attrs: {}, selfClosing: false })
      continue
    }
    out.push({ type: 'open', name, attrs, selfClosing })

    if (!selfClosing && RAW_TEXT.has(name)) {
      const endRe = new RegExp(`</${name}\\s*>`, 'ig')
      endRe.lastIndex = i
      const m = endRe.exec(src)
      i = m ? m.index + m[0].length : n
      out.push({ type: 'close', name, attrs: {}, selfClosing: false })
    }
  }
  flushText()
  return out
}

/** Strip a namespace prefix: "dc:title" → "title". */
export function localName(name: string): string {
  const colon = name.indexOf(':')
  return colon < 0 ? name : name.slice(colon + 1)
}

export interface Element {
  /** Local name, lowercased. */
  name: string
  attrs: Record<string, string>
  /** Concatenated descendant text. */
  text: string
}

/**
 * Flatten a document into its elements in document order (order of the opening tag), each
 * with its attributes and descendant text. Enough for package, container and NCX files.
 */
export function parseElements(src: string): Element[] {
  const out: Element[] = []
  const stack: Element[] = []
  for (const tok of tokenize(src)) {
    if (tok.type === 'text') {
      for (const el of stack) el.text += tok.text
    } else if (tok.type === 'open') {
      const el: Element = { name: localName(tok.name), attrs: tok.attrs, text: '' }
      out.push(el)
      if (!tok.selfClosing) stack.push(el)
    } else {
      const name = localName(tok.name)
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name === name) {
          stack.length = k
          break
        }
      }
    }
  }
  return out
}

/** One block-level run of text from a content document. */
export interface Block {
  /** Local name of the block element ("p", "h1", "div", "li", …). */
  tag: string
  /** Its class attribute, or "" when absent. */
  cls: string
  /** Whitespace-collapsed text. */
  text: string
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'td', 'th', 'dt',
  'dd', 'section', 'article', 'aside', 'header', 'footer', 'figure', 'figcaption', 'table',
  'tr', 'thead', 'tbody', 'tfoot', 'ul', 'ol', 'dl', 'nav', 'body', 'html', 'center', 'address',
  'main', 'details', 'summary', 'hgroup', 'caption',
])
/** Whole subtree is dropped. */
const SKIP_TAGS = new Set([
  'head', 'title', 'script', 'style', 'svg', 'img', 'image', 'video', 'audio', 'object',
  'noscript', 'template', 'math', 'select', 'option', 'input', 'button', 'iframe', 'canvas',
  'map', 'embed',
])
const VOID_TAGS = new Set([
  'br', 'hr', 'img', 'image', 'input', 'meta', 'link', 'base', 'area', 'col', 'embed',
  'param', 'source', 'track', 'wbr',
])
/** A `<sup>` whose text looks like an endnote / footnote marker. */
const SUP_MARKER = /^(?:[\d*†‡§¹²³⁴⁵⁶⁷⁸⁹⁰]{1,4}|[a-z]|\[\d{1,4}\])$/

/**
 * Collapse all whitespace (including NBSP and line breaks) to one space, drop soft hyphens
 * and zero-width characters, and trim.
 */
export function collapseWhitespace(s: string): string {
  return s.replace(/[­​‌‍﻿]/g, '').replace(/[\s ]+/g, ' ').trim()
}

const HAS_WORD_CHAR = /[\p{L}\p{N}]/u

/**
 * Reduce a content document to its blocks of text, per plan §1.1b:
 * inline elements (`span`, `em`, `a`, …) contribute their text with nothing added, so a
 * word split across two spans is rejoined; `<sup>` endnote markers, images, scripts and
 * styles are dropped; only block elements start a new paragraph; a single `<br>` is a
 * space, two or more in a row are a paragraph break. Blocks without a letter or digit
 * (ornaments like "• • •") are dropped.
 */
export function htmlToBlocks(html: string): Block[] {
  const blocks: Block[] = []
  const open: { tag: string; cls: string }[] = []
  let cur: { tag: string; cls: string; text: string } | null = null
  let skipDepth = 0
  let sup: string | null = null
  let brRun = 0

  const flush = () => {
    if (cur) {
      const text = collapseWhitespace(cur.text)
      if (text !== '' && HAS_WORD_CHAR.test(text)) blocks.push({ tag: cur.tag, cls: cur.cls, text })
    }
    cur = null
  }
  const addText = (t: string) => {
    if (sup !== null) {
      sup += t
      return
    }
    if (t.trim() !== '') brRun = 0
    if (!cur) {
      if (t.trim() === '') return
      const top = open[open.length - 1]
      cur = { tag: top?.tag ?? 'body', cls: top?.cls ?? '', text: '' }
    }
    cur.text += t
  }

  for (const tok of tokenize(html)) {
    if (skipDepth > 0) {
      if (tok.type === 'open' && !tok.selfClosing && !VOID_TAGS.has(localName(tok.name))) skipDepth++
      else if (tok.type === 'close') skipDepth--
      continue
    }
    if (tok.type === 'text') {
      addText(tok.text)
      continue
    }
    const name = localName(tok.name)
    if (tok.type === 'open') {
      if (SKIP_TAGS.has(name)) {
        if (!tok.selfClosing && !VOID_TAGS.has(name)) skipDepth = 1
        continue
      }
      if (name === 'br') {
        brRun++
        if (brRun >= 2) flush()
        else addText(' ')
        continue
      }
      if (name === 'hr') {
        flush()
        brRun = 0
        continue
      }
      if (name === 'sup') {
        if (!tok.selfClosing) sup = ''
        continue
      }
      if (BLOCK_TAGS.has(name)) {
        flush()
        brRun = 0
        if (tok.selfClosing) continue
        const cls = tok.attrs['class'] ?? ''
        open.push({ tag: name, cls })
        cur = { tag: name, cls, text: '' }
      }
      // Inline element: contributes nothing but its text.
      continue
    }
    // Closing tag.
    if (name === 'sup') {
      const marker = sup ?? ''
      sup = null
      if (!SUP_MARKER.test(marker.trim())) addText(marker)
      continue
    }
    if (BLOCK_TAGS.has(name)) {
      flush()
      brRun = 0
      for (let k = open.length - 1; k >= 0; k--) {
        if (open[k].tag === name) {
          open.length = k
          break
        }
      }
    }
  }
  flush()
  return blocks
}
