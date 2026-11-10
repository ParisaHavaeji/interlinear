/** Shared types for the import layer (txt + epub → paragraphs). */

export type Lang = 'de' | 'en'

/** One block of prose as displayed: no internal line breaks, whitespace collapsed. */
export interface Paragraph {
  /** 0-based position within the imported text (or within its section). */
  idx: number
  text: string
  /**
   * The `class` attribute of the block element this paragraph came from (EPUB only).
   * Publisher EPUBs carry hints here ("x03-Chapter-Title", "x01-FM-Copyright-Text")
   * that the section heuristics use; never shown to the reader.
   */
  cls?: string
}

/** Where a section sits in the book. Only `body` sections take part in alignment. */
export type SectionKind = 'front' | 'body' | 'back'

/** One spine item of an EPUB: usually a chapter, but also title pages, the copyright page, … */
export interface Section {
  /** 0-based position in the spine. */
  idx: number
  /** Path of the content document inside the EPUB container. */
  href: string
  /** Label from the navigation document (NCX or EPUB 3 nav), when it points at this item. */
  title: string | null
  /** Heading detected from the item's leading short paragraphs ("CHAPTER ONE: TWO WORLDS"). */
  heading: string | null
  kind: SectionKind
  /** False for spine items marked `linear="no"` (footnote pages, pop-ups). */
  linear: boolean
  /** Prose paragraphs, heading lines removed, in reading order. */
  paragraphs: Paragraph[]
  /** Whitespace-separated token count over `paragraphs`. */
  words: number
}

export interface EpubBook {
  title: string | null
  author: string | null
  /** BCP 47 tag as declared in the package metadata ("de", "en-US"), lowercased. */
  language: string | null
  sections: Section[]
}
