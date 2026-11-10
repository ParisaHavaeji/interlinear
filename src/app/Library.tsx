import { useState } from 'preact/hooks'
import type { Book } from '../store/db.ts'
import { useBooks } from '../store/hooks.ts'
import { Cover } from '../ui/Cover.tsx'
import { AddBookSheet } from './AddBookSheet.tsx'
import './library.css'

/** Library tab: Books-style bookshelf grid with an "Add book" sheet. */
export function Library() {
  const books = useBooks()
  const [adding, setAdding] = useState(false)

  return (
    <div class="screen">
      <header class="top-bar top-bar--library">
        <h1 class="large-title">Library</h1>
        <button type="button" class="icon-btn" aria-label="Add book" onClick={() => setAdding(true)}>
          +
        </button>
      </header>

      <main class={`content ${books && books.length > 0 ? 'content--shelf' : ''}`}>
        {books === undefined ? null : books.length === 0 ? <EmptyShelf onAdd={() => setAdding(true)} /> : <Shelf books={books} />}
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

function Shelf({ books }: { books: Book[] }) {
  return (
    <ul class="shelf" aria-label="Books">
      {books.map((b) => (
        <li key={b.id} class="shelf-item">
          <Cover title={b.title} author={b.author} colours={b.cover} class="cover-shelf" />
          <div class="shelf-title">{b.title}</div>
          <div class="shelf-author">{b.author}</div>
        </li>
      ))}
    </ul>
  )
}
