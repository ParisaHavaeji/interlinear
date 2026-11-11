/**
 * What a bookmark records (plan.md step 25, §1.7), kept apart from the DOM and the database so
 * it can be tested: a *sentence* bookmark is the bead the sentence card showed (its German
 * sentences, their English side, both texts as they read at the time, and where in the book),
 * a *word* bookmark is the word as tapped with the headword the card showed (lemma, articles,
 * part of speech, plural, glosses) and the sentence it appeared in with its translation.
 *
 * Texts are copied into the payload rather than looked up again: a bookmark is a note of what
 * the reader saw, it survives a re-alignment that moves the bead, and the export of step 27
 * needs nothing but the row. The indices stay so step 26 can jump back to the place.
 *
 * Which bookmark a card is "on" is decided here too: a sentence bookmark covers every German
 * sentence of its bead, so a tap on any of them finds it; a word bookmark is the word at one
 * offset of one sentence.
 */

import type { SentenceCard } from '../reader/card.ts'
import type { EntryView, WordCardView, WordRef } from '../reader/word.ts'
import type { BookmarkRow } from '../store/db.ts'

/** Where in the book a bookmark was made: the chapter's position and its heading as shown. */
export interface Place {
  chapter: number
  heading: string
}

export interface SentenceBookmark {
  /** The bead's German sentences, ascending: what the card highlighted. */
  sentences: number[]
  /** The bead's English sentences, ascending; empty for an unmatched or unaligned sentence. */
  translation: number[]
  /** The German text, sentences joined with a space. */
  text: string
  /** The English text likewise; "" when there was none. */
  translationText: string
  chapter: number
  heading: string
}

export interface WordBookmark {
  /** The word as tapped: its sentence, offset and spelling. */
  word: WordRef
  /** The headword the card showed in full; null when the dictionary had no entry. */
  lemma: string | null
  /** The headword's entries as the card drew them (articles, part of speech, plural, glosses). */
  entries: EntryView[]
  /** The sentence the word appeared in, and its translation ("" when there was none). */
  sentenceText: string
  translationText: string
  chapter: number
  heading: string
}

/** The typed half of a bookmark row: its kind and payload together. */
export type BookmarkEntry = { type: 'sentence'; payload: SentenceBookmark } | { type: 'word'; payload: WordBookmark }

/** The bookmark for what the sentence card shows. */
export function sentenceBookmark(
  card: SentenceCard,
  text: (idx: number) => string | undefined,
  translation: (idx: number) => string | undefined,
  place: Place,
): SentenceBookmark {
  return {
    sentences: [...card.highlight].sort((a, b) => a - b),
    translation: [...card.translation].sort((a, b) => a - b),
    text: joinTexts(card.highlight, text),
    translationText: joinTexts(card.translation, translation),
    chapter: place.chapter,
    heading: place.heading,
  }
}

/** The bookmark for what the word card shows; `view` is null when the dictionary had nothing. */
export function wordBookmark(word: WordRef, view: WordCardView | null, sentenceText: string, translationText: string, place: Place): WordBookmark {
  return {
    word: { sentence: word.sentence, offset: word.offset, token: word.token },
    lemma: view === null ? null : view.lemma,
    entries: view === null ? [] : view.entries,
    sentenceText,
    translationText,
    chapter: place.chapter,
    heading: place.heading,
  }
}

/** The sentence bookmark covering any of `sentences` (a bead's German side), if there is one. */
export function findSentenceBookmark(rows: readonly BookmarkRow[], sentences: readonly number[]): BookmarkRow | undefined {
  return rows.find((r) => r.type === 'sentence' && r.payload.sentences.some((s) => sentences.includes(s)))
}

/** The bookmark of this very word (same sentence and offset), if there is one. */
export function findWordBookmark(rows: readonly BookmarkRow[], word: WordRef): BookmarkRow | undefined {
  return rows.find((r) => r.type === 'word' && r.payload.word.sentence === word.sentence && r.payload.word.offset === word.offset)
}

function joinTexts(ids: readonly number[], text: (idx: number) => string | undefined): string {
  return [...ids]
    .sort((a, b) => a - b)
    .map(text)
    .filter((t): t is string => t !== undefined && t !== '')
    .join(' ')
}
