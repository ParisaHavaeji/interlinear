/**
 * Book bundles (plan §1.2 "Fallbacks", step 14): one aligned book as a single
 * `.interlinear.json` file, so an alignment done on one device (a Mac, or later the neural
 * re-align of step 15) can be AirDropped to the phone and read there without aligning again.
 *
 * A bundle holds the book record, both languages' paragraphs, the sentences and the beads: all
 * that `jobs.ts` saves, and nothing the reader derives. Sentence texts are not repeated: a
 * sentence is a `[charStart, charEnd)` slice of its paragraph (the splitter's invariant), and
 * {@link importBundle} rebuilds the text from the slice. The text is written only for a
 * sentence that differs from its slice, which keeps a bundle at about 1.3× the size of the two
 * texts (Kafka: 320 KB; Demian: around 1 MB).
 *
 * {@link parseBundle} validates every field a later step reads before anything is written, so
 * a truncated or hand-edited file fails with one readable message instead of a reader that
 * crashes on bead 2,314. `version` lets a later schema grow; a bundle from a newer app is
 * refused rather than half-read.
 *
 * On import the book keeps its id when the library has no book of that id (bookmarks exported
 * later will refer to it), otherwise it gets a fresh one; `created` is the import time, so the
 * book shows up on the shelf as new. A bundle of a book that was never aligned is accepted and
 * imported as `pending`; the caller queues it like a fresh import.
 */

import type { ChapterMap } from '../align/pipeline.ts'
import type { Lang } from '../import/types.ts'
import { newId } from './books.ts'
import {
  db as sharedDb,
  type AlignmentState,
  type BeadRow,
  type Book,
  type InterlinearDB,
  type ParagraphRow,
  type SentenceRow,
  type SourceInfo,
} from './db.ts'

export const BUNDLE_FORMAT = 'interlinear-bundle'
export const BUNDLE_VERSION = 1
export const BUNDLE_SUFFIX = '.interlinear.json'

export interface BundleParagraph {
  idx: number
  text: string
  cls?: string
}

/**
 * One sentence, by position in its language's list (so `ParagraphSentence.idx` is the array
 * index): the paragraph it sits in and its character range there. A fourth element carries the
 * text only when it is not `paragraph.text.slice(charStart, charEnd)`. Tuples, not objects,
 * since a novel has several thousand of these on each side.
 */
export type BundleSentence = [paraIdx: number, charStart: number, charEnd: number] | [paraIdx: number, charStart: number, charEnd: number, text: string]

export interface BundleBead {
  de: number[]
  en: number[]
  confidence: number
  manual: boolean
}

export interface Bundle {
  format: typeof BUNDLE_FORMAT
  version: number
  /** Unix ms of the export. */
  exported: number
  book: Book
  paragraphs: Record<Lang, BundleParagraph[]>
  sentences: Record<Lang, BundleSentence[]>
  beads: BundleBead[]
}

export class BundleError extends Error {
  override name = 'BundleError'
}

const LANGS: readonly Lang[] = ['de', 'en']

// ---------------------------------------------------------------------------------------------
// Export

/** True for a file name the Add Book sheet should treat as a bundle. */
export function isBundleFileName(name: string): boolean {
  return /\.json$/i.test(name)
}

/** A file name for the bundle of a book: the title as a slug plus {@link BUNDLE_SUFFIX}. */
export function bundleFileName(book: Pick<Book, 'title'>): string {
  const slug = book.title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return `${slug || 'book'}${BUNDLE_SUFFIX}`
}

/** Collect a book and everything that hangs off it. Throws {@link BundleError} when the book is gone. */
export async function exportBundle(bookId: string, db: InterlinearDB = sharedDb()): Promise<Bundle> {
  return db.transaction('r', [db.books, db.paragraphs, db.sentences, db.beads], async () => {
    const book = await db.books.get(bookId)
    if (book === undefined) throw new BundleError('This book is no longer in the library.')
    const paragraphs = { de: [] as BundleParagraph[], en: [] as BundleParagraph[] }
    const sentences = { de: [] as BundleSentence[], en: [] as BundleSentence[] }
    for (const lang of LANGS) {
      const rows = await db.paragraphs.where('[bookId+lang]').equals([bookId, lang]).sortBy('idx')
      const byIdx = new Map(rows.map((p) => [p.idx, p.text]))
      paragraphs[lang] = rows.map((p) => (p.cls === undefined ? { idx: p.idx, text: p.text } : { idx: p.idx, text: p.text, cls: p.cls }))
      const sents = await db.sentences.where('[bookId+lang]').equals([bookId, lang]).sortBy('idx')
      sentences[lang] = sents.map((s, pos) => {
        if (s.idx !== pos) throw new BundleError(`Sentence ${lang} ${s.idx} is stored at position ${pos}; the book needs re-aligning before export.`)
        const slice = byIdx.get(s.paraIdx)?.slice(s.charStart, s.charEnd)
        return slice === s.text ? [s.paraIdx, s.charStart, s.charEnd] : [s.paraIdx, s.charStart, s.charEnd, s.text]
      })
    }
    const beads = (await db.beads.where('bookId').equals(bookId).sortBy('beadIdx')).map((b) => ({
      de: b.deSentenceIdx,
      en: b.enSentenceIdx,
      confidence: b.confidence,
      manual: b.manual,
    }))
    // A run in progress is not a state another device can resume.
    const alignment: AlignmentState | undefined =
      book.alignment === undefined ? undefined : book.alignment.status === 'aligning' ? { ...book.alignment, status: 'pending' } : book.alignment
    const record: Book = { ...book }
    if (alignment === undefined) delete record.alignment
    else record.alignment = alignment
    return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exported: Date.now(), book: record, paragraphs, sentences, beads }
  })
}

// ---------------------------------------------------------------------------------------------
// Parsing and validation

type Json = Record<string, unknown>

function fail(message: string): never {
  throw new BundleError(message)
}

function obj(v: unknown, what: string): Json {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`${what} is missing or not an object`)
  return v as Json
}

function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) fail(`${what} is missing or not a list`)
  return v
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string') fail(`${what} is missing or not text`)
  return v
}

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${what} is missing or not a number`)
  return v
}

function int(v: unknown, what: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = num(v, what)
  if (!Number.isInteger(n) || n < min || n > max) fail(`${what} must be a whole number between ${min} and ${max}, got ${n}`)
  return n
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') fail(`${what} is missing or not true/false`)
  return v
}

function optional<T>(v: unknown, read: (v: unknown) => T): T | undefined {
  return v === undefined || v === null ? undefined : read(v)
}

function sourceInfo(v: unknown, what: string): SourceInfo {
  const o = obj(v, what)
  const format = str(o.format, `${what}.format`)
  if (format !== 'txt' && format !== 'epub') fail(`${what}.format must be "txt" or "epub"`)
  const info: SourceInfo = {
    fileName: str(o.fileName, `${what}.fileName`),
    format,
    paragraphs: int(o.paragraphs, `${what}.paragraphs`),
    words: int(o.words, `${what}.words`),
    sections: arr(o.sections ?? [], `${what}.sections`).map((s, i) => {
      const sec = obj(s, `${what}.sections[${i}]`)
      const kind = str(sec.kind, `${what}.sections[${i}].kind`)
      if (kind !== 'front' && kind !== 'body' && kind !== 'back') fail(`${what}.sections[${i}].kind must be front, body or back`)
      return {
        idx: int(sec.idx, `${what}.sections[${i}].idx`),
        href: str(sec.href, `${what}.sections[${i}].href`),
        title: optional(sec.title, (t) => str(t, `${what}.sections[${i}].title`)) ?? null,
        heading: optional(sec.heading, (t) => str(t, `${what}.sections[${i}].heading`)) ?? null,
        kind,
        linear: bool(sec.linear ?? true, `${what}.sections[${i}].linear`),
        words: int(sec.words, `${what}.sections[${i}].words`),
        paraStart: int(sec.paraStart, `${what}.sections[${i}].paraStart`),
        paraCount: int(sec.paraCount, `${what}.sections[${i}].paraCount`),
      }
    }),
  }
  if (o.layout !== undefined) {
    if (o.layout !== 'blocks' && o.layout !== 'lines') fail(`${what}.layout must be "blocks" or "lines"`)
    info.layout = o.layout
  }
  return info
}

function chapterMap(v: unknown, what: string): ChapterMap {
  const o = obj(v, what)
  const side = (lang: Lang) =>
    arr(o[lang], `${what}.${lang}`).map((c, i) => {
      const ch = obj(c, `${what}.${lang}[${i}]`)
      return {
        idx: int(ch.idx, `${what}.${lang}[${i}].idx`),
        heading: optional(ch.heading, (t) => str(t, `${what}.${lang}[${i}].heading`)) ?? null,
        sectionIdx: optional(ch.sectionIdx, (t) => int(t, `${what}.${lang}[${i}].sectionIdx`)) ?? null,
        paraStart: int(ch.paraStart, `${what}.${lang}[${i}].paraStart`),
        paraCount: int(ch.paraCount, `${what}.${lang}[${i}].paraCount`),
        words: int(ch.words, `${what}.${lang}[${i}].words`),
      }
    })
  const de = side('de')
  const en = side('en')
  const pairs = arr(o.pairs, `${what}.pairs`).map((p, i) => {
    const pair = obj(p, `${what}.pairs[${i}]`)
    return {
      de: arr(pair.de, `${what}.pairs[${i}].de`).map((x) => int(x, `${what}.pairs[${i}].de`, 0, de.length - 1)),
      en: arr(pair.en, `${what}.pairs[${i}].en`).map((x) => int(x, `${what}.pairs[${i}].en`, 0, en.length - 1)),
    }
  })
  return { de, en, pairs }
}

function alignmentState(v: unknown, what: string): AlignmentState {
  const o = obj(v, what)
  const status = str(o.status, `${what}.status`)
  if (status !== 'pending' && status !== 'aligning' && status !== 'ready' && status !== 'failed') fail(`${what}.status is not a known status`)
  const state: AlignmentState = { status, updated: num(o.updated ?? 0, `${what}.updated`) }
  if (typeof o.error === 'string') state.error = o.error
  if (o.chapters !== undefined) state.chapters = chapterMap(o.chapters, `${what}.chapters`)
  if (o.lexicon !== undefined) {
    state.lexicon = arr(o.lexicon, `${what}.lexicon`).map((p, i) => {
      const pair = obj(p, `${what}.lexicon[${i}]`)
      return {
        de: str(pair.de, `${what}.lexicon[${i}].de`),
        en: str(pair.en, `${what}.lexicon[${i}].en`),
        count: int(pair.count, `${what}.lexicon[${i}].count`),
        dice: num(pair.dice, `${what}.lexicon[${i}].dice`),
      }
    })
  }
  if (o.stats !== undefined) {
    const s = obj(o.stats, `${what}.stats`)
    const counts = obj(s.sentences, `${what}.stats.sentences`)
    state.stats = {
      sentences: { de: int(counts.de, `${what}.stats.sentences.de`), en: int(counts.en, `${what}.stats.sentences.en`) },
      beads: int(s.beads, `${what}.stats.beads`),
      oneToOne: int(s.oneToOne, `${what}.stats.oneToOne`),
      uncertain: int(s.uncertain, `${what}.stats.uncertain`),
      learnedPairs: int(s.learnedPairs, `${what}.stats.learnedPairs`),
      changedBeads: int(s.changedBeads, `${what}.stats.changedBeads`),
      pairedChapters: int(s.pairedChapters, `${what}.stats.pairedChapters`),
      elapsedMs: num(s.elapsedMs, `${what}.stats.elapsedMs`),
    }
  }
  return state
}

function bookRecord(v: unknown): Book {
  const o = obj(v, 'book')
  const langs = arr(o.langs, 'book.langs')
  if (langs.length !== 2 || langs[0] !== 'de' || langs[1] !== 'en') fail('book.langs must be ["de", "en"]; other language pairs are not supported yet')
  const cover = obj(o.cover, 'book.cover')
  const sources = obj(o.sources, 'book.sources')
  const book: Book = {
    id: str(o.id, 'book.id'),
    title: str(o.title, 'book.title'),
    author: str(o.author, 'book.author'),
    langs: ['de', 'en'],
    created: num(o.created, 'book.created'),
    cover: { hue: num(cover.hue, 'book.cover.hue'), hue2: num(cover.hue2, 'book.cover.hue2') },
    sources: { de: sourceInfo(sources.de, 'book.sources.de'), en: sourceInfo(sources.en, 'book.sources.en') },
  }
  if (o.alignment !== undefined) book.alignment = alignmentState(o.alignment, 'book.alignment')
  return book
}

function paragraphs(v: unknown, what: string): BundleParagraph[] {
  return arr(v, what).map((p, i) => {
    const o = obj(p, `${what}[${i}]`)
    const idx = int(o.idx, `${what}[${i}].idx`)
    if (idx !== i) fail(`${what}[${i}].idx is ${idx}; paragraphs must be numbered 0, 1, 2, … in order`)
    const out: BundleParagraph = { idx, text: str(o.text, `${what}[${i}].text`) }
    if (o.cls !== undefined) out.cls = str(o.cls, `${what}[${i}].cls`)
    return out
  })
}

function sentences(v: unknown, what: string, paras: readonly BundleParagraph[]): BundleSentence[] {
  return arr(v, what).map((s, i) => {
    const t = arr(s, `${what}[${i}]`)
    if (t.length !== 3 && t.length !== 4) fail(`${what}[${i}] must be [paraIdx, charStart, charEnd] or [paraIdx, charStart, charEnd, text]`)
    const paraIdx = int(t[0], `${what}[${i}] paraIdx`, 0, paras.length - 1)
    const length = paras[paraIdx].text.length
    const charStart = int(t[1], `${what}[${i}] charStart`, 0, length)
    const charEnd = int(t[2], `${what}[${i}] charEnd`, charStart, length)
    return t.length === 3 ? [paraIdx, charStart, charEnd] : [paraIdx, charStart, charEnd, str(t[3], `${what}[${i}] text`)]
  })
}

function beads(v: unknown, counts: Record<Lang, number>): BundleBead[] {
  return arr(v, 'beads').map((b, i) => {
    const o = obj(b, `beads[${i}]`)
    const side = (lang: Lang) =>
      arr(o[lang], `beads[${i}].${lang}`).map((x) => {
        if (counts[lang] === 0) fail(`beads[${i}].${lang} names a sentence, but the bundle has no ${lang} sentences`)
        return int(x, `beads[${i}].${lang}`, 0, counts[lang] - 1)
      })
    const de = side('de')
    const en = side('en')
    if (de.length === 0 && en.length === 0) fail(`beads[${i}] is empty on both sides`)
    const confidence = num(o.confidence, `beads[${i}].confidence`)
    if (confidence < 0 || confidence > 1) fail(`beads[${i}].confidence must be between 0 and 1`)
    return { de, en, confidence, manual: bool(o.manual ?? false, `beads[${i}].manual`) }
  })
}

/**
 * Parse and validate a bundle from its JSON text (or an already parsed value). Throws
 * {@link BundleError} with a message that names the first offending field.
 */
export function parseBundle(input: string | unknown): Bundle {
  let value: unknown = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input)
    } catch {
      fail('This file is not valid JSON.')
    }
  }
  const o = obj(value, 'The bundle')
  if (o.format !== BUNDLE_FORMAT) fail(`This is not an Interlinear bundle (format "${String(o.format ?? '')}").`)
  const version = int(o.version, 'version', 1)
  if (version > BUNDLE_VERSION) fail(`This bundle was made by a newer version of the app (bundle version ${version}, this app reads up to ${BUNDLE_VERSION}).`)
  const book = bookRecord(o.book)
  const paras = { de: paragraphs(obj(o.paragraphs, 'paragraphs').de, 'paragraphs.de'), en: paragraphs(obj(o.paragraphs, 'paragraphs').en, 'paragraphs.en') }
  if (paras.de.length === 0 || paras.en.length === 0) fail('The bundle holds no text for one of the languages.')
  const sentsIn = obj(o.sentences ?? {}, 'sentences')
  const sents = { de: sentences(sentsIn.de ?? [], 'sentences.de', paras.de), en: sentences(sentsIn.en ?? [], 'sentences.en', paras.en) }
  const bds = beads(o.beads ?? [], { de: sents.de.length, en: sents.en.length })
  if (book.alignment?.status === 'ready' && sents.de.length === 0 && sents.en.length === 0) fail('The bundle says the book is aligned but holds no sentences.')
  return { format: BUNDLE_FORMAT, version, exported: num(o.exported ?? 0, 'exported'), book, paragraphs: paras, sentences: sents, beads: bds }
}

// ---------------------------------------------------------------------------------------------
// Import

/** The text of a bundled sentence: its own text when given, else its slice of the paragraph. */
export function sentenceText(s: BundleSentence, paras: readonly BundleParagraph[]): string {
  return s.length === 4 ? s[3] : paras[s[0]].text.slice(s[1], s[2])
}

export interface ImportBundleOptions {
  /** Title and author to store instead of the bundle's (the sheet lets the user edit them). */
  title?: string
  author?: string
}

/**
 * Store a parsed bundle as a new book, with its paragraphs, sentences and beads, in one
 * transaction. The book keeps the bundle's id unless the library already has it. A bundle
 * whose book is not `ready` is stored as `pending`; the caller queues the alignment.
 */
export async function importBundle(bundle: Bundle, options: ImportBundleOptions = {}, db: InterlinearDB = sharedDb()): Promise<Book> {
  const title = (options.title ?? bundle.book.title).trim() || bundle.book.title
  const author = (options.author ?? bundle.book.author).trim() || bundle.book.author
  return db.transaction('rw', [db.books, db.paragraphs, db.sentences, db.beads], async () => {
    const id = (await db.books.get(bundle.book.id)) === undefined ? bundle.book.id : newId()
    const ready = bundle.book.alignment?.status === 'ready'
    const alignment: AlignmentState = ready
      ? { ...bundle.book.alignment!, updated: Date.now() }
      : { status: 'pending', updated: Date.now() }
    delete alignment.error
    const book: Book = { ...bundle.book, id, title, author, created: Date.now(), alignment }
    await db.books.add(book)
    for (const lang of LANGS) {
      const paraRows: ParagraphRow[] = bundle.paragraphs[lang].map((p) =>
        p.cls === undefined ? { bookId: id, lang, idx: p.idx, text: p.text } : { bookId: id, lang, idx: p.idx, text: p.text, cls: p.cls },
      )
      await db.paragraphs.bulkAdd(paraRows)
      if (!ready) continue
      const sentRows: SentenceRow[] = bundle.sentences[lang].map((s, idx) => ({
        bookId: id,
        lang,
        idx,
        paraIdx: s[0],
        text: sentenceText(s, bundle.paragraphs[lang]),
        charStart: s[1],
        charEnd: s[2],
      }))
      await db.sentences.bulkAdd(sentRows)
    }
    if (ready) {
      const beadRows: BeadRow[] = bundle.beads.map((b, beadIdx) => ({
        bookId: id,
        beadIdx,
        deSentenceIdx: b.de,
        enSentenceIdx: b.en,
        confidence: b.confidence,
        manual: b.manual,
      }))
      await db.beads.bulkAdd(beadRows)
    }
    return book
  })
}
