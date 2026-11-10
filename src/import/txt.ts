import { collapseWhitespace as collapse } from './markup.ts'
import type { Paragraph } from './types.ts'

const BOM = '\uFEFF'

/**
 * Decode raw file bytes to a string. Honours a UTF-8 / UTF-16 byte-order mark and
 * otherwise assumes UTF-8. TextDecoder consumes the BOM; {@link normaliseText} also
 * strips one, for text that arrives as a string.
 */
export function decodeTxt(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let encoding = 'utf-8'
  if (u8.length >= 2) {
    if (u8[0] === 0xff && u8[1] === 0xfe) encoding = 'utf-16le'
    else if (u8[0] === 0xfe && u8[1] === 0xff) encoding = 'utf-16be'
  }
  return new TextDecoder(encoding).decode(u8)
}

/** Strip a leading BOM and normalise CRLF / CR line endings to LF. */
export function normaliseText(text: string): string {
  if (text.startsWith(BOM)) text = text.slice(BOM.length)
  return text.replace(/\r\n?/g, '\n')
}

/**
 * How a plain-text file laid out its paragraphs: `blocks` separated by blank lines (the usual
 * case, hard-wrapped or not), or one paragraph per `lines` when the file had no blank lines
 * at all. Two `lines` files with the same line count are the pre-aligned input of plan \u00a71.2
 * (one sentence per line, line *i* translating line *i*) and skip the aligner.
 */
export type TxtLayout = 'blocks' | 'lines'

/**
 * Split plain text into paragraphs.
 *
 * Paragraphs are separated by one or more blank lines (a line is blank when it holds only
 * whitespace). Lines inside a paragraph are joined with a space, so hard-wrapped text
 * (Project Gutenberg wraps at ~72 columns) becomes one flowing block.
 *
 * Fallback: a file with no blank lines at all, where nearly every line ends in terminal
 * punctuation, is treated as "one paragraph per line", which is how many exported .txt
 * books are laid out. Hard-wrapped prose fails that test (most lines end mid-sentence)
 * and stays one paragraph.
 */
export function parseTxt(text: string): Paragraph[] {
  return parseTxtLayout(text).paragraphs
}

/** {@link parseTxt}, also reporting which {@link TxtLayout} the file turned out to have. */
export function parseTxtLayout(text: string): { paragraphs: Paragraph[]; layout: TxtLayout } {
  const normalised = normaliseText(text)
  let blocks = normalised.split(/\n[ \t\u00a0]*\n+/)
  let layout: TxtLayout = 'blocks'

  if (blocks.length === 1) {
    const lines = normalised.split('\n').filter((l) => collapse(l) !== '')
    if (lines.length > 1 && looksLikeOneParagraphPerLine(lines)) {
      blocks = lines
      layout = 'lines'
    }
  }

  const paragraphs: Paragraph[] = []
  for (const block of blocks) {
    const t = collapse(block)
    if (t === '') continue
    paragraphs.push({ idx: paragraphs.length, text: t })
  }
  return { paragraphs, layout }
}

const TERMINAL = /[.!?…:;"'»«“”„’)\]]$/

/** True when at least 80% of the lines end in sentence-final punctuation or a closing quote. */
function looksLikeOneParagraphPerLine(lines: string[]): boolean {
  const ended = lines.filter((l) => TERMINAL.test(l.trimEnd())).length
  return ended / lines.length >= 0.8
}

/** Convenience for a File / Blob from an `<input type="file">`. */
export async function parseTxtFile(file: Blob): Promise<Paragraph[]> {
  return parseTxt(decodeTxt(await file.arrayBuffer()))
}
