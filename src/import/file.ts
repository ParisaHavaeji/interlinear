/**
 * Import one file for one language: picks the txt or EPUB importer by extension and flattens
 * the result into the shape the store persists (one paragraph list, section ranges on the side).
 */

import type { SectionMeta } from '../store/db.ts'
import { countWords } from './sections.ts'
import { EpubError, parseEpub } from './epub.ts'
import { parseTxtFile } from './txt.ts'
import type { Paragraph } from './types.ts'

export type Format = 'txt' | 'epub'

export interface ImportMeta {
  title: string | null
  author: string | null
  language: string | null
}

export interface ImportedText {
  fileName: string
  format: Format
  paragraphs: Paragraph[]
  sections: SectionMeta[]
  words: number
  /** Package metadata for EPUBs, null for plain text. */
  meta: ImportMeta | null
}

export class ImportError extends Error {
  override name = 'ImportError'
}

/** Decide the importer from the file name; null when neither .txt nor .epub. */
export function formatOf(fileName: string): Format | null {
  const m = /\.([a-z0-9]+)$/i.exec(fileName)
  const ext = m?.[1].toLowerCase()
  if (ext === 'txt' || ext === 'text') return 'txt'
  if (ext === 'epub') return 'epub'
  return null
}

/** Parse a File from an `<input type="file">`. Throws {@link ImportError} with a readable message. */
export async function importFile(file: File): Promise<ImportedText> {
  const format = formatOf(file.name)
  if (format === null) throw new ImportError(`"${file.name}" is not a .txt or .epub file`)

  if (format === 'txt') {
    const paragraphs = await parseTxtFile(file)
    if (paragraphs.length === 0) throw new ImportError(`"${file.name}" contains no text`)
    return { fileName: file.name, format, paragraphs, sections: [], words: countWords(paragraphs), meta: null }
  }

  let book
  try {
    book = await parseEpub(file)
  } catch (e) {
    if (e instanceof EpubError) throw new ImportError(`"${file.name}": ${e.message}`)
    throw e
  }

  const paragraphs: Paragraph[] = []
  const sections: SectionMeta[] = []
  for (const s of book.sections) {
    const paraStart = paragraphs.length
    for (const p of s.paragraphs) paragraphs.push({ ...p, idx: paragraphs.length })
    sections.push({
      idx: s.idx,
      href: s.href,
      title: s.title,
      heading: s.heading,
      kind: s.kind,
      linear: s.linear,
      words: s.words,
      paraStart,
      paraCount: s.paragraphs.length,
    })
  }
  if (paragraphs.length === 0) throw new ImportError(`"${file.name}" contains no text`)

  return {
    fileName: file.name,
    format,
    paragraphs,
    sections,
    words: countWords(paragraphs),
    meta: { title: book.title, author: book.author, language: book.language },
  }
}
