/**
 * Reader screen (plan.md step 16): one chapter of the original text at a time, rendered as
 * paragraphs → sentences → words. Every sentence the splitter found is a `<span class="sent">`
 * carrying its book-wide index, every word inside it a `<span class="w">`; punctuation and
 * whitespace stay as plain text between them, so the page shows exactly the imported text
 * (`reader/tokenize.ts`). Step 24 hangs the word tap on the word spans.
 *
 * Long chapters are windowed (`reader/virtual.ts`): only the paragraphs within a screen of the
 * viewport are in the DOM, with spacers standing in for the rest. Heights are estimated from
 * paragraph length until a paragraph has been rendered once and measured; a measurement above
 * the viewport scrolls the window by the difference so the visible text does not move.
 *
 * Reached at `#/read/<bookId>[/<chapter>]`. The Books chrome of step 17 (`ReaderChrome.tsx`)
 * frames the page: a top bar that slides away as the reader scrolls down, a footer with the
 * chapter's progress line, and the chapter list sheet (`ChaptersSheet.tsx`), which also holds
 * the chapter-mapping corrections of plan §1.1b. A book that is not aligned yet still opens:
 * its paragraphs render without sentence spans, as one chapter, and the live query swaps the
 * real chapters and sentences in when the alignment lands.
 *
 * Tapping a sentence (step 19, §1.5) gives its bead Books' soft highlight and opens the bottom
 * card of step 18 (`ui/BottomCard.tsx`) in sentence mode (`SentenceCard.tsx`): the English side
 * of the bead, the chapter name, Previous / Next arrows that move the highlight through the
 * chapter without closing the card (also ← / → on a keyboard), Copy, and for an uncertain or
 * missing match the neighbouring English sentences. The page scrolls just enough to keep the
 * highlighted sentence between the top bar and the card; sentences of uncertain beads carry a
 * dotted underline. The model behind all this is `reader/card.ts`.
 *
 * A long-press on a sentence (or a right-click, or "Fix alignment" on the sentence card) opens
 * the card in repair mode (step 20, `RepairCard.tsx`): the bead can be shifted, merged, split or
 * reset by hand, each change saved at once through `align/repair.ts`, which pins the bead and
 * re-aligns the rest of its paragraph around it. The live query then redraws page and card.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { ChapterMeta } from '../align/pipeline.ts'
import type { Lang } from '../import/types.ts'
import { getParagraphs } from '../store/books.ts'
import { db, type Book, type ParagraphRow } from '../store/db.ts'
import { applyRepair, BlockIndex, describeBead, type RepairOp } from '../align/repair.ts'
import { useLiveQuery } from '../store/hooks.ts'
import { BottomCard } from '../ui/BottomCard.tsx'
import { BeadIndex, revealDelta, sentenceCard, stepSentence } from './card.ts'
import { ChaptersSheet } from './ChaptersSheet.tsx'
import { ReaderBar, ReaderFooter, useChrome } from './ReaderChrome.tsx'
import { RepairCardBody, RepairCardHeader } from './RepairCard.tsx'
import { SentenceCardBody, SentenceCardHeader } from './SentenceCard.tsx'
import { runsOf, tokenize, type SentenceSpan } from './tokenize.ts'
import { estimateHeight, HeightMap, rangeFor, sameRange, type RenderRange, type TextMetrics } from './virtual.ts'
import './reader.css'

interface Props {
  bookId: string
  /** 0-based chapter position; clamped to the book. */
  chapter: number
  onBack: () => void
  onChapter: (chapter: number) => void
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
  beads: BeadIndex
  /** The paragraph blocks the repair of step 20 works within. */
  blocks: BlockIndex
}

const EMPTY = new Set<number>()
/** A pointer held still on a sentence this long opens the repair card. */
const LONG_PRESS_MS = 500
/** A pointer that moves further than this before then is a scroll, not a press. */
const LONG_PRESS_SLOP = 10

export function Reader({ bookId, chapter, onBack, onChapter }: Props) {
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
    for (const s of rows) {
      const span = { idx: s.idx, charStart: s.charStart, charEnd: s.charEnd }
      const list = sentences.get(s.paraIdx)
      if (list === undefined) sentences.set(s.paraIdx, [span])
      else list.push(span)
      text.set(s.idx, s.text)
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
      beads: new BeadIndex(beadRows),
      blocks: new BlockIndex(beadRows, rows, otherRows),
    }
  }, [bookId])

  // A new chapter starts at its top. Before paint, so the old scroll position never shows.
  useLayoutEffect(() => {
    window.scrollTo(0, 0)
  }, [bookId, chapter])

  const pageRef = useRef<HTMLDivElement>(null)
  const chrome = useChrome(`${bookId}/${chapter}`, pageRef)
  const [contents, setContents] = useState(false)
  /** The tapped sentence, by book-wide index; null while the card is closed. */
  const [active, setActive] = useState<number | null>(null)
  const [cardHeight, setCardHeight] = useState(0)
  /** The card is in repair mode (step 20) for the active sentence. */
  const [repairing, setRepairing] = useState(false)
  const [repairBusy, setRepairBusy] = useState(false)
  const [repairError, setRepairError] = useState<string | null>(null)

  // A chapter change closes the card; so does a re-alignment that dropped the sentence.
  useEffect(() => {
    setActive(null)
    setRepairing(false)
  }, [bookId, chapter])
  useEffect(() => {
    if (active !== null && data != null && !data.text.has(active)) setActive(null)
  }, [data, active])
  useEffect(() => {
    if (active === null) setRepairing(false)
  }, [active])

  const openRepair = (idx: number) => {
    setActive(idx)
    setRepairing(true)
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
    const sent = (e.target as Element | null)?.closest<HTMLElement>('.sent')
    if (sent === undefined || sent === null) return
    setActive(Number(sent.dataset.sentence))
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

  const chapters = data == null ? null : chaptersFor(data)
  const idx = chapters === null ? 0 : Math.min(Math.max(0, chapter), chapters.length - 1)
  const current = chapters?.[idx]

  /** The chapter's sentence ids, ascending: what Previous / Next step through. */
  const chapterSentences = useMemo(() => {
    if (data == null || current === undefined) return []
    const ids: number[] = []
    for (let i = current.paraStart; i < current.paraStart + current.paraCount; i++) {
      const row = data.paragraphs[i]
      if (row !== undefined) for (const s of data.sentences.get(row.idx) ?? []) ids.push(s.idx)
    }
    return ids.sort((a, b) => a - b)
  }, [data, current])

  const card = data == null || active === null ? null : sentenceCard(data.beads, active)
  const highlight = useMemo(() => (card === null ? null : new Set(card.highlight)), [card])
  const uncertain = useMemo(() => data?.beads.uncertainSentences() ?? EMPTY, [data])

  // Keep the highlighted sentence between the top bar and the card, when the card opens, grows
  // or moves on. Smoothly, unless the reader asked for less motion.
  useEffect(() => {
    if (card === null || cardHeight === 0) return
    let top = Infinity
    let bottom = -Infinity
    for (const idx of card.highlight) {
      const el = document.querySelector(`.sent[data-sentence="${idx}"]`)
      if (el === null) continue
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
  }, [card, cardHeight])

  const step = (dir: -1 | 1) => {
    if (data == null || active === null) return
    const next = stepSentence(data.beads, chapterSentences, active, dir)
    if (next !== null) setActive(next)
  }
  const canStep = (dir: -1 | 1) => data != null && active !== null && stepSentence(data.beads, chapterSentences, active, dir) !== null

  // ← / → step through the chapter while the card is open.
  useEffect(() => {
    if (active === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'ArrowRight') step(1)
      else return
      e.preventDefault()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [active, data, chapterSentences])

  const copy = async () => {
    if (data == null || card === null) return
    const original = card.highlight.map((i) => data.text.get(i) ?? '').join(' ')
    const translation = card.translation.map((i) => data.otherText.get(i) ?? '').join(' ')
    await navigator.clipboard.writeText(translation === '' ? original : `${original}\n${translation}`)
  }

  if (data === undefined) {
    return (
      <div class="reader">
        <ReaderBar title="" onBack={onBack} />
      </div>
    )
  }
  if (data === null || chapters === null || current === undefined) {
    return (
      <div class="reader">
        <ReaderBar title="" onBack={onBack} />
        <main class="reader-page">
          <p class="reader-note">This book is no longer in the library.</p>
        </main>
      </div>
    )
  }

  const paragraphs = data.paragraphs.slice(current.paraStart, current.paraStart + current.paraCount)
  const ready = data.book.alignment?.status === 'ready'
  const heading = current.heading ?? (chapters.length === 1 ? data.book.title : `Chapter ${idx + 1}`)

  return (
    <div class={chrome.hidden ? 'reader reader--chrome-hidden' : 'reader'} ref={pageRef}>
      <ReaderBar title={data.book.title} onBack={onBack} onContents={ready ? () => setContents(true) : undefined} />
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
        <h2 class="chapter-heading">{heading}</h2>
        {!ready && <p class="reader-note">This book is still being prepared. Sentences become tappable once it is aligned.</p>}
        <ChapterBody
          key={`${bookId}/${idx}/${data.paragraphs.length}`}
          paragraphs={paragraphs}
          sentences={data.sentences}
          highlight={highlight}
          uncertain={uncertain}
        />
        <nav class="chapter-nav" aria-label="Chapters">
          <button type="button" disabled={idx === 0} onClick={() => onChapter(idx - 1)}>
            ‹ Previous chapter
          </button>
          <button type="button" disabled={idx >= chapters.length - 1} onClick={() => onChapter(idx + 1)}>
            Next chapter ›
          </button>
        </nav>
      </main>
      <ReaderFooter position={chrome.position} chapter={`${idx + 1} of ${chapters.length}`} />
      {ready && (
        <ChaptersSheet open={contents} book={data.book} current={idx} onClose={() => setContents(false)} onChapter={onChapter} />
      )}
      <BottomCard
        open={card !== null}
        onClose={() => setActive(null)}
        onOutsideTap={(target) => {
          // A tap on another sentence switches the card (onPageClick); anything else closes it.
          if (target === null || target.closest('.sent') === null) setActive(null)
        }}
        onHeightChange={setCardHeight}
        label={repairing ? 'Fix alignment' : 'Sentence'}
        header={
          repairing ? (
            <RepairCardHeader onDone={() => setRepairing(false)} />
          ) : (
            <SentenceCardHeader heading={heading} onPrev={canStep(-1) ? () => step(-1) : undefined} onNext={canStep(1) ? () => step(1) : undefined} />
          )
        }
      >
        {card !== null && repairing && repairText !== null && (
          <RepairCardBody
            description={repairDescription}
            langs={[data.lang, data.otherLang]}
            text={repairText}
            onRepair={repair}
            busy={repairBusy}
            error={repairError}
          />
        )}
        {card !== null && !repairing && (
          <SentenceCardBody
            card={card}
            lang={data.otherLang}
            text={(i) => data.otherText.get(i)}
            onCopy={copy}
            onFix={card.status === 'unaligned' || active === null ? undefined : () => openRepair(active)}
          />
        )}
      </BottomCard>
    </div>
  )
}

/**
 * The chapters to page through: the alignment's chapter list for the shown language, or, while
 * the book is not aligned (or has no detected chapters), the whole text as one chapter.
 */
export function chaptersFor(data: Pick<Loaded, 'book' | 'lang' | 'paragraphs'>): ChapterMeta[] {
  const chapters = data.book.alignment?.status === 'ready' ? data.book.alignment.chapters?.[data.lang] : undefined
  if (chapters !== undefined && chapters.length > 0) return chapters
  return [{ idx: 0, heading: null, sectionIdx: null, paraStart: 0, paraCount: data.paragraphs.length, words: 0 }]
}

// ---------------------------------------------------------------------------------------------
// Windowed chapter body

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

interface BodyProps {
  paragraphs: ParagraphRow[]
  sentences: Map<number, SentenceSpan[]>
  /** Sentences of the bead on the card, or null while it is closed. */
  highlight: ReadonlySet<number> | null
  /** Sentences of uncertain beads (dotted underline). */
  uncertain: ReadonlySet<number>
}

function ChapterBody({ paragraphs, sentences, highlight, uncertain }: BodyProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<HeightMap | null>(null)
  const widthRef = useRef(-1)
  const frameRef = useRef(0)
  const [range, setRange] = useState<RenderRange>({ start: 0, end: Math.min(paragraphs.length, INITIAL_PARAGRAPHS), top: 0, bottom: 0 })
  const [, setTick] = useState(0)

  /** Recompute the window from the current scroll position. */
  const update = () => {
    const list = listRef.current
    const map = mapRef.current
    if (list === null || map === null) return
    const viewport = window.innerHeight
    const next = rangeFor(map, -list.getBoundingClientRect().top, viewport, viewport * OVERSCAN_SCREENS)
    setRange((prev) => (sameRange(prev, next) ? prev : next))
  }

  // After every render: (re)build the height map if the width changed, measure what is on
  // screen, keep the visible text still, and settle the window.
  useLayoutEffect(() => {
    const list = listRef.current
    if (list === null) return
    const width = list.clientWidth
    if (mapRef.current === null || width !== widthRef.current || mapRef.current.length !== paragraphs.length) {
      widthRef.current = width
      const metrics = metricsOf(list)
      const estimates = paragraphs.map((p) => estimateHeight(p.text.length, metrics))
      if (mapRef.current === null) mapRef.current = new HeightMap(estimates)
      else mapRef.current.reset(estimates)
    }
    const map = mapRef.current
    let shift = 0
    for (const el of list.querySelectorAll<HTMLElement>('.para')) {
      const rect = el.getBoundingClientRect()
      const delta = map.set(Number(el.dataset.idx), rect.height)
      // A paragraph above the viewport that turned out taller or shorter than estimated moved
      // everything below it by `delta`; scroll along so the visible text stays put.
      if (delta !== 0 && rect.top < 0) shift += delta
    }
    if (shift !== 0) window.scrollBy(0, shift)
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
    items.push(<Paragraph key={row.idx} pos={i} row={row} sentences={sentences.get(row.idx)} highlight={highlight} uncertain={uncertain} />)
  }
  return (
    <div class="chapter-body" ref={listRef}>
      <div class="chapter-spacer" style={{ height: `${range.top}px` }} aria-hidden="true" />
      {items}
      <div class="chapter-spacer" style={{ height: `${range.bottom}px` }} aria-hidden="true" />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Paragraphs, sentences, words

interface ParagraphProps {
  /** Position within the chapter (what the height map is indexed by). */
  pos: number
  row: ParagraphRow
  sentences: readonly SentenceSpan[] | undefined
  highlight: ReadonlySet<number> | null
  uncertain: ReadonlySet<number>
}

function Paragraph({ pos, row, sentences, highlight, uncertain }: ParagraphProps) {
  const runs = useMemo(() => runsOf(row.text, sentences ?? []), [row.text, sentences])
  return (
    <p class={pos === 0 ? 'para para--first' : 'para'} data-idx={pos} data-para={row.idx}>
      {runs.map((run) =>
        run.sentenceIdx === null ? (
          words(run.text)
        ) : (
          <span class={sentenceClass(run.sentenceIdx, highlight, uncertain)} data-sentence={run.sentenceIdx}>
            {words(run.text)}
          </span>
        ),
      )}
    </p>
  )
}

function sentenceClass(idx: number, highlight: ReadonlySet<number> | null, uncertain: ReadonlySet<number>): string {
  let cls = 'sent'
  if (highlight !== null && highlight.has(idx)) cls += ' sent--active'
  if (uncertain.has(idx)) cls += ' sent--uncertain'
  return cls
}

function words(text: string) {
  return tokenize(text).map((t) => (t.word ? <span class="w">{t.text}</span> : t.text))
}
