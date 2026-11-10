import { existsSync, readFileSync } from 'node:fs'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { EpubError, parseEpub, parsePackage, resolvePath } from '../src/import/epub.ts'
import type { EpubBook } from '../src/import/types.ts'

// ---------------------------------------------------------------------------
// Synthetic EPUB 3 (nav document, nested OEBPS directory, percent-encoded href)
// ---------------------------------------------------------------------------

const sentence = 'The quick brown fox jumps over the lazy dog and keeps running through the field. '
const longText = sentence.repeat(30) // ~450 words

function page(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>ignored</title></head><body>${body}</body></html>`
}

async function makeEpub(overrides: Partial<Record<string, string | null>> = {}): Promise<Uint8Array> {
  const files: Record<string, string | null> = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    'OEBPS/content.opf': `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>Test &amp; Book</dc:title>
    <dc:creator opf:role="trl">Some Translator</dc:creator>
    <dc:creator opf:role="aut">Jane Author</dc:creator>
    <dc:language>De-DE</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="copy" href="text/copyright.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="text/ch%201.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="text/notes.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="cover"/>
    <itemref idref="copy"/>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="notes" linear="no"/>
  </spine>
</package>`,
    'OEBPS/nav.xhtml': page(`<nav epub:type="toc"><ol>
      <li><a href="text/cover.xhtml">Cover</a></li>
      <li><a href="text/ch%201.xhtml#start">Chapter 1: <em>Start</em></a></li>
      <li><a href="text/ch%201.xhtml#later">Later in chapter 1</a></li>
      <li><a href="text/ch2.xhtml">Chapter 2</a></li>
    </ol></nav>`),
    'OEBPS/text/cover.xhtml': page('<div><img src="../cover.jpg" alt="cover"/></div>'),
    'OEBPS/text/copyright.xhtml': page('<p>Copyright &#169; 2020 Jane Author. All rights reserved.</p><p>ISBN 978-0-00-000000-0</p>'),
    'OEBPS/text/ch 1.xhtml': page(
      `<h1>Chapter One</h1><p class="first">${longText}</p><p>Second paragraph with an endnote<a href="#n1"><sup>1</sup></a> here.</p>`,
    ),
    'OEBPS/text/ch2.xhtml': page(`<p>Kapitel 2</p><p>${longText}</p>`),
    'OEBPS/text/notes.xhtml': page('<p>1. A note.</p>'),
    ...overrides,
  }
  const zip = new JSZip()
  for (const [path, content] of Object.entries(files)) if (content !== null) zip.file(path, content)
  return zip.generateAsync({ type: 'uint8array' })
}

describe('parseEpub on a synthetic EPUB 3', () => {
  let book: EpubBook
  const load = async () => (book ??= await parseEpub(await makeEpub()))

  it('reads title, the author with role aut, and the lowercased language', async () => {
    await load()
    expect(book.title).toBe('Test & Book')
    expect(book.author).toBe('Jane Author')
    expect(book.language).toBe('de-de')
  })

  it('emits one section per spine item in spine order, with resolved hrefs and linear flags', async () => {
    await load()
    expect(book.sections.map((s) => s.href)).toEqual([
      'OEBPS/text/cover.xhtml',
      'OEBPS/text/copyright.xhtml',
      'OEBPS/text/ch 1.xhtml',
      'OEBPS/text/ch2.xhtml',
      'OEBPS/text/notes.xhtml',
    ])
    expect(book.sections.map((s) => s.idx)).toEqual([0, 1, 2, 3, 4])
    expect(book.sections.map((s) => s.linear)).toEqual([true, true, true, true, false])
  })

  it('takes titles from the nav document, first label per document, fragments ignored', async () => {
    await load()
    expect(book.sections.map((s) => s.title)).toEqual(['Cover', null, 'Chapter 1: Start', 'Chapter 2', null])
  })

  it('detects headings and kinds', async () => {
    await load()
    expect(book.sections.map((s) => s.heading)).toEqual([null, null, 'Chapter One', 'Kapitel 2', null])
    expect(book.sections.map((s) => s.kind)).toEqual(['front', 'front', 'body', 'body', 'back'])
  })

  it('flattens paragraphs, keeps class hints and drops endnote markers', async () => {
    await load()
    const ch1 = book.sections[2]
    expect(ch1.paragraphs).toHaveLength(2)
    expect(ch1.paragraphs[0]).toMatchObject({ idx: 0, cls: 'first' })
    expect(ch1.paragraphs[0].text.startsWith('The quick brown fox')).toBe(true)
    expect(ch1.paragraphs[1]).toEqual({ idx: 1, text: 'Second paragraph with an endnote here.' })
    expect(ch1.words).toBeGreaterThan(400)
    expect(book.sections[0].paragraphs).toEqual([])
    expect(book.sections[0].words).toBe(0)
  })

  it('accepts a Blob', async () => {
    const bytes = await makeEpub()
    const fromBlob = await parseEpub(new Blob([bytes]))
    expect(fromBlob.sections.map((s) => s.href)).toEqual(book.sections.map((s) => s.href))
  })

  it('falls back to the NCX when there is no nav document', async () => {
    const opf = (await makeEpubFiles())['OEBPS/content.opf']!
      .replace(' properties="nav"', '')
      .replace('<item id="css"', '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css"')
      .replace('<spine>', '<spine toc="ncx">')
    const ncx = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
      <navPoint id="a"><navLabel><text>Erstes Kapitel</text></navLabel><content src="text/ch%201.xhtml"/></navPoint>
      <navPoint id="b"><navLabel><text>Zweites Kapitel</text></navLabel><content src="text/ch2.xhtml#x"/></navPoint>
    </navMap></ncx>`
    const b = await parseEpub(await makeEpub({ 'OEBPS/content.opf': opf, 'OEBPS/toc.ncx': ncx }))
    expect(b.sections.map((s) => s.title)).toEqual([null, null, 'Erstes Kapitel', 'Zweites Kapitel', null])
  })
})

/** The default file map, for tests that patch one entry. */
async function makeEpubFiles(): Promise<Record<string, string | null>> {
  const zip = await JSZip.loadAsync(await makeEpub())
  const out: Record<string, string | null> = {}
  for (const [path, file] of Object.entries(zip.files)) if (!file.dir) out[path] = await file.async('string')
  return out
}

describe('parseEpub errors', () => {
  it('rejects data that is not a zip', async () => {
    await expect(parseEpub(new TextEncoder().encode('hello'))).rejects.toBeInstanceOf(EpubError)
  })

  it('rejects a zip without container.xml', async () => {
    await expect(parseEpub(await makeEpub({ 'META-INF/container.xml': null }))).rejects.toThrow(/container\.xml/)
  })

  it('rejects a container whose package document is missing', async () => {
    await expect(parseEpub(await makeEpub({ 'OEBPS/content.opf': null }))).rejects.toThrow(/Package document not found/)
  })
})

describe('parsePackage', () => {
  it('rejects an empty spine', () => {
    expect(() => parsePackage('<package><manifest/><spine/></package>', '')).toThrow(/empty spine/)
  })

  it('resolves hrefs against the package directory and skips unknown idrefs', () => {
    const pkg = parsePackage(
      '<package><manifest><item id="a" href="../a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="missing"/></spine></package>',
      'OEBPS/text',
    )
    expect(pkg.spine).toEqual([{ href: 'OEBPS/a.xhtml', linear: true }])
    expect(pkg.title).toBeNull()
    expect(pkg.navHref).toBeNull()
    expect(pkg.ncxHref).toBeNull()
  })
})

describe('resolvePath', () => {
  it('joins, normalises dot segments, decodes percent-encoding and drops fragments', () => {
    expect(resolvePath('OEBPS', 'text/a.xhtml#frag')).toBe('OEBPS/text/a.xhtml')
    expect(resolvePath('OEBPS/text', '../b%20c.xhtml?x=1')).toBe('OEBPS/b c.xhtml')
    expect(resolvePath('', './a.xhtml')).toBe('a.xhtml')
    expect(resolvePath('OEBPS', '/abs.xhtml')).toBe('abs.xhtml')
    expect(resolvePath('a', '%E0%A4%A')).toBe('a/%E0%A4%A')
  })
})

// ---------------------------------------------------------------------------
// The real thing: the two Demian EPUBs in Input/ (gitignored; skipped when absent)
// ---------------------------------------------------------------------------

const INPUT = new URL('../Input/', import.meta.url)
const DE_PATH = new URL('Demian (Hermann Hesse) (z-library.sk, 1lib.sk, z-lib.sk).epub', INPUT)
const EN_PATH = new URL('Demian (Hermann Hesse) (z-library.sk, 1lib.sk, z-lib.sk) (2).epub', INPUT)
const haveDemian = existsSync(DE_PATH) && existsSync(EN_PATH)

const allText = (book: EpubBook) => book.sections.flatMap((s) => s.paragraphs.map((p) => p.text)).join('\n')

describe.skipIf(!haveDemian)('Demian, German EPUB (Calibre)', () => {
  let book: EpubBook
  const load = async () => (book ??= await parseEpub(readFileSync(DE_PATH)))

  it('reads the metadata', async () => {
    await load()
    expect(book).toMatchObject({ title: 'Demian', author: 'Hermann Hesse', language: 'de' })
  })

  it('has 11 spine items: cover, title page, prologue and eight chapters', async () => {
    await load()
    expect(book.sections).toHaveLength(11)
    expect(book.sections.map((s) => s.kind)).toEqual(['front', 'front', ...Array<'body'>(9).fill('body')])
  })

  it('detects the chapter headings from Calibre paragraphs, with no <h*> tags', async () => {
    await load()
    expect(book.sections.slice(2).map((s) => s.heading)).toEqual([
      null, // prologue
      'Zwei Welten',
      'Kain',
      'Der Schacher', // sic: the Calibre conversion dropped the umlaut, and display text is never altered
      'Beatrice',
      'Der Vogel kämpft sich aus dem Ei',
      'Jakobs Kampf',
      'Frau Eva',
      'Anfang vom Ende',
    ])
  })

  it('has plausible word counts (prologue ~500, chapters 2.5k–7.5k)', async () => {
    await load()
    const [prologue, ...chapters] = book.sections.slice(2)
    expect(prologue.words).toBeGreaterThan(450)
    expect(prologue.words).toBeLessThan(600)
    for (const c of chapters) {
      expect(c.words, c.heading ?? '').toBeGreaterThan(2500)
      expect(c.words, c.heading ?? '').toBeLessThan(7600)
    }
  })

  it('rejoins words that Calibre split across spans and leaves no markup or soft hyphens', async () => {
    await load()
    const text = allText(book)
    expect(text).toMatch(/\bVorbild\b/)
    expect(text).not.toMatch(/Vorbi ld/)
    expect(text).not.toMatch(/<\/?[a-z]/)
    expect(text).not.toMatch(/[­​]/)
    expect(text).not.toMatch(/  /)
  })
})

describe.skipIf(!haveDemian)('Demian, English EPUB (Penguin Classics)', () => {
  let book: EpubBook
  const load = async () => (book ??= await parseEpub(readFileSync(EN_PATH)))

  it('reads the metadata', async () => {
    await load()
    expect(book).toMatchObject({ title: 'Demian', author: 'Hermann Hesse', language: 'en-us' })
  })

  it('has 20 spine items: nine front, nine body, two back', async () => {
    await load()
    expect(book.sections).toHaveLength(20)
    expect(book.sections.map((s) => s.kind)).toEqual([
      ...Array<'front'>(9).fill('front'),
      ...Array<'body'>(9).fill('body'),
      'back',
      'back',
    ])
  })

  it('keeps the Foreword, Introduction and Further Reading out of the body', async () => {
    await load()
    const matter = book.sections.filter((s) => s.kind !== 'body').map((s) => s.title)
    expect(matter).toEqual(expect.arrayContaining(['Foreword', 'Introduction', 'Suggestions for Further Reading', 'Copyright', 'Contents']))
    expect(book.sections.find((s) => s.title === 'Introduction')!.words).toBeGreaterThan(6000)
  })

  it('maps the prologue and the eight chapters to body sections, with headings from class-hinted paragraphs', async () => {
    await load()
    const body = book.sections.filter((s) => s.kind === 'body')
    expect(body[0]).toMatchObject({ title: 'Preface', heading: null })
    expect(body[0].words).toBeGreaterThan(500)
    expect(body.slice(1).map((s) => s.heading)).toEqual([
      'CHAPTER ONE: TWO WORLDS',
      'CHAPTER TWO: CAIN',
      'CHAPTER THREE: THE THIEF ON THE CROSS',
      'CHAPTER FOUR: BEATRICE',
      'CHAPTER FIVE: THE BIRD FIGHTS ITS WAY OUT OF THE EGG',
      'CHAPTER SIX: JACOB WRESTLES WITH THE ANGEL',
      'CHAPTER SEVEN: EVE',
      'CHAPTER EIGHT: THE BEGINNING OF THE END',
    ])
    expect(body.slice(1).map((s) => s.title)).toEqual([
      'CHAPTER ONE: Two Worlds',
      'CHAPTER TWO: Cain',
      'CHAPTER THREE: The Thief on the Cross',
      'CHAPTER FOUR: Beatrice',
      'CHAPTER FIVE: The Bird Fights Its Way Out of the Egg',
      'CHAPTER SIX: Jacob Wrestles with the Angel',
      'CHAPTER SEVEN: Eve',
      'CHAPTER EIGHT: The Beginning of the End',
    ])
  })

  it('drops the endnote markers in the introduction and the "• • •" section breaks', async () => {
    await load()
    const intro = book.sections.find((s) => s.title === 'Introduction')!
    const introText = intro.paragraphs.map((p) => p.text).join(' ')
    expect(introText).not.toMatch(/[a-z][.,;”]\d{1,2}\s/)
    const text = allText(book)
    expect(text).not.toMatch(/•/)
    expect(text).not.toMatch(/<\/?[a-z]/)
  })

  it('keeps class hints on paragraphs for the section heuristics', async () => {
    await load()
    const chapterOne = book.sections.find((s) => s.heading === 'CHAPTER ONE: TWO WORLDS')!
    expect(chapterOne.paragraphs[0].cls).toBe('x03-CO-Body-Text')
    expect(chapterOne.paragraphs[1].cls).toBe('x04-Body-Text')
  })
})
