/**
 * Finding a bookmark's place in the book as it is now (plan.md step 26): the sentence to scroll
 * to and open the card on, and for a word bookmark the word within it. A bookmark records the
 * sentence indices it was made with and the texts as they read (`bookmarks/model.ts`); a
 * re-alignment with changed chapter edits can renumber the sentences, so the indices are
 * trusted only while the text at them is still the bookmarked text, and otherwise the text is
 * searched for, nearest to where it was. DOM-free so it can be tested.
 */

import { tokenize } from '../reader/tokenize.ts'
import type { BookmarkRow } from '../store/db.ts'

export interface BookmarkLocation {
  /** Book-wide index of the sentence to open. */
  sentence: number
  /** For a word bookmark whose word is still in that sentence: the word to open the card on. */
  word?: { offset: number; token: string }
}

/**
 * Where a bookmark is in `text` (the shown language's sentences by index), or null when the
 * sentence can no longer be found. A sentence bookmark opens on the first sentence of its bead;
 * a word bookmark on its word, or on the sentence alone when the word is not at its offset nor
 * anywhere else in the sentence.
 */
export function locateBookmark(row: BookmarkRow, text: ReadonlyMap<number, string>): BookmarkLocation | null {
  if (row.type === 'sentence') {
    const first = row.payload.sentences[0]
    const idx = findSentence(text, first, (t) => startsBead(row.payload.text, t))
    return idx === null ? null : { sentence: idx }
  }
  const { word, sentenceText } = row.payload
  const idx = findSentence(text, word.sentence, (t) => t === sentenceText)
  if (idx === null) return null
  const offset = findWord(text.get(idx) ?? '', word.offset, word.token)
  return offset === null ? { sentence: idx } : { sentence: idx, word: { offset, token: word.token } }
}

/** Whether `t` is the first sentence of the bead text `joined` (sentences joined with a space). */
function startsBead(joined: string, t: string): boolean {
  return t !== '' && (joined === t || joined.startsWith(t + ' '))
}

/**
 * The index whose text passes `matches`: the recorded one when it still does, else the matching
 * sentence nearest to it, else null. A bookmark whose text was empty when it was made (a sentence
 * row that was already gone) cannot be searched for and only its index counts.
 */
function findSentence(text: ReadonlyMap<number, string>, recorded: number | undefined, matches: (t: string) => boolean): number | null {
  if (recorded !== undefined) {
    const t = text.get(recorded)
    if (t !== undefined && matches(t)) return recorded
  }
  let best: number | null = null
  for (const [idx, t] of text) {
    if (!matches(t)) continue
    if (best === null || (recorded !== undefined && Math.abs(idx - recorded) < Math.abs(best - recorded))) best = idx
  }
  return best
}

/** The offset of `token` in `sentence`: at `offset` when it is still there, else its first occurrence as a word, else null. */
function findWord(sentence: string, offset: number, token: string): number | null {
  let pos = 0
  let first: number | null = null
  for (const t of tokenize(sentence)) {
    const start = pos
    pos += t.text.length
    if (!t.word || t.text !== token) continue
    if (start === offset) return start
    if (first === null) first = start
  }
  return first
}
