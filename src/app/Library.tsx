import { useEffect, useState } from 'preact/hooks'
import { clearAlignmentError, resumeAlignments, startAlignment, type AlignmentJob } from '../align/jobs.ts'
import { isPrealignedBook } from '../align/prealigned.ts'
import { bundleFileName, exportBundle } from '../store/bundle.ts'
import type { Book } from '../store/db.ts'
import { useAlignmentJobs, useBooks } from '../store/hooks.ts'
import { Cover } from '../ui/Cover.tsx'
import { shareOrDownload } from '../ui/download.ts'
import { AddBookSheet } from './AddBookSheet.tsx'
import { RealignSheet } from './RealignSheet.tsx'
import { BOOKMARKS_HASH, debugHash, readHash, SETTINGS_HASH } from './routes.ts'
import './library.css'

/** Library tab: Books-style bookshelf grid with an "Add book" sheet. */
export function Library() {
  const books = useBooks()
  const jobs = useAlignmentJobs()
  const [adding, setAdding] = useState(false)
  const [realigning, setRealigning] = useState<Book | null>(null)

  // Books whose alignment was interrupted by a reload pick up where the queue left off.
  useEffect(() => {
    void resumeAlignments()
  }, [])

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

      <main class={`content ${books && books.length > 0 ? 'content--shelf' : ''}`}>
        {books === undefined ? null : books.length === 0 ? (
          <EmptyShelf onAdd={() => setAdding(true)} />
        ) : (
          <Shelf books={books} jobs={jobs} onRealign={setRealigning} />
        )}
      </main>

      <AddBookSheet open={adding} onClose={() => setAdding(false)} />
      <RealignSheet book={realigning} onClose={() => setRealigning(null)} />
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
  onRealign: (book: Book) => void
}

function Shelf({ books, jobs, onRealign }: ShelfProps) {
  return (
    <ul class="shelf" aria-label="Books">
      {books.map((b) => (
        <ShelfItem key={b.id} book={b} job={jobs.get(b.id)} onRealign={onRealign} />
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

function ShelfItem({ book, job, onRealign }: { book: Book; job: AlignmentJob | undefined; onRealign: (book: Book) => void }) {
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
  }
  const cover = (
    <>
      <Cover title={book.title} author={book.author} colours={book.cover} class="cover-shelf" progress={busy ? fraction : undefined} />
      <div class="shelf-title">{book.title}</div>
      <div class="shelf-author">{book.author}</div>
    </>
  )
  return (
    <li class="shelf-item">
      {status === 'ready' ? (
        <a class="shelf-link" href={readHash(book.id, 0)} aria-label={`Read ${book.title}`}>
          {cover}
        </a>
      ) : (
        cover
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
    </li>
  )
}
