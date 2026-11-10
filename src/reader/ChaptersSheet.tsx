/**
 * The chapter list sheet (plan.md step 17, §1.1b): every section of both editions side by
 * side, paired as the aligner paired them, with excluded front and back matter greyed in its
 * place and pairs whose lengths disagree marked. Tapping a German chapter opens it. "Edit"
 * turns the rows into controls: include or exclude a section, pair a German chapter with an
 * English one by hand, or hand a pair back to the aligner. Each change is stored on the book
 * and re-aligns only the chapters it touched (`applyChapterEdits`); the sheet shows the run's
 * progress and the book stays readable throughout.
 */

import { useState } from 'preact/hooks'
import { applyChapterEdits } from '../align/jobs.ts'
import { isPrealignedBook } from '../align/prealigned.ts'
import type { Book } from '../store/db.ts'
import { useAlignmentJobs } from '../store/hooks.ts'
import { BottomSheet } from '../ui/BottomSheet.tsx'
import { chapterRows, withInclusion, withoutPair, withPair, type ChapterRow, type ChapterUnit } from './chapters.ts'

interface Props {
  open: boolean
  book: Book
  /** Position of the chapter on screen in the German chapter list. */
  current: number
  onClose: () => void
  onChapter: (chapter: number) => void
}

const KIND_LABEL = { front: 'Front matter', back: 'Back matter', body: 'Not included' } as const

export function ChaptersSheet({ open, book, current, onClose, onChapter }: Props) {
  const [editing, setEditing] = useState(false)
  /** The German chapter picked for re-pairing, waiting for an English one. */
  const [picked, setPicked] = useState<ChapterUnit | null>(null)
  const job = useAlignmentJobs().get(book.id)
  const rows = chapterRows(book)
  const editable = !isPrealignedBook(book) && book.alignment?.status === 'ready'
  const busy = job !== undefined

  const close = () => {
    setEditing(false)
    setPicked(null)
    onClose()
  }
  const apply = (edits: ReturnType<typeof withInclusion>) => {
    setPicked(null)
    void applyChapterEdits(book.id, edits)
  }
  const tapUnit = (unit: ChapterUnit) => {
    if (editing) {
      if (unit.lang === 'de' && unit.included) setPicked(picked?.key === unit.key ? null : unit)
      else if (unit.lang === 'en' && unit.included && picked !== null) apply(withPair(book.chapterEdits, picked, unit))
      return
    }
    if (unit.lang === 'de' && unit.chapterIdx !== null) {
      onChapter(unit.chapterIdx)
      close()
    }
  }

  return (
    <BottomSheet open={open} onClose={close}>
      <div class="toc-head">
        <h2 class="toc-title">Contents</h2>
        {editable && (
          <button type="button" class="toc-edit" disabled={busy && !editing} onClick={() => (setEditing(!editing), setPicked(null))}>
            {editing ? 'Done' : 'Edit'}
          </button>
        )}
      </div>
      {busy ? (
        <p class="toc-status" role="status">
          Re-aligning{job.partial ? ' the changed chapters' : ''}… {Math.round(job.fraction * 100)}%
        </p>
      ) : book.alignment?.error !== undefined ? (
        <p class="toc-status toc-status--error" role="alert">
          {book.alignment.error}
        </p>
      ) : editing ? (
        <p class="toc-status">
          {picked === null
            ? 'Tap a German chapter, then the English chapter it translates. Use the buttons to leave a section out or bring one in.'
            : `Now tap the English chapter that translates “${picked.title}”.`}
        </p>
      ) : null}
      <div class="toc-langs" aria-hidden="true">
        <span>German</span>
        <span>English</span>
      </div>
      {rows.length === 0 ? (
        <p class="toc-status">The chapters appear once the book is aligned.</p>
      ) : (
        <ol class="toc" aria-label="Chapters of both editions">
          {rows.map((row) => (
            <Row
              key={row.type === 'pair' ? `p${row.pairIdx}` : `x${row.unit.lang}${row.unit.key}`}
              row={row}
              current={current}
              editing={editing && !busy}
              picked={picked}
              onTap={tapUnit}
              onInclude={(unit, include) => apply(withInclusion(book.chapterEdits, unit, include))}
              onUnpair={(r) => apply(withoutPair(book.chapterEdits, r))}
            />
          ))}
        </ol>
      )}
    </BottomSheet>
  )
}

interface RowProps {
  row: ChapterRow
  current: number
  editing: boolean
  picked: ChapterUnit | null
  onTap: (unit: ChapterUnit) => void
  onInclude: (unit: ChapterUnit, include: boolean) => void
  onUnpair: (row: { de: ChapterUnit[]; en: ChapterUnit[] }) => void
}

function Row({ row, current, editing, picked, onTap, onInclude, onUnpair }: RowProps) {
  if (row.type === 'excluded') {
    const { unit } = row
    return (
      <li class={`toc-row toc-row--excluded toc-row--${unit.lang}`}>
        <div class="toc-cell toc-cell--excluded">
          <span class="toc-name">{unit.title}</span>
          <span class="toc-meta">
            {KIND_LABEL[unit.kind]} · {words(unit.words)}
          </span>
          {editing && (
            <button type="button" class="toc-action" onClick={() => onInclude(unit, true)}>
              Include
            </button>
          )}
        </div>
      </li>
    )
  }
  const isCurrent = row.de.some((u) => u.chapterIdx === current)
  const classes = ['toc-row']
  if (isCurrent) classes.push('toc-row--current')
  if (row.uncertain) classes.push('toc-row--uncertain')
  return (
    <li class={classes.join(' ')} aria-current={isCurrent ? 'true' : undefined}>
      <Cell units={row.de} current={current} editing={editing} picked={picked} onTap={onTap} onInclude={onInclude} />
      <Cell units={row.en} current={current} editing={editing} picked={picked} onTap={onTap} onInclude={onInclude} />
      {(row.uncertain || row.manual) && (
        <div class="toc-flags">
          {row.uncertain && (
            <span class="toc-flag toc-flag--uncertain" title={`Lengths agree ${Math.round((row.confidence ?? 0) * 100)}%`}>
              Check pairing
            </span>
          )}
          {row.manual && <span class="toc-flag">Paired by hand</span>}
          {editing && row.manual && (
            <button type="button" class="toc-action" onClick={() => onUnpair(row)}>
              Pair automatically
            </button>
          )}
        </div>
      )}
    </li>
  )
}

interface CellProps {
  units: ChapterUnit[]
  current: number
  editing: boolean
  picked: ChapterUnit | null
  onTap: (unit: ChapterUnit) => void
  onInclude: (unit: ChapterUnit, include: boolean) => void
}

function Cell({ units, current, editing, picked, onTap, onInclude }: CellProps) {
  if (units.length === 0) return <div class="toc-cell toc-cell--empty">—</div>
  return (
    <div class="toc-cell">
      {units.map((unit) => {
        const tappable = editing ? true : unit.lang === 'de'
        const isPicked = picked !== null && picked.lang === unit.lang && picked.key === unit.key
        const isCurrent = unit.lang === 'de' && unit.chapterIdx === current
        return (
          <div class={`toc-unit${isPicked ? ' toc-unit--picked' : ''}${isCurrent ? ' toc-unit--current' : ''}`} key={unit.key}>
            <button type="button" class="toc-name" disabled={!tappable} onClick={() => onTap(unit)}>
              {unit.title}
            </button>
            <span class="toc-meta">{words(unit.words)}</span>
            {editing && (
              <button type="button" class="toc-action" onClick={() => onInclude(unit, false)}>
                Exclude
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

function words(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k words`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k words`
  return `${n} words`
}
