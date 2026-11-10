import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatOf, importFile, ImportError, type ImportedText } from '../src/import/file.ts'
import { addBook, deleteBook, getParagraphs, listBooks, newId } from '../src/store/books.ts'
import { openDatabase, type InterlinearDB } from '../src/store/db.ts'

let db: InterlinearDB
let n = 0

beforeEach(() => {
  db = openDatabase(`test-${n++}`)
})

afterEach(async () => {
  await db.delete()
})

function txt(fileName: string, text: string, words = text.split(/\s+/).length): ImportedText {
  const paragraphs = text.split('\n\n').map((t, idx) => ({ idx, text: t }))
  return { fileName, format: 'txt', paragraphs, sections: [], words, meta: null }
}

const DE = txt('verwandlung.de.txt', 'Als Gregor Samsa erwachte.\n\nEr lag auf dem Rücken.\n\nWas ist mit mir geschehen?')
const EN = txt('verwandlung.en.txt', 'One morning Gregor Samsa woke.\n\nHe lay on his back.')

describe('addBook / listBooks', () => {
  it('stores the book and both languages of paragraphs in one go', async () => {
    const book = await addBook({ title: 'Die Verwandlung', author: 'Franz Kafka', de: DE, en: EN }, db)

    expect(book.id).toMatch(/^[0-9a-f-]{32,36}$/)
    expect(book.langs).toEqual(['de', 'en'])
    expect(book.cover.hue).toBeGreaterThanOrEqual(0)
    expect(book.sources.de).toMatchObject({ fileName: 'verwandlung.de.txt', format: 'txt', paragraphs: 3, sections: [] })
    expect(book.sources.en.paragraphs).toBe(2)

    expect(await listBooks(db)).toEqual([book])
    expect((await getParagraphs(book.id, 'de', db)).map((p) => p.text)).toEqual([
      'Als Gregor Samsa erwachte.',
      'Er lag auf dem Rücken.',
      'Was ist mit mir geschehen?',
    ])
    expect((await getParagraphs(book.id, 'en', db)).map((p) => p.idx)).toEqual([0, 1])
    expect(await db.paragraphs.count()).toBe(5)
  })

  it('falls back to the German file name as title and "Unknown author"', async () => {
    const book = await addBook({ title: '  ', author: '', de: DE, en: EN }, db)
    expect(book.title).toBe('verwandlung.de')
    expect(book.author).toBe('Unknown author')
  })

  it('lists newest first', async () => {
    const a = await addBook({ title: 'A', author: '', de: DE, en: EN }, db)
    await db.books.update(a.id, { created: a.created - 1000 })
    const b = await addBook({ title: 'B', author: '', de: DE, en: EN }, db)
    expect((await listBooks(db)).map((x) => x.id)).toEqual([b.id, a.id])
  })

  it('keeps the paragraphs of two books apart and survives reopening', async () => {
    const a = await addBook({ title: 'A', author: '', de: DE, en: EN }, db)
    const b = await addBook({ title: 'B', author: '', de: EN, en: DE }, db)
    expect((await getParagraphs(a.id, 'de', db)).length).toBe(3)
    expect((await getParagraphs(b.id, 'de', db)).length).toBe(2)

    const name = db.name
    db.close()
    const reopened = openDatabase(name)
    expect((await listBooks(reopened)).map((x) => x.title).sort()).toEqual(['A', 'B'])
    reopened.close()
  })

  it('writes nothing when one paragraph write fails', async () => {
    const dup = { ...EN, paragraphs: [EN.paragraphs[0], { ...EN.paragraphs[1], idx: 0 }] }
    await expect(addBook({ title: 'Bad', author: '', de: DE, en: dup }, db)).rejects.toThrow()
    expect(await db.books.count()).toBe(0)
    expect(await db.paragraphs.count()).toBe(0)
  })
})

describe('deleteBook', () => {
  it('removes the book and its rows, leaving other books alone', async () => {
    const a = await addBook({ title: 'A', author: '', de: DE, en: EN }, db)
    const b = await addBook({ title: 'B', author: '', de: DE, en: EN }, db)
    await db.progress.put({ bookId: a.id, sentenceIdx: 3, scrollFraction: 0.5 })
    await db.bookmarks.add({ id: newId(), bookId: a.id, type: 'word', payload: {}, note: '', created: 1 })

    await deleteBook(a.id, db)

    expect((await listBooks(db)).map((x) => x.id)).toEqual([b.id])
    expect(await db.paragraphs.where('bookId').equals(a.id).count()).toBe(0)
    expect(await db.paragraphs.where('bookId').equals(b.id).count()).toBe(5)
    expect(await db.progress.count()).toBe(0)
    expect(await db.bookmarks.count()).toBe(0)
  })
})

describe('importFile', () => {
  it('maps extensions to importers', () => {
    expect(formatOf('book.txt')).toBe('txt')
    expect(formatOf('BOOK.EPUB')).toBe('epub')
    expect(formatOf('book.pdf')).toBeNull()
    expect(formatOf('book')).toBeNull()
  })

  it('imports a txt file with no sections or metadata', async () => {
    const file = new File(['Eins.\n\nZwei.'], 'kurz.txt', { type: 'text/plain' })
    const text = await importFile(file)
    expect(text).toMatchObject({ fileName: 'kurz.txt', format: 'txt', sections: [], meta: null, words: 2 })
    expect(text.paragraphs.map((p) => p.text)).toEqual(['Eins.', 'Zwei.'])
  })

  it('rejects unknown extensions and empty files with a readable error', async () => {
    await expect(importFile(new File(['x'], 'a.pdf'))).rejects.toThrow(ImportError)
    await expect(importFile(new File(['x'], 'a.pdf'))).rejects.toThrow('not a .txt or .epub')
    await expect(importFile(new File(['  \n\n '], 'empty.txt'))).rejects.toThrow('contains no text')
    await expect(importFile(new File(['not a zip'], 'bad.epub'))).rejects.toThrow(ImportError)
  })

  it('imports the Werther fixture end to end into the store', async () => {
    const de = await importFile(new File([readFileSync('tests/fixtures/goethe-werther.de.txt')], 'goethe-werther.de.txt'))
    const en = await importFile(new File([readFileSync('tests/fixtures/goethe-werther.en.txt')], 'goethe-werther.en.txt'))
    expect(de.paragraphs.length).toBeGreaterThan(100)
    expect(de.words).toBeGreaterThan(20000)

    const book = await addBook({ title: 'Werther', author: 'Goethe', de, en }, db)
    expect(await db.paragraphs.where('bookId').equals(book.id).count()).toBe(de.paragraphs.length + en.paragraphs.length)
    const stored = await getParagraphs(book.id, 'de', db)
    expect(stored.map((p) => p.idx)).toEqual(de.paragraphs.map((p) => p.idx))
    expect(stored.at(-1)?.text).toBe(de.paragraphs.at(-1)?.text)
  })
})
