/**
 * The Library (plan.md step 29, §1.8): Books' bookshelf. A "Reading Now" card at the top shows
 * the aligned book opened most recently with its cover, the chapter it is open at and how much
 * of it is read, and opens it where it was left; the shelf grid below carries every book, each
 * tile a generated cover with the title and author, its read share once it has been opened, and
 * the alignment's progress, status and actions while it has any. A tile swipes to the left to
 * uncover Delete (`ui/SwipeRow.tsx`, as the bookmark rows of step 26), which asks first in a
 * sheet, since a book takes its alignment and bookmarks with it; the tile then shrinks away. The
 * progress rows come from the Reader (`reader/progress.ts`) and are read live, so the card and
 * the notes follow reading in another tab too.
 */

import { useEffect, useState } from 'preact/hooks'
import { cancelAlignment, clearAlignmentError, resumeAlignments, startAlignment, type AlignmentJob } from '../align/jobs.ts'
import { isPrealignedBook } from '../align/prealigned.ts'
import { chapterLabel, percentRead, progressLabel, readingNow, type ReadingNow } from '../reader/progress.ts'
import { deleteBook } from '../store/books.ts'
import { bundleFileName, exportBundle } from '../store/bundle.ts'
import { db, type Book, type ProgressRow } from '../store/db.ts'
import { useAlignmentJobs, useBooks, useLiveQuery, useProgress } from '../store/hooks.ts'
import { BottomSheet } from '../ui/BottomSheet.tsx'
import { Cover } from '../ui/Cover.tsx'
import { shareOrDownload } from '../ui/download.ts'
import { SWIPE_SETTLE_MS, SwipeRow } from '../ui/SwipeRow.tsx'
import { AddBookSheet } from './AddBookSheet.tsx'
import { RealignSheet } from './RealignSheet.tsx'
import { BOOKMARKS_HASH, debugHash, readHash, SETTINGS_HASH } from './routes.ts'
import './library.css'

/** Width of the Delete uncovered behind a shelf tile; narrower than a list row's, the tile being narrow. */
const SHELF_ACTION_WIDTH = 72
/** The tile's vanishing animation (library.css) runs this long after a confirmed Delete. */
const VANISH_MS = SWIPE_SETTLE_MS + 160

/** Library tab: Books-style bookshelf grid with an "Add book" sheet. */
export function Library() {
  const books = useBooks()
  const jobs = useAlignmentJobs()
  const progress = useProgress()
  const [adding, setAdding] = useState(false)
  const [realigning, setRealigning] = useState<Book | null>(null)
  /** The tile whose Delete is uncovered, if any; one at a time. */
  const [openId, setOpenId] = useState<string | null>(null)
  /** The book Delete was chosen for, awaiting the answer in the sheet. */
  const [asking, setAsking] = useState<Book | null>(null)
  /** The book being removed: its tile vanishes, then the rows go. */
  const [removingId, setRemovingId] = useState<string | null>(null)

  // Books whose alignment was interrupted by a reload pick up where the queue left off.
  useEffect(() => {
    void resumeAlignments()
  }, [])

  const confirmDelete = (book: Book) => {
    setAsking(null)
    setRemovingId(book.id)
    cancelAlignment(book.id)
    window.setTimeout(() => {
      deleteBook(book.id)
        .catch((err: unknown) => console.error('could not delete the book', err))
        .finally(() => {
          setRemovingId((id) => (id === book.id ? null : id))
          setOpenId((id) => (id === book.id ? null : id))
        })
    }, VANISH_MS)
  }
  const cancelDelete = () => {
    setAsking(null)
    setOpenId(null)
  }

  const loading = books === undefined || progress === undefined
  const now = loading ? null : readingNow(books, progress)

  return (
    <div class="screen">
      <header class="top-bar top-bar--library">
        <h1 class="large-title">Library</h1>
        <div class="top-bar-actions">
          <a class="icon-btn" href={BOOKMARKS_HASH} aria-label="Bookmarks">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M6.5 3.5h11v17l-5.5-4.5-5.5 4.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
            </svg>
          </a>
          <a class="icon-btn" href={SETTINGS_HASH} aria-label="Settings">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2" />
              <path
                d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
          </a>
          <button type="button" class="icon-btn" aria-label="Add book" onClick={() => setAdding(true)}>
            +
          </button>
        </div>
      </header>

      <main
        class={`content ${!loading && books.length > 0 ? 'content--shelf' : ''}`}
        onClick={(e) => {
          // A tap on the page outside the tiles shuts the open one.
          if ((e.target as Element | null)?.closest('.swipe') === null) setOpenId(null)
        }}
      >
        {loading ? null : books.length === 0 ? (
          <EmptyShelf onAdd={() => setAdding(true)} />
        ) : (
          <>
            {now !== null && <ReadingNowCard now={now} />}
            {now !== null && <h2 class="section-title">Library</h2>}
            <Shelf
              books={books}
              jobs={jobs}
              progress={progress}
              openId={openId}
              removingId={removingId}
              onOpenChange={(id, open) => setOpenId((prev) => (open ? id : prev === id ? null : prev))}
              onDelete={setAsking}
              onRealign={setRealigning}
            />
          </>
        )}
      </main>

      <AddBookSheet open={adding} onClose={() => setAdding(false)} />
      <RealignSheet book={realigning} onClose={() => setRealigning(null)} />
      <DeleteBookSheet book={asking} onCancel={cancelDelete} onConfirm={confirmDelete} />
    </div>
  )
}

function EmptyShelf({ onAdd }: { onAdd: () => void }) {
  return (
    <div class="empty">
      <div class="empty-cover" aria-hidden="true" />
      <p class="empty-title">No books yet</p>
      <p class="empty-sub">Add a German book and its English translation to start reading.</p>
      <button type="button" class="btn-primary btn-inline" onClick={onAdd}>
        Add Book
      </button>
    </div>
  )
}

/** The book opened most recently (step 29): cover, chapter, read share; a tap opens it where it was left. */
function ReadingNowCard({ now: { book, progress } }: { now: ReadingNow }) {
  const chapter = chapterLabel(book, progress.chapter)
  const percent = percentRead(progress.read)
  return (
    <section class="now" aria-labelledby="now-title">
      <h2 class="section-title" id="now-title">
        Reading Now
      </h2>
      <a class="now-card" href={readHash(book.id)} draggable={false} aria-label={`Continue reading ${book.title}`}>
        <div class="now-cover">
          <Cover title={book.title} author={book.author} colours={book.cover} />
        </div>
        <div class="now-text">
          <div class="now-title">{book.title}</div>
          <div class="now-author">{book.author}</div>
          {chapter !== null && <div class="now-chapter">{chapter}</div>}
          <div class="now-progress" role="progressbar" aria-label="Read" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <div class="now-progress-bar" style={{ width: `${percent}%` }} />
          </div>
          <div class="now-percent">{progressLabel(progress.read)}</div>
        </div>
        <svg class="now-chevron" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </a>
    </section>
  )
}

const STAGE_LABELS: Record<AlignmentJob['stage'], string> = {
  queued: 'Waiting',
  structure: 'Reading chapters',
  sentences: 'Splitting sentences',
  model: 'Downloading model',
  embed: 'Reading with the model',
  pass1: 'Matching sentences',
  pass2: 'Second pass',
  saving: 'Saving',
}

interface ShelfProps {
  books: Book[]
  jobs: ReadonlyMap<string, AlignmentJob>
  progress: ReadonlyMap<string, ProgressRow>
  openId: string | null
  removingId: string | null
  onOpenChange: (id: string, open: boolean) => void
  onDelete: (book: Book) => void
  onRealign: (book: Book) => void
}

function Shelf({ books, jobs, progress, openId, removingId, onOpenChange, onDelete, onRealign }: ShelfProps) {
  return (
    <ul class="shelf" aria-label="Books">
      {books.map((b) => (
        <ShelfItem
          key={b.id}
          book={b}
          job={jobs.get(b.id)}
          progress={progress.get(b.id)}
          open={openId === b.id}
          removing={removingId === b.id}
          onOpenChange={(open) => onOpenChange(b.id, open)}
          onDelete={() => onDelete(b)}
          onRealign={onRealign}
        />
      ))}
    </ul>
  )
}

/**
 * Export a book as a `.interlinear.json` bundle (plan.md step 14) through the share sheet or a
 * download. Returns the error message to show, or null.
 */
async function exportBook(book: Book): Promise<string | null> {
  try {
    const bundle = await exportBundle(book.id)
    const file = new File([JSON.stringify(bundle)], bundleFileName(book), { type: 'application/json' })
    await shareOrDownload(file)
    return null
  } catch (err) {
    console.error(err)
    return 'Could not export the book.'
  }
}

interface ItemProps {
  book: Book
  job: AlignmentJob | undefined
  progress: ProgressRow | undefined
  open: boolean
  removing: boolean
  onOpenChange: (open: boolean) => void
  onDelete: () => void
  onRealign: (book: Book) => void
}

function ShelfItem({ book, job, progress, open, removing, onOpenChange, onDelete, onRealign }: ItemProps) {
  const status = book.alignment?.status ?? 'pending'
  const busy = job !== undefined || status === 'pending' || status === 'aligning'
  const fraction = job?.fraction ?? 0
  const neural = book.alignment?.stats?.neural === true
  // A failed re-alignment of a ready book leaves its error here, next to the old, intact beads.
  const realignError = job === undefined && status === 'ready' ? book.alignment?.error : undefined
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  let note = null
  if (job !== undefined) {
    note = (
      <div class="shelf-note" role="status">
        {STAGE_LABELS[job.stage]}… {Math.round(fraction * 100)}%
      </div>
    )
  } else if (status === 'failed') {
    note = (
      <div class="shelf-note shelf-note--error" role="status">
        Couldn’t align.{' '}
        <button type="button" class="link-btn" onClick={() => void startAlignment(book.id)}>
          Retry
        </button>
      </div>
    )
  } else if (busy) {
    note = (
      <div class="shelf-note" role="status">
        Waiting…
      </div>
    )
  } else if (status === 'ready' && progress !== undefined) {
    note = <div class="shelf-note shelf-note--progress">{progressLabel(progress.read)}</div>
  }
  const cover = (
    <>
      <Cover title={book.title} author={book.author} colours={book.cover} class="cover-shelf" progress={busy ? fraction : undefined} />
      <div class="shelf-title">{book.title}</div>
      <div class="shelf-author">{book.author}</div>
    </>
  )
  return (
    <SwipeRow class="shelf-item" plain ask open={open} removing={removing} onOpenChange={onOpenChange} onDelete={onDelete} actionWidth={SHELF_ACTION_WIDTH}>
      {status === 'ready' ? (
        <a class="shelf-link" href={readHash(book.id)} draggable={false} aria-label={`Read ${book.title}`}>
          {cover}
        </a>
      ) : (
        <div class="shelf-link">{cover}</div>
      )}
      {note}
      {status === 'ready' && job === undefined && (
        <div class="shelf-note shelf-actions">
          {neural && <span class="shelf-tag" title="Aligned with the language model">High accuracy</span>}
          <button
            type="button"
            class="link-btn"
            disabled={exporting}
            onClick={async () => {
              setExporting(true)
              setExportError(await exportBook(book))
              setExporting(false)
            }}
          >
            {exporting ? 'Exporting…' : 'Export'}
          </button>
          {!isPrealignedBook(book) && (
            <button type="button" class="link-btn" onClick={() => onRealign(book)}>
              Re-align…
            </button>
          )}
          {import.meta.env.DEV && <a href={debugHash(book.id)}>Debug</a>}
        </div>
      )}
      {realignError && (
        <div class="shelf-note shelf-note--error" role="alert">
          Couldn’t re-align: {realignError}{' '}
          <button type="button" class="link-btn" onClick={() => void clearAlignmentError(book.id)}>
            Dismiss
          </button>
        </div>
      )}
      {exportError && (
        <div class="shelf-note shelf-note--error" role="alert">
          {exportError}
        </div>
      )}
    </SwipeRow>
  )
}

interface DeleteProps {
  /** The book Delete was chosen for; null keeps the sheet closed. */
  book: Book | null
  onCancel: () => void
  onConfirm: (book: Book) => void
}

/** Asks before a book goes (step 29), naming what goes with it. */
function DeleteBookSheet({ book, onCancel, onConfirm }: DeleteProps) {
  const count = useLiveQuery(() => (book === null ? Promise.resolve(0) : db().bookmarks.where('bookId').equals(book.id).count()), [book?.id])
  if (book === null) return null
  const what = count === undefined || count === 0 ? 'The book and its alignment' : count === 1 ? 'The book, its alignment and its bookmark' : `The book, its alignment and its ${count} bookmarks`
  return (
    <BottomSheet open onClose={onCancel} title={`Delete “${book.title}”?`}>
      <p class="sheet-text">{what} are removed from this device. Bundles and bookmark files already exported are not affected.</p>
      <button type="button" class="btn-destructive" onClick={() => onConfirm(book)}>
        Delete Book
      </button>
      <button type="button" class="btn-plain" onClick={onCancel}>
        Cancel
      </button>
    </BottomSheet>
  )
}
