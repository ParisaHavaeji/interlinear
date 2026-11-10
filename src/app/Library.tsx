import { useEffect, useState } from 'preact/hooks'
import { resumeAlignments, startAlignment, type AlignmentJob } from '../align/jobs.ts'
import type { Book } from '../store/db.ts'
import { useAlignmentJobs, useBooks } from '../store/hooks.ts'
import { Cover } from '../ui/Cover.tsx'
import { AddBookSheet } from './AddBookSheet.tsx'
import './library.css'

/** Library tab: Books-style bookshelf grid with an "Add book" sheet. */
export function Library() {
  const books = useBooks()
  const jobs = useAlignmentJobs()
  const [adding, setAdding] = useState(false)

  // Books whose alignment was interrupted by a reload pick up where the queue left off.
  useEffect(() => {
    void resumeAlignments()
  }, [])

  return (
    <div class="screen">
      <header class="top-bar top-bar--library">
        <h1 class="large-title">Library</h1>
        <button type="button" class="icon-btn" aria-label="Add book" onClick={() => setAdding(true)}>
          +
        </button>
      </header>

      <main class={`content ${books && books.length > 0 ? 'content--shelf' : ''}`}>
        {books === undefined ? null : books.length === 0 ? (
          <EmptyShelf onAdd={() => setAdding(true)} />
        ) : (
          <Shelf books={books} jobs={jobs} />
        )}
      </main>

      <AddBookSheet open={adding} onClose={() => setAdding(false)} />
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
  pass1: 'Matching sentences',
  pass2: 'Second pass',
  saving: 'Saving',
}

function Shelf({ books, jobs }: { books: Book[]; jobs: ReadonlyMap<string, AlignmentJob> }) {
  return (
    <ul class="shelf" aria-label="Books">
      {books.map((b) => (
        <ShelfItem key={b.id} book={b} job={jobs.get(b.id)} />
      ))}
    </ul>
  )
}

function ShelfItem({ book, job }: { book: Book; job: AlignmentJob | undefined }) {
  const status = book.alignment?.status ?? 'pending'
  const busy = job !== undefined || status === 'pending' || status === 'aligning'
  const fraction = job?.fraction ?? 0
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
  return (
    <li class="shelf-item">
      <Cover title={book.title} author={book.author} colours={book.cover} class="cover-shelf" progress={busy ? fraction : undefined} />
      <div class="shelf-title">{book.title}</div>
      <div class="shelf-author">{book.author}</div>
      {note}
      {import.meta.env.DEV && status === 'ready' && (
        <a class="shelf-note" href={`#/debug/${encodeURIComponent(book.id)}`}>
          Debug alignment
        </a>
      )}
    </li>
  )
}
