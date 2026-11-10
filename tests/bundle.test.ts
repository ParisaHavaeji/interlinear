// Book bundles (plan.md step 14): export an aligned book as .interlinear.json, import it elsewhere.
import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inlineRunner, needsAlignment, startAlignment } from '../src/align/jobs.ts'
import type { ImportedText } from '../src/import/file.ts'
import { parseTxt } from '../src/import/txt.ts'
import { addBook, getParagraphs, listBooks } from '../src/store/books.ts'
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  BundleError,
  bundleFileName,
  exportBundle,
  importBundle,
  isBundleFileName,
  parseBundle,
  sentenceText,
  type Bundle,
} from '../src/store/bundle.ts'
import { openDatabase, type InterlinearDB } from '../src/store/db.ts'

let db: InterlinearDB
let n = 0

beforeEach(() => {
  db = openDatabase(`bundle-${n++}`)
})

afterEach(async () => {
  await db.delete()
})

function txt(fileName: string, text: string): ImportedText {
  const paragraphs = text.split('\n\n').map((t, idx) => ({ idx, text: t }))
  return { fileName, format: 'txt', paragraphs, sections: [], words: text.split(/\s+/).length, meta: null, layout: 'blocks' }
}

const DE = txt('k.de.txt', 'I.\n\nGregor lachte im Haus. Samsa schlief im Zimmer.\n\nDie Mutter fand vier Wände.\n\nII.\n\nGregor lachte wieder.')
const EN = txt('k.en.txt', 'I.\n\nGregor laughed in the house. Samsa slept in the room.\n\nMother found four walls.\n\nII.\n\nGregor laughed again.')

const read = (file: string) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')
function fixture(file: string): ImportedText {
  const paragraphs = parseTxt(read(file))
  return { fileName: file, format: 'txt', paragraphs, sections: [], words: 0, meta: null, layout: 'blocks' }
}

/** An aligned test book in `db`. */
async function alignedBook() {
  const book = await addBook({ title: 'Die Verwandlung', author: 'Franz Kafka', de: DE, en: EN }, db)
  await startAlignment(book.id, { db, runner: inlineRunner })
  return (await db.books.get(book.id))!
}

describe('bundleFileName / isBundleFileName', () => {
  it('slugs the title and keeps the suffix', () => {
    expect(bundleFileName({ title: 'Die Leiden des jungen Werther' })).toBe('die-leiden-des-jungen-werther.interlinear.json')
    expect(bundleFileName({ title: '  Über Nacht: „Demian“!  ' })).toBe('uber-nacht-demian.interlinear.json')
    expect(bundleFileName({ title: '???' })).toBe('book.interlinear.json')
    expect(bundleFileName({ title: 'x'.repeat(100) }).length).toBeLessThan(80)
  })

  it('recognises .json files as bundles', () => {
    expect(isBundleFileName('demian.interlinear.json')).toBe(true)
    expect(isBundleFileName('BOOK.JSON')).toBe(true)
    expect(isBundleFileName('book.txt')).toBe(false)
    expect(isBundleFileName('book.epub')).toBe(false)
  })
})

describe('exportBundle', () => {
  it('holds the book, both texts, the sentences as slices and the beads', async () => {
    const book = await alignedBook()
    const bundle = await exportBundle(book.id, db)

    expect(bundle).toMatchObject({ format: BUNDLE_FORMAT, version: BUNDLE_VERSION })
    expect(bundle.exported).toBeGreaterThan(0)
    expect(bundle.book).toEqual(book)
    expect(bundle.paragraphs.de.map((p) => p.text)).toEqual(DE.paragraphs.map((p) => p.text))
    expect(bundle.paragraphs.en).toHaveLength(5)
    expect(bundle.sentences.de).toHaveLength(6)
    expect(bundle.sentences.de[2]).toEqual([1, 23, 47])
    // Sentence texts are slices of their paragraphs, so none is repeated.
    for (const s of bundle.sentences.de) expect(s).toHaveLength(3)
    expect(sentenceText(bundle.sentences.de[2], bundle.paragraphs.de)).toBe('Samsa schlief im Zimmer.')
    expect(bundle.beads.map((b) => `${b.de.join('+')}:${b.en.join('+')}`)).toEqual(['1:1', '2:2', '3:3', '5:5'])
    expect(bundle.beads[0]).toMatchObject({ manual: false })
    expect(bundle.beads[0].confidence).toBeGreaterThan(0.5)
  })

  it('writes the text of a sentence that is not a slice of its paragraph', async () => {
    const book = await alignedBook()
    await db.sentences.update([book.id, 'de', 1], { text: 'Edited.' })
    const bundle = await exportBundle(book.id, db)
    expect(bundle.sentences.de[1]).toEqual([1, 0, 22, 'Edited.'])
    expect(bundle.sentences.de[2]).toHaveLength(3)
  })

  it('exports an unaligned book with no sentences and a pending status, and a running one as pending', async () => {
    const book = await addBook({ title: 'P', author: '', de: DE, en: EN }, db)
    let bundle = await exportBundle(book.id, db)
    expect(bundle.book.alignment?.status).toBe('pending')
    expect(bundle.sentences).toEqual({ de: [], en: [] })
    expect(bundle.beads).toEqual([])
    await db.books.update(book.id, { alignment: { status: 'aligning', updated: 1 } })
    bundle = await exportBundle(book.id, db)
    expect(bundle.book.alignment?.status).toBe('pending')
  })

  it('refuses an unknown book', async () => {
    await expect(exportBundle('nope', db)).rejects.toThrow(BundleError)
  })

  it('survives a JSON round trip unchanged', async () => {
    const book = await alignedBook()
    const bundle = await exportBundle(book.id, db)
    expect(parseBundle(JSON.stringify(bundle))).toEqual(bundle)
  })
})

describe('parseBundle', () => {
  let bundle: Bundle
  beforeEach(async () => {
    bundle = await exportBundle((await alignedBook()).id, db)
  })

  /** The bundle with one path changed, as JSON text. */
  const mutate = (fn: (b: Bundle) => void): string => {
    const copy = JSON.parse(JSON.stringify(bundle)) as Bundle
    fn(copy)
    return JSON.stringify(copy)
  }

  it('rejects things that are not bundles with a readable message', () => {
    expect(() => parseBundle('not json')).toThrow('not valid JSON')
    expect(() => parseBundle('[]')).toThrow('not an object')
    expect(() => parseBundle('{"format":"epub"}')).toThrow('not an Interlinear bundle')
    expect(() => parseBundle(mutate((b) => (b.version = BUNDLE_VERSION + 1)))).toThrow('newer version')
    expect(() => parseBundle(mutate((b) => ((b.book as { langs: unknown }).langs = ['fr', 'en'])))).toThrow('book.langs')
  })

  it('names the first bad field', () => {
    expect(() => parseBundle(mutate((b) => ((b.book as { title: unknown }).title = 7)))).toThrow('book.title')
    expect(() => parseBundle(mutate((b) => (b.paragraphs.de[1].idx = 5)))).toThrow('paragraphs.de[1].idx')
    expect(() => parseBundle(mutate((b) => (b.sentences.en[0][0] = 99)))).toThrow('sentences.en[0] paraIdx')
    expect(() => parseBundle(mutate((b) => (b.sentences.en[1][2] = 1000)))).toThrow('sentences.en[1] charEnd')
    expect(() => parseBundle(mutate((b) => (b.beads[0].de = [42])))).toThrow('beads[0].de')
    expect(() => parseBundle(mutate((b) => (b.beads[1].confidence = 1.5)))).toThrow('beads[1].confidence')
    expect(() => parseBundle(mutate((b) => ((b.book.sources.de as { format: unknown }).format = 'pdf')))).toThrow('book.sources.de.format')
    expect(() => parseBundle(mutate((b) => ((b.book.alignment!.chapters!.pairs[0] as { de: unknown }).de = [9])))).toThrow('chapters.pairs[0].de')
    expect(() => parseBundle(mutate((b) => (b.paragraphs.en = [])))).toThrow('no text')
    expect(() => parseBundle(mutate((b) => (b.beads[0].en = [99])))).toThrow('beads[0].en')
    expect(() => parseBundle(mutate((b) => ((b.sentences = { de: [], en: [] }), (b.beads = []))))).toThrow('holds no sentences')
  })

  it('fills optional fields with their defaults', () => {
    const minimal = mutate((b) => {
      const loose = b as unknown as Record<string, unknown>
      delete loose.exported
      delete loose.sentences
      delete loose.beads
      delete b.book.alignment
    })
    const parsed = parseBundle(minimal)
    expect(parsed.exported).toBe(0)
    expect(parsed.sentences).toEqual({ de: [], en: [] })
    expect(parsed.beads).toEqual([])
    expect(parsed.book.alignment).toBeUndefined()
  })
})

describe('importBundle', () => {
  it('recreates the book, its texts, sentences and beads, ready to read', async () => {
    const original = await alignedBook()
    const json = JSON.stringify(await exportBundle(original.id, db))

    const other = openDatabase(`bundle-import-${n++}`)
    try {
      const before = Date.now()
      const book = await importBundle(parseBundle(json), {}, other)
      expect(book.id).toBe(original.id)
      expect(book.title).toBe('Die Verwandlung')
      expect(book.created).toBeGreaterThanOrEqual(before)
      expect(book.alignment).toMatchObject({ status: 'ready', stats: original.alignment!.stats, chapters: original.alignment!.chapters })
      expect(needsAlignment(book)).toBe(false)
      expect(await listBooks(other)).toEqual([book])

      expect((await getParagraphs(book.id, 'de', other)).map((p) => p.text)).toEqual(DE.paragraphs.map((p) => p.text))
      const sentences = await other.sentences.where('[bookId+lang]').equals([book.id, 'de']).sortBy('idx')
      expect(sentences).toEqual(await db.sentences.where('[bookId+lang]').equals([book.id, 'de']).sortBy('idx'))
      const beads = await other.beads.where('bookId').equals(book.id).sortBy('beadIdx')
      expect(beads).toEqual(await db.beads.where('bookId').equals(book.id).sortBy('beadIdx'))
    } finally {
      await other.delete()
    }
  })

  it('takes a fresh id when the library already has the bundle’s book, and the sheet’s title and author', async () => {
    const original = await alignedBook()
    const bundle = await exportBundle(original.id, db)
    const copy = await importBundle(bundle, { title: 'Metamorphosis', author: ' ' }, db)
    expect(copy.id).not.toBe(original.id)
    expect(copy.title).toBe('Metamorphosis')
    expect(copy.author).toBe('Franz Kafka')
    expect(await db.books.count()).toBe(2)
    expect(await db.sentences.where('bookId').equals(copy.id).count()).toBe(12)
    expect(await db.beads.where('bookId').equals(copy.id).count()).toBe(4)
  })

  it('imports an unaligned bundle as pending and lets the queue align it', async () => {
    const book = await addBook({ title: 'P', author: '', de: DE, en: EN }, db)
    const bundle = await exportBundle(book.id, db)
    const other = openDatabase(`bundle-pending-${n++}`)
    try {
      const imported = await importBundle(bundle, {}, other)
      expect(imported.alignment).toMatchObject({ status: 'pending' })
      expect(needsAlignment(imported)).toBe(true)
      expect(await other.sentences.count()).toBe(0)
      await startAlignment(imported.id, { db: other, runner: inlineRunner })
      expect((await other.books.get(imported.id))?.alignment?.status).toBe('ready')
      expect(await other.beads.where('bookId').equals(imported.id).count()).toBe(4)
    } finally {
      await other.delete()
    }
  })

  it('round-trips the Kafka novella at about the size of its two texts', async () => {
    const book = await addBook({ title: 'Die Verwandlung', author: 'Kafka', de: fixture('kafka-verwandlung.de.txt'), en: fixture('kafka-verwandlung.en.txt') }, db)
    await startAlignment(book.id, { db, runner: inlineRunner })
    const bundle = await exportBundle(book.id, db)
    const json = JSON.stringify(bundle)
    const textSize = read('kafka-verwandlung.de.txt').length + read('kafka-verwandlung.en.txt').length
    expect(json.length).toBeLessThan(textSize * 1.4)

    const other = openDatabase(`bundle-kafka-${n++}`)
    try {
      const imported = await importBundle(parseBundle(json), {}, other)
      expect(await other.beads.where('bookId').equals(imported.id).count()).toBe(bundle.beads.length)
      expect(await other.sentences.where('bookId').equals(imported.id).count()).toBe(bundle.sentences.de.length + bundle.sentences.en.length)
      const s = (await other.sentences.where('[bookId+lang]').equals([imported.id, 'en']).sortBy('idx'))[10]
      expect(s.text).toBe((await db.sentences.get([book.id, 'en', 10]))!.text)
    } finally {
      await other.delete()
    }
  }, 30_000)
})
