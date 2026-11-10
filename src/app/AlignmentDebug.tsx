/**
 * Alignment debug view (plan.md step 13), development builds only: the two editions of a book
 * side by side, one row per bead, the row's colour the bead's confidence (red for a coin flip,
 * green for sure), paragraph boundaries marked, one chapter pair at a time. A threshold slider
 * shows which beads the reader would underline as uncertain; "Copy gold draft" puts the first
 * N beads on the clipboard in the gold-file format so a hand-check can start from them.
 *
 * Reached from the Library's shelf (a "Debug" link under aligned books in `npm run dev`) at
 * `#/debug/<bookId>`. Reads straight from Dexie; nothing here is bundled in production.
 */

import { useEffect, useMemo, useState } from 'preact/hooks'
import { goldFromBeads } from '../align/gold.ts'
import { LOW_CONFIDENCE, type ChapterMeta, type ChapterPair } from '../align/pipeline.ts'
import { db, type BeadRow, type Book, type SentenceRow } from '../store/db.ts'
import { useLiveQuery } from '../store/hooks.ts'
import './debug.css'

interface Props {
  bookId: string
  onBack: () => void
}

interface Loaded {
  book: Book
  de: Map<number, SentenceRow>
  en: Map<number, SentenceRow>
  beads: BeadRow[]
}

/** Confidence (0.5–1) → a hue from red through amber to green. */
export function heatColour(confidence: number): string {
  const t = Math.min(1, Math.max(0, (confidence - 0.5) / 0.5))
  return `hsl(${Math.round(120 * t)} 70% 50% / ${(0.15 + 0.35 * (1 - t)).toFixed(2)})`
}

const shapeOf = (b: BeadRow) => `${b.deSentenceIdx.length}-${b.enSentenceIdx.length}`

export function AlignmentDebug({ bookId, onBack }: Props) {
  const data = useLiveQuery<Loaded | null>(async () => {
    const book = await db().books.get(bookId)
    if (book === undefined) return null
    const [de, en, beads] = await Promise.all([
      db().sentences.where('[bookId+lang]').equals([bookId, 'de']).toArray(),
      db().sentences.where('[bookId+lang]').equals([bookId, 'en']).toArray(),
      db().beads.where('bookId').equals(bookId).sortBy('beadIdx'),
    ])
    return { book, de: new Map(de.map((s) => [s.idx, s])), en: new Map(en.map((s) => [s.idx, s])), beads }
  }, [bookId])

  const [pairIdx, setPairIdx] = useState(0)
  const [threshold, setThreshold] = useState(LOW_CONFIDENCE)
  const [onlyUncertain, setOnlyUncertain] = useState(false)
  const [showLexicon, setShowLexicon] = useState(false)
  const [goldCount, setGoldCount] = useState(150)
  const [copied, setCopied] = useState<string | null>(null)

  if (data === undefined) return <div class="debug-screen">Loading…</div>
  if (data === null) return <div class="debug-screen">No such book.</div>
  const { book } = data
  const alignment = book.alignment
  if (alignment?.status !== 'ready' || alignment.chapters === undefined) {
    return (
      <div class="debug-screen">
        <DebugBar title={book.title} onBack={onBack} />
        <p class="debug-note">This book is not aligned yet (status: {alignment?.status ?? 'pending'}).</p>
      </div>
    )
  }
  const chapters = alignment.chapters
  const pairs = chapters.pairs
  const pair = pairs[Math.min(pairIdx, pairs.length - 1)]

  return (
    <div class="debug-screen">
      <DebugBar title={book.title} onBack={onBack} />
      <Stats book={book} />
      <div class="debug-toolbar">
        <label>
          Chapter pair{' '}
          <select value={pairIdx} onChange={(e) => setPairIdx(Number((e.currentTarget as HTMLSelectElement).value))}>
            {pairs.map((p, i) => (
              <option value={i}>{pairLabel(p, chapters.de, chapters.en)}</option>
            ))}
          </select>
        </label>
        <button type="button" disabled={pairIdx === 0} onClick={() => setPairIdx(pairIdx - 1)}>
          ‹
        </button>
        <button type="button" disabled={pairIdx >= pairs.length - 1} onClick={() => setPairIdx(pairIdx + 1)}>
          ›
        </button>
        <label>
          Uncertain ≤{' '}
          <input
            type="range"
            min="0.5"
            max="1"
            step="0.01"
            value={threshold}
            onInput={(e) => setThreshold(Number((e.currentTarget as HTMLInputElement).value))}
          />{' '}
          <span class="debug-mono">{threshold.toFixed(2)}</span>
        </label>
        <label>
          <input type="checkbox" checked={onlyUncertain} onChange={() => setOnlyUncertain(!onlyUncertain)} /> only uncertain
        </label>
        <label>
          <input type="checkbox" checked={showLexicon} onChange={() => setShowLexicon(!showLexicon)} /> learned lexicon
        </label>
        <label>
          Gold draft of first{' '}
          <input
            type="number"
            min="1"
            step="10"
            value={goldCount}
            class="debug-num"
            onInput={(e) => setGoldCount(Number((e.currentTarget as HTMLInputElement).value) || 150)}
          />{' '}
          beads
        </label>
        <button
          type="button"
          onClick={async () => {
            const gold = goldFromBeads(
              book.title,
              { de: book.sources.de.fileName, en: book.sources.en.fileName },
              { de: [...data.de.values()], en: [...data.en.values()] },
              data.beads.map((b) => ({ deSentenceIdx: b.deSentenceIdx, enSentenceIdx: b.enSentenceIdx, cost: 0, margin: 0, confidence: b.confidence })),
              goldCount,
            )
            const text = JSON.stringify(gold, null, 2)
            try {
              await navigator.clipboard.writeText(text)
              setCopied(`Copied ${gold.beads.length} beads`)
            } catch {
              setCopied('Clipboard blocked; see console')
              console.log(text)
            }
            setTimeout(() => setCopied(null), 2000)
          }}
        >
          Copy gold draft
        </button>
        {copied && <span class="debug-note">{copied}</span>}
      </div>
      {showLexicon && <Lexicon pairs={alignment.lexicon ?? []} />}
      <Legend />
      {pair === undefined ? (
        <p class="debug-note">No chapters.</p>
      ) : (
        <PairTable key={pairIdx} data={data} pair={pair} chapters={chapters} threshold={threshold} onlyUncertain={onlyUncertain} />
      )}
    </div>
  )
}

function DebugBar({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <header class="debug-bar">
      <button type="button" class="debug-back" onClick={onBack}>
        ‹ Library
      </button>
      <h1>
        Alignment debug <span class="debug-dim">· {title}</span>
      </h1>
    </header>
  )
}

function Stats({ book }: { book: Book }) {
  const s = book.alignment?.stats
  if (s === undefined) return null
  const items: [string, string][] = [
    ['sentences', `${s.sentences.de} de / ${s.sentences.en} en`],
    ['beads', String(s.beads)],
    ['1-1', `${s.oneToOne} (${Math.round((100 * s.oneToOne) / Math.max(1, s.beads))}%)`],
    [`uncertain ≤ ${LOW_CONFIDENCE}`, String(s.uncertain)],
    ['learned pairs', String(s.learnedPairs)],
    ['changed in pass two', String(s.changedBeads)],
    ['chapter pairs', String(s.pairedChapters)],
    ['time', `${s.elapsedMs} ms`],
  ]
  return (
    <dl class="debug-stats">
      {items.map(([k, v]) => (
        <div>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function Lexicon({ pairs }: { pairs: readonly { de: string; en: string; count: number; dice: number }[] }) {
  return (
    <div class="debug-lexicon">
      {pairs.length === 0 ? 'Nothing learned.' : null}
      {pairs.map((p) => (
        <span title={`${p.count} beads, Dice ${p.dice.toFixed(2)}`}>
          {p.de} → {p.en}
        </span>
      ))}
    </div>
  )
}

function Legend() {
  return (
    <div class="debug-legend">
      {[0.5, 0.6, 0.7, 0.8, 0.9, 1].map((c) => (
        <span style={{ background: heatColour(c) }}>{c.toFixed(1)}</span>
      ))}
      <span class="debug-dim">confidence; dotted rows are at or below the threshold</span>
    </div>
  )
}

function pairLabel(pair: ChapterPair, de: ChapterMeta[], en: ChapterMeta[]): string {
  const name = (side: ChapterMeta[], idx: number[]) => (idx.length === 0 ? '—' : idx.map((i) => side[i].heading ?? `chapter ${i + 1}`).join(' + '))
  return `${name(de, pair.de)}  ↔  ${name(en, pair.en)}`
}

interface TableProps {
  data: Loaded
  pair: ChapterPair
  chapters: { de: ChapterMeta[]; en: ChapterMeta[] }
  threshold: number
  onlyUncertain: boolean
}

function PairTable({ data, pair, chapters, threshold, onlyUncertain }: TableProps) {
  // The beads of this pair: those whose German (or, one-sided, English) sentences lie in the
  // pair's paragraph ranges.
  const rows = useMemo(() => {
    const inRange = (side: ChapterMeta[], idx: number[], paraIdx: number) =>
      idx.some((i) => paraIdx >= side[i].paraStart && paraIdx < side[i].paraStart + side[i].paraCount)
    return data.beads.filter((b) => {
      const d = b.deSentenceIdx[0]
      const e = b.enSentenceIdx[0]
      if (d !== undefined) return inRange(chapters.de, pair.de, data.de.get(d)?.paraIdx ?? -1)
      if (e !== undefined) return inRange(chapters.en, pair.en, data.en.get(e)?.paraIdx ?? -1)
      return false
    })
  }, [data, pair, chapters])

  const [limit, setLimit] = useState(400)
  useEffect(() => setLimit(400), [pair])

  let lastDePara = -1
  let lastEnPara = -1
  const shown = rows.filter((b) => !onlyUncertain || b.confidence <= threshold).slice(0, limit)
  return (
    <>
      <p class="debug-note">
        {rows.length} beads in this chapter pair, {rows.filter((b) => b.confidence <= threshold).length} at or below {threshold.toFixed(2)}
      </p>
      <table class="debug-table">
        <thead>
          <tr>
            <th>#</th>
            <th>shape</th>
            <th>conf</th>
            <th>Deutsch</th>
            <th>English</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((b) => {
            const de = b.deSentenceIdx.map((i) => data.de.get(i))
            const en = b.enSentenceIdx.map((j) => data.en.get(j))
            const dePara = de[0]?.paraIdx ?? lastDePara
            const enPara = en[0]?.paraIdx ?? lastEnPara
            const newPara = dePara !== lastDePara || enPara !== lastEnPara
            lastDePara = dePara
            lastEnPara = enPara
            const uncertain = b.confidence <= threshold
            return (
              <tr
                id={`bead-${b.beadIdx}`}
                class={`${newPara ? 'debug-para' : ''} ${uncertain ? 'debug-uncertain' : ''}`}
                style={{ background: heatColour(b.confidence) }}
              >
                <td class="debug-mono">{b.beadIdx}</td>
                <td class="debug-mono">{shapeOf(b)}</td>
                <td class="debug-mono">{b.confidence.toFixed(2)}</td>
                <td lang="de">
                  {de.map((s, k) => (
                    <p>
                      <span class="debug-idx">{b.deSentenceIdx[k]}</span> {s?.text ?? '?'}
                    </p>
                  ))}
                </td>
                <td lang="en">
                  {en.map((s, k) => (
                    <p>
                      <span class="debug-idx">{b.enSentenceIdx[k]}</span> {s?.text ?? '?'}
                    </p>
                  ))}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {shown.length < rows.filter((b) => !onlyUncertain || b.confidence <= threshold).length && (
        <button type="button" class="debug-more" onClick={() => setLimit(limit + 400)}>
          Show more
        </button>
      )}
    </>
  )
}
