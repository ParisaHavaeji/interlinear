/**
 * Reader screen (plan.md step 16): the original text of the whole book as one scrolling page,
 * chapter after chapter under their headings (`reader/flow.ts`), rendered as
 * paragraphs → sentences → words. Every sentence the splitter found is a `<span class="sent">`
 * carrying its book-wide index, every word inside it a `<span class="w">`; punctuation and
 * whitespace stay as plain text between them, so the page shows exactly the imported text
 * (`reader/tokenize.ts`). Step 24 hangs the word tap on the word spans.
 *
 * The page is windowed (`reader/virtual.ts`): only the paragraphs within a screen of the
 * viewport are in the DOM, with spacers standing in for the rest. Heights are estimated from
 * paragraph length until a paragraph has been rendered once and measured; a measurement above
 * the viewport scrolls the window by the difference so the visible text does not move.
 *
 * Reached at `#/read/<bookId>[/<chapter>]`: the chapter is where the book opens, and the route
 * follows the chapter on screen as the page scrolls. The Books chrome of step 17
 * (`ReaderChrome.tsx`) frames the page: a top bar that slides away as the reader scrolls down, a
 * footer with the book's progress line and the chapter on screen, and the chapter list sheet
 * (`ChaptersSheet.tsx`), which scrolls to the chapter picked and also holds the
 * chapter-mapping corrections of plan §1.1b. A book that is not aligned yet still opens:
 * its paragraphs render without sentence spans, as one chapter, and the live query swaps the
 * real chapters and sentences in when the alignment lands.
 *
 * Tapping a sentence (step 19, §1.5) gives its bead Books' soft highlight and opens the bottom
 * card of step 18 (`ui/BottomCard.tsx`) in sentence mode (`SentenceCard.tsx`): the English side
 * of the bead, the chapter name, Previous / Next arrows that move the highlight through the
 * book without closing the card (also ← / → on a keyboard), Copy, and for an uncertain or
 * missing match the neighbouring English sentences. The page scrolls just enough to keep the
 * highlighted sentence between the top bar and the card; sentences of uncertain beads carry a
 * dotted underline. The model behind all this is `reader/card.ts`.
 *
 * A long-press on a sentence (or a right-click, or "Fix alignment" on the sentence card) opens
 * the card in repair mode (step 20, `RepairCard.tsx`): the bead can be shifted, merged, split or
 * reset by hand, each change saved at once through `align/repair.ts`, which pins the bead and
 * re-aligns the rest of its paragraph around it. The live query then redraws page and card.
 *
 * Tapping a word (step 24, §1.6) opens the same card in word mode (`WordCard.tsx`): the word is
 * highlighted on the page and looked up in the dictionary of steps 21–23 (`dict/shards.ts`,
 * with the sentence for separable verbs); the card shows the best headword with its article
 * coloured by gender, the alternatives, and the sentence with a link to its translation. A tap
 * on a sentence's punctuation, its whitespace or the small chevron after it opens the sentence
 * card instead. The model is `reader/word.ts`.
 *
 * Bookmark on either card (step 25, §1.7) saves what the card shows (`bookmarks/model.ts`: the
 * bead with both texts, or the word with its headword and sentence) to the `bookmarks` table
 * (`bookmarks/store.ts`) and removes it on a second tap; the book's bookmarks are loaded live,
 * so the pill reads "Bookmarked" for a bead or word that has one. Bookmarks are also marked in
 * the text (`bookmarks/marks.ts`): a word with a light blue tint, a sentence with a light grey
 * one, both colours a setting.
 *
 * The ribbon in the top bar opens the book's bookmarks (step 26, `app/Bookmarks.tsx`); a tap
 * there comes back as `#/read/<bookId>/<chapter>/<bookmarkId>`. The bookmark is found in the
 * text as it is now (`bookmarks/locate.ts`), the chapter corrected should a re-alignment have
 * moved it, the windowed page scrolled until the sentence is rendered and in view, and the card
 * opened on it (on the word, for a word bookmark). The route is then replaced with the plain
 * chapter, so the jump happens once.
 *
 * The aA button (step 28, §1.8) opens the appearance menu (`AppearanceMenu.tsx`): reading
 * font, text size, line spacing and theme, kept as one `settings` row (`reader/appearance.ts`)
 * and applied as custom properties on the Reader's root and a `data-theme` attribute on `<html>`
 * while the Reader is open. A change that reflows the page (font, size, spacing) keeps the
 * place being read: the windowed body notes which paragraph was at the top of the viewport, and
 * how far into it, before it rebuilds its height map, and scrolls back there afterwards.
 *
 * The place being read is saved (step 29, `reader/progress.ts`): the windowed body reports the
 * paragraph at the top of the viewport and how far into it the viewport starts, and the Reader
 * writes the book's `progress` row (chapter, paragraph, share, and the share of the whole book
 * read so far) half a second after the last scroll and at once when the page is hidden or left.
 * Opened without a chapter in the route (`#/read/<bookId>`, how the Library opens a book), or
 * at the chapter where it was left, the book scrolls back to that place through the same path
 * as a bookmark jump before anything is saved. The Library's "Reading Now" card reads that row.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { ChapterMeta } from '../align/pipeline.ts'
import type { Lang } from '../import/types.ts'
import { getParagraphs } from '../store/books.ts'
import { db, type Book, type BookmarkRow, type ParagraphRow, type ProgressRow } from '../store/db.ts'
import { applyRepair, BlockIndex, describeBead, type RepairOp } from '../align/repair.ts'
import { locateBookmark } from '../bookmarks/locate.ts'
import { bookmarkMarks, markStyle, NO_MARKS, sanitizeMarkColours, type BookmarkMarks } from '../bookmarks/marks.ts'
import { findSentenceBookmark, findWordBookmark, sentenceBookmark, wordBookmark } from '../bookmarks/model.ts'
import { addBookmark, listBookmarks, removeBookmark } from '../bookmarks/store.ts'
import { useDictState } from '../dict/installer.ts'
import type { LookupResult } from '../dict/lookup.ts'
import { dictionary } from '../dict/shards.ts'
import { useLiveQuery } from '../store/hooks.ts'
import { getProgress, saveProgress } from '../store/progress.ts'
import { APPEARANCE_KEY, ARTICLE_COLOURS_KEY, MARK_COLOURS_KEY, setSetting, useSetting } from '../store/settings.ts'
import { BottomCard } from '../ui/BottomCard.tsx'
import { syncThemeColor } from '../pwa/theme-color.ts'
import { type Appearance, appearanceStyle, metricsKey, sanitizeAppearance, themeAttribute } from './appearance.ts'
import { AppearanceMenu } from './AppearanceMenu.tsx'
import { BeadIndex, revealDelta, sentenceCard, stepSentence } from './card.ts'
import { ChaptersSheet } from './ChaptersSheet.tsx'
import { chapterAt, flowOf, flowPosition } from './flow.ts'
import { bookFraction, samePlace, type ReadingPlace } from './progress.ts'
import { ReaderBar, ReaderFooter, useChrome } from './ReaderChrome.tsx'
import { RepairCardBody, RepairCardHeader } from './RepairCard.tsx'
import { SentenceCardBody, SentenceCardHeader } from './SentenceCard.tsx'
import { runsOf, tokenize, type SentenceSpan } from './tokenize.ts'
import { estimateHeight, HeightMap, rangeFor, sameRange, type RenderRange, type TextMetrics } from './virtual.ts'
import { dictHint, lookupErrorMessage, sameWord, sanitizeArticleColours, wordCard, wordCopyText, type WordRef } from './word.ts'
import { WordCardBody, WordCardHeader } from './WordCard.tsx'
import './reader.css'

interface Props {
  bookId: string
  /** 0-based chapter position to open at, clamped to the book; null opens the book where it was last read (step 29). */
  chapter: number | null
  /** Id of a bookmark to open at (step 26); the chapter shown is the bookmark's when they differ. */
  at?: string
  onBack: () => void
  /** Another chapter is at the top of the screen: the route can follow. */
  onChapter: (chapter: number) => void
  /** Open the book's bookmarks, from the chapter on screen. */
  onBookmarks: (chapter: number) => void
  /** The bookmark `at` has been opened (or could not be found): the route can drop it, keeping `chapter`. */
  onArrive: (chapter: number) => void
}

/** A place the page is asked to scroll to once: `key` tells one from the next. */
interface Target {
  key: string
  chapter: number
  /** Position of the paragraph within the chapter. */
  para: number
  fraction: number
}

/** A bookmark's place as the page needs it (step 26): the chapter and the paragraph within it, the sentence and perhaps the word. */
interface Jump {
  /** The bookmark id, which tells one jump from the next. */
  key: string
  chapter: number
  /** Position of the sentence's paragraph within the chapter. */
  para: number
  sentence: number
  word?: { offset: number; token: string }
}

interface Loaded {
  book: Book
  /** The language shown: the original, `book.langs[0]`. */
  lang: Lang
  /** The translation's language, `book.langs[1]`. */
  otherLang: Lang
  paragraphs: ParagraphRow[]
  /** Sentence spans by `Paragraph.idx`, sorted by position. Empty until the book is aligned. */
  sentences: Map<number, SentenceSpan[]>
  /** Text of every sentence of the shown language by book-wide index. */
  text: Map<number, string>
  /** Text of every sentence of the translation by book-wide index. */
  otherText: Map<number, string>
  /** The paragraph (`Paragraph.idx`) each sentence of the shown language is in. */
  paraOf: Map<number, number>
  beads: BeadIndex
  /** The paragraph blocks the repair of step 20 works within. */
  blocks: BlockIndex
}

const EMPTY = new Set<number>()
const NO_BOOKMARKS: readonly BookmarkRow[] = []
/** A pointer held still on a sentence this long opens the repair card. */
const LONG_PRESS_MS = 500
/** A pointer that moves further than this before then is a scroll, not a press. */
const LONG_PRESS_SLOP = 10
/** The reading place is saved this long after the last scroll (step 29). */
const SAVE_DELAY_MS = 500

export function Reader({ bookId, chapter, at, onBack, onChapter, onBookmarks, onArrive }: Props) {
  const data = useLiveQuery<Loaded | null>(async () => {
    const book = await db().books.get(bookId)
    if (book === undefined) return null
    const [lang, otherLang] = book.langs
    const [paragraphs, rows, otherRows, beadRows] = await Promise.all([
      getParagraphs(bookId, lang),
      db().sentences.where('[bookId+lang]').equals([bookId, lang]).sortBy('idx'),
      db().sentences.where('[bookId+lang]').equals([bookId, otherLang]).toArray(),
      db().beads.where('bookId').equals(bookId).toArray(),
    ])
    const sentences = new Map<number, SentenceSpan[]>()
    const text = new Map<number, string>()
    const paraOf = new Map<number, number>()
    for (const s of rows) {
      const span = { idx: s.idx, charStart: s.charStart, charEnd: s.charEnd }
      const list = sentences.get(s.paraIdx)
      if (list === undefined) sentences.set(s.paraIdx, [span])
      else list.push(span)
      text.set(s.idx, s.text)
      paraOf.set(s.idx, s.paraIdx)
    }
    const otherText = new Map(otherRows.map((s) => [s.idx, s.text]))
    return {
      book,
      lang,
      otherLang,
      paragraphs,
      sentences,
      text,
      otherText,
      paraOf,
      beads: new BeadIndex(beadRows),
      blocks: new BlockIndex(beadRows, rows, otherRows),
    }
  }, [bookId])

  /** The book's bookmarks (step 25), live, so the cards show which bead or word has one; undefined until loaded. */
  const bookmarkRows = useLiveQuery(() => listBookmarks(bookId), [bookId])
  const bookmarks = bookmarkRows ?? NO_BOOKMARKS
  /** Bookmarked sentences and words as they sit in the text now, tinted on the page. */
  const marks = useMemo(() => (data == null ? NO_MARKS : bookmarkMarks(bookmarks, data.text)), [bookmarks, data])
  const markColours = useSetting(MARK_COLOURS_KEY, sanitizeMarkColours)

  // Where the book was last read (step 29), read once when the Reader opens: the chapter to show
  // when the route names none, and the place within it to scroll back to. Undefined while
  // loading, null for a book never opened before.
  const [resume, setResume] = useState<ProgressRow | null | undefined>(undefined)
  /** The place has been scrolled back to (or there was none) for this opening. */
  const [restored, setRestored] = useState(false)
  const savedPlace = useRef<ReadingPlace | null>(null)
  useEffect(() => {
    let live = true
    setResume(undefined)
    setRestored(false)
    savedPlace.current = null
    getProgress(bookId).then(
      (row) => {
        if (live) setResume(row ?? null)
      },
      (err: unknown) => {
        console.error('could not read the reading progress', err)
        if (live) setResume(null)
      },
    )
    return () => {
      live = false
    }
  }, [bookId])

  const chapters = useMemo(() => (data == null ? null : chaptersFor(data)), [data])
  /** The page: every chapter's paragraphs in reading order, and where each chapter starts among them. */
  const flow = useMemo(() => (data == null || chapters === null ? null : flowOf(data.paragraphs, chapters)), [data, chapters])
  /** Chapter headings by the position in the flow of the paragraph they stand above. */
  const headings = useMemo(() => {
    const map = new Map<number, string>()
    if (data != null && chapters !== null && flow !== null) chapters.forEach((_, i) => map.set(flow.starts[i], headingOf(chapters, i, data.book.title)))
    return map
  }, [data, chapters, flow])

  // The bookmark the route asks to open at (step 26), placed in the text as it is now. Null
  // while the book or the bookmarks are still loading, and once it is gone or cannot be found.
  const jump = useMemo<Jump | null>(() => {
    if (at === undefined || data == null || chapters === null || bookmarkRows === undefined) return null
    const row = bookmarkRows.find((r) => r.id === at)
    if (row === undefined) return null
    const place = locateBookmark(row, data.text)
    if (place === null) return null
    const paraIdx = data.paraOf.get(place.sentence)
    const pos = paraIdx === undefined ? -1 : data.paragraphs.findIndex((p) => p.idx === paraIdx)
    const chapterIdx = pos < 0 ? -1 : chapters.findIndex((c) => pos >= c.paraStart && pos < c.paraStart + c.paraCount)
    if (chapterIdx < 0) return null
    return { key: at, chapter: chapterIdx, para: pos - chapters[chapterIdx].paraStart, sentence: place.sentence, ...(place.word === undefined ? {} : { word: place.word }) }
  }, [at, data, chapters, bookmarkRows])

  // A bookmark that is not there to jump to leaves the route pointing at the chapter alone.
  useEffect(() => {
    if (at !== undefined && jump === null && data != null && bookmarkRows !== undefined) onArrive(Math.min(Math.max(0, chapter ?? 0), (chapters?.length ?? 1) - 1))
  }, [at, jump, data, bookmarkRows])

  /** The chapter at the top of the screen, as the body last reported it; null until it has. */
  const [visible, setVisible] = useState<number | null>(null)
  const idx = chapters === null ? 0 : Math.min(Math.max(0, visible ?? jump?.chapter ?? chapter ?? resume?.chapter ?? 0), chapters.length - 1)
  const current = chapters?.[idx]

  // Where the book opens, when not at a bookmark (step 29): the place it was last read, when the
  // route names no chapter or that very one; else the top of the chapter the route names. Once
  // per opening; null for the top of the book.
  const opening = useMemo<Target | null>(() => {
    if (restored || at !== undefined || resume === undefined || chapters === null) return null
    if (resume !== null && (chapter === null || chapter === resume.chapter)) return { key: `resume/${bookId}`, chapter: resume.chapter, para: resume.para, fraction: resume.fraction }
    if (chapter !== null && chapter > 0) return { key: `open/${bookId}`, chapter, para: 0, fraction: 0 }
    return null
  }, [restored, at, resume, chapters, chapter, bookId])

  // A book that opens at its top has nowhere to scroll to: it is in place at once.
  useEffect(() => {
    if (!restored && at === undefined && resume !== undefined && chapters !== null && opening === null) setRestored(true)
  }, [restored, at, resume, chapters, opening])

  /** A chapter picked from the contents (or named by the route) after the book opened: scroll to its top. */
  const [go, setGo] = useState<Target | null>(null)
  const goCount = useRef(0)
  const goToChapter = (n: number) => {
    setActive(null)
    setGo({ key: `go/${++goCount.current}`, chapter: n, para: 0, fraction: 0 })
  }
  useEffect(() => {
    setGo(null)
    setVisible(null)
  }, [bookId])

  // The route follows the chapter on screen (see `onChapter`), without this component hearing
  // of it. A route that names another chapter than the one on screen was changed from outside
  // (the address bar, the history): go there.
  useEffect(() => {
    if (restored && at === undefined && chapter !== null && chapters !== null && chapter !== idx && chapter < chapters.length) goToChapter(chapter)
  }, [chapter])
  useEffect(() => {
    if (restored && at === undefined && visible !== null) onChapter(visible)
  }, [visible, restored])

  // A book starts at its top. Before paint, so the old scroll position never shows. A book
  // opened at a bookmark, at a chapter or where it was last read is scrolled by the body.
  useLayoutEffect(() => {
    if (jump === null && opening === null) window.scrollTo(0, 0)
  }, [bookId])

  const pageRef = useRef<HTMLDivElement>(null)
  const chrome = useChrome(`${bookId}/${data != null}`, pageRef)
  const [contents, setContents] = useState(false)
  /** The tapped sentence, by book-wide index; null while the card is closed. */
  const [active, setActive] = useState<number | null>(null)
  const [cardHeight, setCardHeight] = useState(0)
  /** The card is in repair mode (step 20) for the active sentence. */
  const [repairing, setRepairing] = useState(false)
  const [repairBusy, setRepairBusy] = useState(false)
  const [repairError, setRepairError] = useState<string | null>(null)
  /** The tapped word (step 24), in the active sentence; null while the card is not in word mode. */
  const [word, setWord] = useState<WordRef | null>(null)
  /** The lookup for `word`: its result once it arrived, or why it failed. */
  const [lookup, setLookup] = useState<{ word: WordRef; result: LookupResult | null; error: string | null } | null>(null)
  /** Which of the result's headwords the card shows in full. */
  const [pick, setPick] = useState(0)
  const dictState = useDictState()
  const colours = useSetting(ARTICLE_COLOURS_KEY, sanitizeArticleColours)

  // Appearance (step 28): the menu's choices, as inline custom properties on the root and the
  // theme on <html> for as long as the Reader is open; the other screens follow the system.
  // A change shows at once from local state, ahead of the live query: two quick taps on the
  // size stepper must step twice, not read the same stored size both times.
  const storedAppearance = useSetting(APPEARANCE_KEY, sanitizeAppearance)
  const [localAppearance, setLocalAppearance] = useState<Appearance | null>(null)
  const appearance = localAppearance ?? storedAppearance
  const changeAppearance = (next: Appearance) => {
    setLocalAppearance(next)
    void setSetting(APPEARANCE_KEY, next)
  }
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const pageStyle = `${appearanceStyle(appearance)}; ${markStyle(markColours)}`
  useEffect(() => {
    const root = document.documentElement
    const theme = themeAttribute(appearance.theme)
    if (theme === null) delete root.dataset.theme
    else root.dataset.theme = theme
    syncThemeColor()
    return () => {
      delete root.dataset.theme
      syncThemeColor()
    }
  }, [appearance.theme])

  // Another book closes the card; so does a re-alignment that dropped the sentence. Not while a
  // jump is pending: its arrival may have opened the card in this very commit (the body's
  // effect runs before this one).
  useEffect(() => {
    if (jump !== null) return
    setActive(null)
    setRepairing(false)
    setWord(null)
  }, [bookId])

  // The page has scrolled to the bookmark (step 26): open the card on its sentence or word. Or
  // to the place the book opens at (step 29). Either way the book is in place: saving may begin.
  const arrive = (found: boolean) => {
    if (jump !== null) {
      if (found) {
        setActive(jump.sentence)
        setRepairing(false)
        setWord(jump.word === undefined ? null : { sentence: jump.sentence, offset: jump.word.offset, token: jump.word.token })
      }
      setVisible(jump.chapter)
      setRestored(true)
      onArrive(jump.chapter)
    } else if (opening !== null) setRestored(true)
  }

  // Saving the place (step 29): the body reports the paragraph at the top of the viewport after
  // every scroll and render; the row is written SAVE_DELAY_MS after the last change, and at once
  // when the page is hidden or the Reader leaves. Nothing is saved while the book is still
  // scrolling to where it opens, since the page is not where the reader is yet. The place is
  // kept as the chapter and the paragraph within it, whatever the page's own list looks like.
  const lengths = useMemo(() => data?.paragraphs.map((p) => p.text.length) ?? [], [data])
  const pendingRow = useRef<ProgressRow | null>(null)
  const saveTimer = useRef(0)
  const flushProgress = () => {
    if (saveTimer.current !== 0) {
      clearTimeout(saveTimer.current)
      saveTimer.current = 0
    }
    const row = pendingRow.current
    if (row === null) return
    pendingRow.current = null
    saveProgress({ ...row, updated: Date.now() }).catch((err: unknown) => console.error('could not save the reading progress', err))
  }
  const onPosition = (pos: ViewportPlace) => {
    if (data == null || chapters === null || flow === null || jump !== null || opening !== null || !restored) return
    const at = chapterAt(flow.starts, pos.para)
    setVisible(at)
    const place: ReadingPlace = { chapter: at, para: pos.para - flow.starts[at], fraction: pos.fraction }
    if (samePlace(place, savedPlace.current)) return
    savedPlace.current = place
    // With the book's end on screen the whole book counts as read.
    const last = chapters.length - 1
    const read = bookFraction(chapters, lengths, pos.end ? { chapter: last, para: chapters[last].paraCount, fraction: 0 } : place)
    pendingRow.current = { bookId, chapter: place.chapter, para: place.para, fraction: place.fraction, read, updated: 0 }
    if (saveTimer.current !== 0) clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(flushProgress, SAVE_DELAY_MS)
  }
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flushProgress()
    }
    window.addEventListener('pagehide', flushProgress)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('pagehide', flushProgress)
      document.removeEventListener('visibilitychange', onHidden)
      flushProgress()
    }
  }, [])
  useEffect(() => {
    if (active !== null && data != null && !data.text.has(active)) setActive(null)
  }, [data, active])
  useEffect(() => {
    if (active === null) {
      setRepairing(false)
      setWord(null)
    }
  }, [active])

  // Look the tapped word up, with its sentence for separable verbs. A later tap cancels the
  // result of an earlier one; the card shows "Looking up…" in between.
  useEffect(() => {
    setPick(0)
    if (word === null) {
      setLookup(null)
      return
    }
    let cancelled = false
    setLookup({ word, result: null, error: null })
    const sentence = data?.text.get(word.sentence)
    dictionary()
      .lookup(word.token, { sentence, offset: word.offset })
      .then(
        (result) => {
          if (!cancelled) setLookup({ word, result, error: null })
        },
        (err: unknown) => {
          console.error('lookup failed', err)
          if (!cancelled) setLookup({ word, result: null, error: lookupErrorMessage(err, navigator.onLine !== false) })
        },
      )
    return () => {
      cancelled = true
    }
  }, [word])

  const openRepair = (idx: number) => {
    setActive(idx)
    setRepairing(true)
    setWord(null)
    setRepairError(null)
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(10)
  }

  // Long press: a primary pointer held still on a sentence for LONG_PRESS_MS. The click that
  // follows the release is swallowed so it does not re-select the sentence.
  const press = useRef<{ id: number; x: number; y: number; timer: number } | null>(null)
  const skipClick = useRef(false)
  const endPress = () => {
    if (press.current === null) return
    clearTimeout(press.current.timer)
    press.current = null
  }
  const onPointerDown = (e: PointerEvent) => {
    if (!e.isPrimary || e.button !== 0) return
    const sent = (e.target as Element | null)?.closest<HTMLElement>('.sent')
    if (sent === undefined || sent === null) return
    endPress()
    const idx = Number(sent.dataset.sentence)
    const timer = window.setTimeout(() => {
      press.current = null
      skipClick.current = true
      openRepair(idx)
    }, LONG_PRESS_MS)
    press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, timer }
  }
  const onPointerMove = (e: PointerEvent) => {
    const p = press.current
    if (p !== null && e.pointerId === p.id && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP) endPress()
  }
  useEffect(() => {
    window.addEventListener('scroll', endPress, { passive: true })
    return () => {
      window.removeEventListener('scroll', endPress)
      endPress()
    }
  }, [])

  const onPageClick = (e: MouseEvent) => {
    if (skipClick.current) {
      skipClick.current = false
      return
    }
    const target = e.target as Element | null
    const sent = target?.closest<HTMLElement>('.sent')
    if (sent === undefined || sent === null) return
    const idx = Number(sent.dataset.sentence)
    setActive(idx)
    setRepairing(false)
    // A word opens the word card; punctuation, whitespace or the chevron after the sentence
    // open the sentence card (§1.6).
    const w = target?.closest<HTMLElement>('.w')
    if (w === undefined || w === null || !sent.contains(w)) {
      setWord(null)
      return
    }
    const next: WordRef = { sentence: idx, offset: Number(w.dataset.o), token: w.textContent ?? '' }
    setWord((prev) => (sameWord(prev, next) ? prev : next))
  }

  // A right-click (and, on Android, the long-press the browser would turn into a context menu).
  const onContextMenu = (e: MouseEvent) => {
    const sent = (e.target as Element | null)?.closest<HTMLElement>('.sent')
    if (sent === undefined || sent === null) return
    e.preventDefault()
    endPress()
    openRepair(Number(sent.dataset.sentence))
  }

  const repairText = useMemo(
    () => (data == null ? null : { de: (i: number) => data.text.get(i), en: (i: number) => data.otherText.get(i) }),
    [data],
  )
  const repairBlock = repairing && data != null && active !== null ? data.blocks.blockOf(active) : null
  const repairDescription = repairBlock === null || active === null ? null : describeBead(repairBlock, active)

  const repair = async (op: RepairOp) => {
    if (data == null || active === null || repairText === null || repairBusy) return
    setRepairBusy(true)
    setRepairError(null)
    try {
      await applyRepair({ book: data.book, blocks: data.blocks, text: repairText }, active, op)
    } catch (err) {
      console.error('repair failed', err)
      setRepairError(err instanceof Error ? err.message : String(err))
    } finally {
      setRepairBusy(false)
    }
  }

  /** The sentence ids of the page, ascending: what Previous / Next step through. */
  const chapterSentences = useMemo(() => {
    if (data == null || flow === null) return []
    const ids: number[] = []
    for (const row of flow.rows) for (const s of data.sentences.get(row.idx) ?? []) ids.push(s.idx)
    return ids.sort((a, b) => a - b)
  }, [data, flow])

  /** Position in the flow of each paragraph, by `Paragraph.idx`: which chapter a sentence is in. */
  const flowOfPara = useMemo(() => new Map(flow?.rows.map((row, i) => [row.idx, i] as const) ?? []), [flow])

  const card = data == null || active === null ? null : sentenceCard(data.beads, active)
  // In word mode the word alone is highlighted, not its bead.
  const highlight = useMemo(() => (card === null || word !== null ? null : new Set(card.highlight)), [card, word])
  const uncertain = useMemo(() => data?.beads.uncertainSentences() ?? EMPTY, [data])
  const wordView = useMemo(() => (lookup?.result == null ? null : wordCard(lookup.result, pick)), [lookup, pick])

  // Keep the highlighted sentence (or word) between the top bar and the card, when the card
  // opens, grows or moves on. Smoothly, unless the reader asked for less motion.
  useEffect(() => {
    if (card === null || cardHeight === 0) return
    const targets =
      word !== null
        ? [...document.querySelectorAll('.w--active')]
        : card.highlight.map((idx) => document.querySelector(`.sent[data-sentence="${idx}"]`)).filter((el): el is Element => el !== null)
    let top = Infinity
    let bottom = -Infinity
    for (const el of targets) {
      const rect = el.getBoundingClientRect()
      top = Math.min(top, rect.top)
      bottom = Math.max(bottom, rect.bottom)
    }
    if (top === Infinity) return
    const bar = document.querySelector('.reader-bar')?.getBoundingClientRect()
    const barHeight = bar === undefined ? 0 : Math.max(0, bar.bottom)
    const delta = revealDelta(top, bottom, window.innerHeight, cardHeight, barHeight)
    if (delta === 0) return
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    window.scrollBy({ top: delta, behavior: reduce ? 'auto' : 'smooth' })
  }, [card, word, cardHeight])

  const step = (dir: -1 | 1) => {
    if (data == null || active === null) return
    const next = stepSentence(data.beads, chapterSentences, active, dir)
    if (next !== null) setActive(next)
  }
  const canStep = (dir: -1 | 1) => data != null && active !== null && stepSentence(data.beads, chapterSentences, active, dir) !== null

  // ← / → step through the book while the sentence card is open.
  useEffect(() => {
    if (active === null || word !== null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'ArrowRight') step(1)
      else return
      e.preventDefault()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [active, word, data, chapterSentences])

  const copy = async () => {
    if (data == null || card === null) return
    const original = card.highlight.map((i) => data.text.get(i) ?? '').join(' ')
    const translation = card.translation.map((i) => data.otherText.get(i) ?? '').join(' ')
    await navigator.clipboard.writeText(translation === '' ? original : `${original}\n${translation}`)
  }

  const copyWord = async () => {
    if (word === null) return
    await navigator.clipboard.writeText(wordView === null ? word.token : wordCopyText(wordView, word.token))
  }

  // Bookmarks (step 25): the row the open card is on, if any, and the toggles. The lookup must
  // have answered before a word can be bookmarked, so the headword it showed is recorded.
  const sentenceMark = card === null ? undefined : findSentenceBookmark(bookmarks, card.highlight)
  const wordMark = word === null ? undefined : findWordBookmark(bookmarks, word)
  const lookupDone = word !== null && lookup !== null && sameWord(lookup.word, word) && (lookup.result !== null || lookup.error !== null)
  const saveBookmark = async (existing: BookmarkRow | undefined, make: () => Parameters<typeof addBookmark>[1]) => {
    try {
      if (existing !== undefined) await removeBookmark(existing.id)
      else {
        await addBookmark(bookId, make())
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(10)
      }
    } catch (err) {
      console.error('bookmark failed', err)
    }
  }

  if (data === undefined || resume === undefined) {
    return (
      <div class="reader" style={pageStyle}>
        <ReaderBar title="" onBack={onBack} />
      </div>
    )
  }
  if (data === null || chapters === null || flow === null || current === undefined) {
    return (
      <div class="reader" style={pageStyle}>
        <ReaderBar title="" onBack={onBack} />
        <main class="reader-page">
          <p class="reader-note">This book is no longer in the library.</p>
        </main>
      </div>
    )
  }

  const ready = data.book.alignment?.status === 'ready'
  // The chapter the card's sentence is in (the one on screen while the card is closed): what
  // the card names and a bookmark records.
  const activePos = active === null ? undefined : flowOfPara.get(data.paraOf.get(active) ?? -1)
  const cardChapter = activePos === undefined ? idx : chapterAt(flow.starts, activePos)
  const heading = headingOf(chapters, cardChapter, data.book.title)
  const scrollTarget = jump !== null ? { ...jump, fraction: 0 } : (opening ?? go)

  return (
    <div class={chrome.hidden ? 'reader reader--chrome-hidden' : 'reader'} ref={pageRef} style={pageStyle}>
      <ReaderBar
        title={data.book.title}
        onBack={onBack}
        onContents={ready ? () => setContents(true) : undefined}
        onBookmarks={() => onBookmarks(idx)}
        onAppearance={() => setAppearanceOpen(true)}
        appearanceOpen={appearanceOpen}
      />
      <AppearanceMenu open={appearanceOpen} value={appearance} onChange={changeAppearance} onClose={() => setAppearanceOpen(false)} />
      <main
        class="reader-page"
        lang={data.lang}
        onClick={onPageClick}
        onContextMenu={onContextMenu}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPress}
        onPointerCancel={endPress}
      >
        {!ready && <p class="reader-note">This book is still being prepared. Sentences become tappable once it is aligned.</p>}
        <ChapterBody
          key={`${bookId}/${data.paragraphs.length}`}
          paragraphs={flow.rows}
          headings={headings}
          sentences={data.sentences}
          highlight={highlight}
          uncertain={uncertain}
          word={word}
          marks={marks}
          metrics={metricsKey(appearance)}
          target={
            scrollTarget === null
              ? null
              : {
                  key: scrollTarget.key,
                  para: flowPosition(flow.starts, scrollTarget.chapter, scrollTarget.para),
                  sentence: jump !== null ? jump.sentence : null,
                  fraction: scrollTarget.fraction,
                }
          }
          onArrive={arrive}
          onPosition={onPosition}
        />
      </main>
      <ReaderFooter position={chrome.position} chapter={`${idx + 1} of ${chapters.length}`} />
      {ready && (
        <ChaptersSheet open={contents} book={data.book} current={idx} onClose={() => setContents(false)} onChapter={goToChapter} />
      )}
      <BottomCard
        open={card !== null}
        onClose={() => setActive(null)}
        onOutsideTap={(target) => {
          // A tap on another sentence switches the card (onPageClick); anything else closes it.
          if (target === null || target.closest('.sent') === null) setActive(null)
        }}
        onHeightChange={setCardHeight}
        label={word !== null ? 'Word' : repairing ? 'Fix alignment' : 'Sentence'}
        header={
          word !== null ? (
            <WordCardHeader word={word} lang={data.lang} />
          ) : repairing ? (
            <RepairCardHeader onDone={() => setRepairing(false)} />
          ) : (
            <SentenceCardHeader heading={heading} onPrev={canStep(-1) ? () => step(-1) : undefined} onNext={canStep(1) ? () => step(1) : undefined} />
          )
        }
      >
        {card !== null && word !== null && (
          <WordCardBody
            word={word}
            view={lookup !== null && sameWord(lookup.word, word) ? wordView : null}
            error={lookup !== null && sameWord(lookup.word, word) ? lookup.error : null}
            dictHint={dictHint(dictState)}
            colours={colours}
            lang={data.lang}
            sentence={data.text.get(word.sentence)}
            onPick={setPick}
            onShowSentence={() => setWord(null)}
            onCopy={copyWord}
            bookmarked={wordMark !== undefined}
            onBookmark={
              lookupDone
                ? () =>
                    saveBookmark(wordMark, () => ({
                      type: 'word',
                      payload: wordBookmark(
                        word,
                        wordView,
                        data.text.get(word.sentence) ?? word.token,
                        sentenceCard(data.beads, word.sentence)
                          .translation.map((i) => data.otherText.get(i) ?? '')
                          .filter((t) => t !== '')
                          .join(' '),
                        { chapter: cardChapter, heading },
                      ),
                    }))
                : undefined
            }
          />
        )}
        {card !== null && word === null && repairing && repairText !== null && (
          <RepairCardBody
            description={repairDescription}
            langs={[data.lang, data.otherLang]}
            text={repairText}
            onRepair={repair}
            busy={repairBusy}
            error={repairError}
          />
        )}
        {card !== null && word === null && !repairing && (
          <SentenceCardBody
            card={card}
            lang={data.otherLang}
            text={(i) => data.otherText.get(i)}
            onCopy={copy}
            bookmarked={sentenceMark !== undefined}
            onBookmark={() =>
              saveBookmark(sentenceMark, () => ({
                type: 'sentence',
                payload: sentenceBookmark(card, (i) => data.text.get(i), (i) => data.otherText.get(i), { chapter: cardChapter, heading }),
              }))
            }
            onFix={card.status === 'unaligned' || active === null ? undefined : () => openRepair(active)}
          />
        )}
      </BottomCard>
    </div>
  )
}

/** What the page calls chapter `i`: its heading, "Chapter n" without one, the book's title for a book that is one chapter. */
function headingOf(chapters: readonly ChapterMeta[], i: number, title: string): string {
  return chapters[i]?.heading ?? (chapters.length === 1 ? title : `Chapter ${i + 1}`)
}

/**
 * The chapters of the page: the alignment's chapter list for the shown language, or, while
 * the book is not aligned (or has no detected chapters), the whole text as one chapter.
 */
export function chaptersFor(data: Pick<Loaded, 'book' | 'lang' | 'paragraphs'>): ChapterMeta[] {
  const chapters = data.book.alignment?.status === 'ready' ? data.book.alignment.chapters?.[data.lang] : undefined
  if (chapters !== undefined && chapters.length > 0) return chapters
  return [{ idx: 0, heading: null, sectionIdx: null, paraStart: 0, paraCount: data.paragraphs.length, words: 0 }]
}

// ---------------------------------------------------------------------------------------------
// Windowed body: the whole book

/** Paragraphs rendered before the first measurement, when the list's width is still unknown. */
const INITIAL_PARAGRAPHS = 12
/** Rendered beyond the viewport on each side, in viewport heights. */
const OVERSCAN_SCREENS = 1
/** Average advance of one character of serif body text, in em, spaces included. */
const AVERAGE_CHAR_EM = 0.48
/** Vertical space `.para` adds beyond its lines (see reader.css: paragraphs are indented, not spaced). */
const PARAGRAPH_SPACING = 0

function metricsOf(el: HTMLElement): TextMetrics {
  const style = getComputedStyle(el)
  const fontSize = parseFloat(style.fontSize) || 18
  let lineHeight = parseFloat(style.lineHeight)
  if (!Number.isFinite(lineHeight)) lineHeight = fontSize * 1.5
  // A unitless line-height may come back as the bare number rather than in px.
  else if (lineHeight < 4) lineHeight *= fontSize
  const width = el.clientWidth || 360
  return { charsPerLine: Math.max(10, Math.floor(width / (fontSize * AVERAGE_CHAR_EM))), lineHeight, spacing: PARAGRAPH_SPACING }
}

/** Lines of body text a chapter heading is estimated to take, margins included, before it is measured. */
const HEADING_LINES = 5

interface BodyProps {
  /** Every paragraph of the page, chapter after chapter. */
  paragraphs: ParagraphRow[]
  /** Chapter headings, by the position of the paragraph each stands above. */
  headings: ReadonlyMap<number, string>
  sentences: Map<number, SentenceSpan[]>
  /** Sentences of the bead on the card, or null while it is closed. */
  highlight: ReadonlySet<number> | null
  /** Sentences of uncertain beads (dotted underline). */
  uncertain: ReadonlySet<number>
  /** The word on the card (step 24), highlighted on the page; null in the other modes. */
  word: WordRef | null
  /** Bookmarked sentences and words, tinted on the page. */
  marks: BookmarkMarks
  /** Names the font, size and spacing in force (step 28); a change means every height is stale. */
  metrics: string
  /**
   * A place to scroll to once: a bookmark's sentence (step 26), placed under the top bar, in
   * the paragraph at `para` (its position on the page); or, with no sentence, the place the
   * book was last read (step 29) or the top of a chapter, the viewport's top edge `fraction` of
   * the way into that paragraph (its chapter heading included, when it has one). `key` tells
   * one target from the next.
   */
  target: { key: string; para: number; sentence: number | null; fraction: number } | null
  /** The target is reached (`found`), or it is not there to reach. */
  onArrive: (found: boolean) => void
  /** Where the viewport is, after every scroll and render (step 29). */
  onPosition: (place: ViewportPlace) => void
}

/** The paragraph at the top of the viewport (by position on the page), how far into it the viewport starts, and whether the book's end is on screen. */
export interface ViewportPlace {
  para: number
  fraction: number
  end: boolean
}

/** Share of the viewport, under the top bar, left above a sentence jumped to. */
const JUMP_INSET = 0.15
/** A jump that has not found its sentence after this many renders gives up. */
const JUMP_ATTEMPTS = 6

function ChapterBody({ paragraphs, headings, sentences, highlight, uncertain, word, marks, metrics, target, onArrive, onPosition }: BodyProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<HeightMap | null>(null)
  const widthRef = useRef(-1)
  const metricsRef = useRef('')
  const frameRef = useRef(0)
  const [range, setRange] = useState<RenderRange>({ start: 0, end: Math.min(paragraphs.length, INITIAL_PARAGRAPHS), top: 0, bottom: 0 })
  const [, setTick] = useState(0)
  /** The jump handled last, and how many renders the current one has taken. */
  const jumpRef = useRef<{ key: string; attempts: number } | null>(null)
  const arriveRef = useRef(onArrive)
  arriveRef.current = onArrive
  const positionRef = useRef(onPosition)
  positionRef.current = onPosition

  /** Recompute the window from the current scroll position, and report where the viewport is. */
  const update = () => {
    const list = listRef.current
    const map = mapRef.current
    if (list === null || map === null) return
    const viewport = window.innerHeight
    const rect = list.getBoundingClientRect()
    const y = -rect.top
    const next = rangeFor(map, y, viewport, viewport * OVERSCAN_SCREENS)
    setRange((prev) => (sameRange(prev, next) ? prev : next))
    if (map.length > 0) {
      // Above the list counts as the top of the book. A pixel in, so a chapter scrolled to
      // exactly is the one at the top however the scroll position was rounded.
      const para = y < 0 ? 0 : map.indexAt(y + 1)
      const height = map.heightOf(para)
      const fraction = y < 0 || height <= 0 ? 0 : Math.min(1, Math.max(0, (y - map.offsetOf(para)) / height))
      positionRef.current({ para, fraction, end: rect.bottom <= viewport + 1 })
    }
  }

  // After every render: (re)build the height map if the width or the type changed, measure
  // what is on screen, keep the visible text still, and settle the window.
  useLayoutEffect(() => {
    const list = listRef.current
    if (list === null) return
    const width = list.clientWidth
    const old = mapRef.current
    const rebuild = old === null || width !== widthRef.current || metrics !== metricsRef.current || old.length !== paragraphs.length
    /** The place being read before a rebuild: the paragraph at the viewport's top and how far into it. */
    let anchor: { index: number; fraction: number } | null = null
    if (rebuild) {
      if (old !== null && old.length === paragraphs.length) {
        const y = -list.getBoundingClientRect().top
        if (y >= 0 && y < old.total()) {
          const index = old.indexAt(y)
          const height = old.heightOf(index)
          anchor = { index, fraction: height > 0 ? (y - old.offsetOf(index)) / height : 0 }
        }
      }
      widthRef.current = width
      metricsRef.current = metrics
      const m = metricsOf(list)
      const estimates = paragraphs.map((p, i) => estimateHeight(p.text.length, m) + (headings.has(i) ? HEADING_LINES * m.lineHeight : 0))
      if (old === null) mapRef.current = new HeightMap(estimates)
      else old.reset(estimates)
    }
    const map = mapRef.current!
    let shift = 0
    for (const el of list.querySelectorAll<HTMLElement>('[data-item]')) {
      const rect = el.getBoundingClientRect()
      const delta = map.set(Number(el.dataset.item), rect.height)
      // A paragraph above the viewport that turned out taller or shorter than estimated moved
      // everything below it by `delta`; scroll along so the visible text stays put.
      if (anchor === null && delta !== 0 && rect.top < 0) shift += delta
    }
    if (anchor !== null) {
      // The whole page reflowed (a font change, a rotation): give the top spacer the height
      // the new map says now, so the rendered paragraphs sit where the map puts them, and
      // scroll back to the anchor at the same depth into its paragraph.
      if (topRef.current !== null) topRef.current.style.height = `${map.offsetOf(range.start)}px`
      const target = map.offsetOf(anchor.index) + anchor.fraction * map.heightOf(anchor.index)
      shift = Math.round(target + list.getBoundingClientRect().top)
    }
    if (shift !== 0) window.scrollBy(0, shift)
    update()
  })

  // Scroll to the target: the sentence of a bookmark jump (step 26) or the place the book was
  // last read (step 29). After the layout effects, so the Reader's scroll-to-top on a chapter
  // change has already run. The paragraph may not be in the window yet: then the page is
  // scrolled to where the height map puts it, which renders it, and the next render finds the
  // sentence and places it under the top bar, or finds the paragraph measured and puts the
  // viewport's top edge the stored way into it.
  useEffect(() => {
    const list = listRef.current
    const map = mapRef.current
    if (target === null || list === null || map === null) return
    const state = jumpRef.current?.key === target.key ? jumpRef.current : { key: target.key, attempts: 0 }
    if (state.attempts < 0) return
    jumpRef.current = state
    const done = (found: boolean) => {
      state.attempts = -1
      arriveRef.current(found)
    }
    const listTop = () => list.getBoundingClientRect().top + window.scrollY
    const paraRendered = list.querySelector(`.para[data-idx="${target.para}"]`) !== null
    if (target.sentence !== null) {
      const sent = list.querySelector(`.sent[data-sentence="${target.sentence}"]`)
      if (sent !== null) {
        const rect = sent.getBoundingClientRect()
        const bar = document.querySelector('.reader-bar')?.getBoundingClientRect().bottom ?? 0
        window.scrollBy(0, Math.round(rect.top - Math.max(0, bar) - window.innerHeight * JUMP_INSET))
        done(true)
        return
      }
    } else if (target.para === 0 && target.fraction === 0) {
      // The top of the book, heading included.
      window.scrollTo(0, 0)
      done(true)
      return
    } else if (paraRendered) {
      window.scrollTo(0, Math.max(0, Math.round(listTop() + map.offsetOf(target.para) + target.fraction * map.heightOf(target.para))))
      done(true)
      return
    }
    if (target.para < 0 || target.para >= paragraphs.length || (target.sentence !== null && paraRendered) || state.attempts >= JUMP_ATTEMPTS) {
      done(false)
      return
    }
    state.attempts++
    const top = listTop() + map.offsetOf(target.para)
    const offset = target.sentence === null ? target.fraction * map.heightOf(target.para) : -window.innerHeight * JUMP_INSET
    window.scrollTo(0, Math.max(0, top + offset))
    update()
  })

  useLayoutEffect(() => {
    const onScroll = () => {
      if (frameRef.current !== 0) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = 0
        update()
      })
    }
    const onResize = () => {
      widthRef.current = -1
      setTick((t) => t + 1)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
      if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current)
    }
  }, [])

  const items = []
  for (let i = range.start; i < Math.min(range.end, paragraphs.length); i++) {
    const row = paragraphs[i]
    items.push(
      <Paragraph key={row.idx} pos={i} heading={headings.get(i)} row={row} sentences={sentences.get(row.idx)} highlight={highlight} uncertain={uncertain} word={word} marks={marks} />,
    )
  }
  return (
    <div class="chapter-body" ref={listRef}>
      <div class="chapter-spacer" ref={topRef} style={{ height: `${range.top}px` }} aria-hidden="true" />
      {items}
      <div class="chapter-spacer" style={{ height: `${range.bottom}px` }} aria-hidden="true" />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Paragraphs, sentences, words

interface ParagraphProps {
  /** Position on the page (what the height map is indexed by). */
  pos: number
  /** The chapter heading above the paragraph, for a chapter's first. */
  heading: string | undefined
  row: ParagraphRow
  sentences: readonly SentenceSpan[] | undefined
  highlight: ReadonlySet<number> | null
  uncertain: ReadonlySet<number>
  word: WordRef | null
  marks: BookmarkMarks
}

function Paragraph({ pos, heading, row, sentences, highlight, uncertain, word, marks }: ParagraphProps) {
  const runs = useMemo(() => runsOf(row.text, sentences ?? []), [row.text, sentences])
  const para = (
    <p class={heading !== undefined ? 'para para--first' : 'para'} data-idx={pos} data-item={heading === undefined ? pos : undefined} data-para={row.idx}>
      {runs.map((run) =>
        run.sentenceIdx === null ? (
          words(run.text, null, undefined)
        ) : (
          <span class={sentenceClass(run.sentenceIdx, highlight, uncertain, marks)} data-sentence={run.sentenceIdx}>
            {words(run.text, word !== null && word.sentence === run.sentenceIdx ? word.offset : null, marks.words.get(run.sentenceIdx))}
          </span>
        ),
      )}
    </p>
  )
  if (heading === undefined) return para
  // A chapter's heading and first paragraph are one item of the window, measured together.
  return (
    <div class={pos === 0 ? 'chapter-start chapter-start--book' : 'chapter-start'} data-item={pos}>
      <h2 class="chapter-heading">{heading}</h2>
      {para}
    </div>
  )
}

function sentenceClass(idx: number, highlight: ReadonlySet<number> | null, uncertain: ReadonlySet<number>, marks: BookmarkMarks): string {
  let cls = 'sent'
  if (marks.sentences.has(idx)) cls += ' sent--marked'
  if (highlight !== null && highlight.has(idx)) cls += ' sent--active'
  if (uncertain.has(idx)) cls += ' sent--uncertain'
  return cls
}

/**
 * The tokens of a run: a `<span class="w">` per word carrying its offset in the run (what a tap
 * reports, and what the lookup needs to find the word in its sentence), plain text otherwise.
 * The word at `activeOffset`, if any, is the one on the card; words at `marked` offsets are bookmarked.
 */
function words(text: string, activeOffset: number | null, marked: ReadonlySet<number> | undefined) {
  let pos = 0
  return tokenize(text).map((t) => {
    const start = pos
    pos += t.text.length
    if (!t.word) return t.text
    return (
      <span class={start === activeOffset ? 'w w--active' : marked?.has(start) === true ? 'w w--marked' : 'w'} data-o={start}>
        {t.text}
      </span>
    )
  })
}
