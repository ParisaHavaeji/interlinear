/**
 * The bookmarks screen (plan.md step 26, §1.7): every bookmark made from the cards of step 25,
 * grouped by book in the Books manner, with a search field, swipe-to-delete rows and a tap that
 * opens the Reader at the bookmark. At `#/bookmarks` it lists every book; the Reader's ribbon
 * opens it at `#/bookmarks/<bookId>/<chapter>` for one book, with Back returning to that chapter.
 * A sentence row shows the German text and its translation; a word row the headword with its
 * article coloured as the word card colours it, the glosses, and the sentence it came from; both
 * end with the chapter and the day the bookmark was made. The rows come from one live query, so
 * the list follows deletions made here and bookmarks made in the Reader. The model is
 * `bookmarks/list.ts`; the swipe is `ui/SwipeRow.tsx`; the jump itself is the Reader's
 * (`bookmarks/locate.ts`).
 */

import { useMemo, useState } from 'preact/hooks'
import { countLabel, dateLabel, filterGroups, groupBookmarks, wordGloss, wordHeadline, type BookmarkGroup } from '../bookmarks/list.ts'
import { listBookmarks, removeBookmark } from '../bookmarks/store.ts'
import { articleColour, sanitizeArticleColours, type ArticleColours } from '../reader/word.ts'
import { db, type Book, type BookmarkRow } from '../store/db.ts'
import { useBooks, useLiveQuery } from '../store/hooks.ts'
import { ARTICLE_COLOURS_KEY, useSetting } from '../store/settings.ts'
import { Cover } from '../ui/Cover.tsx'
import { SwipeRow } from '../ui/SwipeRow.tsx'
import { readHash } from './routes.ts'
import './bookmarks.css'

interface Props {
  /** Show one book's bookmarks only (opened from its Reader); Back returns there. */
  book?: { id: string; chapter: number }
  onBack: () => void
}

export function Bookmarks({ book, onBack }: Props) {
  const books = useBooks()
  const rows = useLiveQuery(() => (book === undefined ? db().bookmarks.toArray() : listBookmarks(book.id)), [book?.id])
  const colours = useSetting(ARTICLE_COLOURS_KEY, sanitizeArticleColours)
  const [query, setQuery] = useState('')
  /** The row whose Delete is uncovered, if any; one at a time. */
  const [openId, setOpenId] = useState<string | null>(null)

  const groups = useMemo(() => (rows === undefined || books === undefined ? [] : groupBookmarks(rows, books)), [rows, books])
  const shown = useMemo(() => filterGroups(groups, query), [groups, query])
  const scoped = book === undefined ? undefined : books?.find((b) => b.id === book.id)
  const now = Date.now()

  const jump = (row: BookmarkRow) => {
    location.hash = readHash(row.bookId, row.payload.chapter, row.id)
  }
  const remove = (row: BookmarkRow) => {
    setOpenId((id) => (id === row.id ? null : id))
    removeBookmark(row.id).catch((err: unknown) => console.error('could not remove the bookmark', err))
  }

  return (
    <div class="screen">
      <header class="top-bar top-bar--settings top-bar--bookmarks">
        <button type="button" class="back-btn" aria-label={scoped === undefined ? 'Back to Library' : `Back to ${scoped.title}`} onClick={onBack}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M15 4.5 7.5 12l7.5 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="back-label">{scoped === undefined ? 'Library' : scoped.title}</span>
        </button>
        <h1 class="large-title">Bookmarks</h1>
        <label class="bm-search">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2" />
            <path d="m15.5 15.5 5 5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
          </svg>
          <input
            type="search"
            placeholder="Search"
            aria-label="Search bookmarks"
            autocomplete="off"
            value={query}
            onInput={(e) => {
              setQuery((e.currentTarget as HTMLInputElement).value)
              setOpenId(null)
            }}
          />
          {query !== '' && (
            <button type="button" class="bm-search-clear" aria-label="Clear search" onClick={() => setQuery('')}>
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <circle cx="12" cy="12" r="10" fill="currentColor" />
                <path d="m8.5 8.5 7 7m0-7-7 7" fill="none" stroke="var(--bg-elev)" stroke-width="2" stroke-linecap="round" />
              </svg>
            </button>
          )}
        </label>
      </header>

      <main
        class="content content--bookmarks"
        onClick={(e) => {
          // A tap on the page outside the rows shuts the open one.
          if ((e.target as Element | null)?.closest('.swipe') === null) setOpenId(null)
        }}
      >
        {rows === undefined || books === undefined ? null : rows.length === 0 ? (
          <div class="empty">
            <svg class="empty-ribbon" viewBox="0 0 24 24" width="44" height="44" aria-hidden="true">
              <path d="M6.5 3.5h11v17l-5.5-4.5-5.5 4.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
            </svg>
            <p class="empty-title">No bookmarks yet</p>
            <p class="empty-sub">Tap Bookmark on a sentence or word card while reading, and it is kept here.</p>
          </div>
        ) : shown.length === 0 ? (
          <p class="bm-none" role="status">
            No bookmarks match “{query.trim()}”.
          </p>
        ) : (
          shown.map((g) => (
            <Group key={g.book.id} group={g} showBook={book === undefined} colours={colours} now={now} openId={openId} onOpen={setOpenId} onJump={jump} onDelete={remove} />
          ))
        )}
      </main>
    </div>
  )
}

interface GroupProps {
  group: BookmarkGroup
  /** Head the group with the book; off when the screen shows one book only. */
  showBook: boolean
  colours: ArticleColours
  now: number
  openId: string | null
  onOpen: (id: string | null) => void
  onJump: (row: BookmarkRow) => void
  onDelete: (row: BookmarkRow) => void
}

function Group({ group, showBook, colours, now, openId, onOpen, onJump, onDelete }: GroupProps) {
  const { book, rows } = group
  const lang = book.langs[0]
  return (
    <section class="bm-group" aria-label={book.title}>
      {showBook && (
        <header class="bm-group-head">
          <Cover title={book.title} author={book.author} colours={book.cover} class="cover-bm" />
          <div class="bm-group-text">
            <h2 class="bm-book">{book.title}</h2>
            <p class="bm-book-sub">
              {book.author} · {countLabel(rows.length)}
            </p>
          </div>
        </header>
      )}
      <ul class="bm-list group">
        {rows.map((row) => (
          <SwipeRow
            key={row.id}
            open={openId === row.id}
            onOpenChange={(open) => onOpen(open ? row.id : openId === row.id ? null : openId)}
            onDelete={() => onDelete(row)}
            onTap={() => onJump(row)}
            label={rowLabel(row)}
          >
            <Row row={row} book={book} lang={lang} colours={colours} now={now} />
          </SwipeRow>
        ))}
      </ul>
    </section>
  )
}

/** The row's accessible name: what was bookmarked, and where. */
function rowLabel(row: BookmarkRow): string {
  const where = row.payload.heading === '' ? '' : `, ${row.payload.heading}`
  if (row.type === 'word') return `${wordHeadline(row.payload).lemma}${where}`
  return `${row.payload.text}${where}`
}

interface RowProps {
  row: BookmarkRow
  book: Book
  lang: string
  colours: ArticleColours
  now: number
}

function Row({ row, book, lang, colours, now }: RowProps) {
  const meta = [row.payload.heading, dateLabel(row.created, now)].filter((s) => s !== '').join(' · ')
  if (row.type === 'sentence') {
    const p = row.payload
    return (
      <>
        <p class="bm-text" lang={lang}>
          {p.text}
        </p>
        {p.translationText !== '' && (
          <p class="bm-sub" lang={book.langs[1]}>
            {p.translationText}
          </p>
        )}
        <p class="bm-meta">{meta}</p>
      </>
    )
  }
  const p = row.payload
  const { article, lemma } = wordHeadline(p)
  const gloss = wordGloss(p)
  return (
    <>
      <p class="bm-text bm-text--word">
        <span lang={lang}>
          {article !== null && <span class={`bm-article word-article--${articleColour(article, colours)}`}>{article.text} </span>}
          <span class="bm-lemma">{lemma}</span>
        </span>
        {gloss !== '' ? <span class="bm-gloss"> {gloss}</span> : p.lemma === null && <span class="bm-gloss bm-gloss--none"> No entry</span>}
      </p>
      {p.sentenceText !== '' && (
        <p class="bm-sub" lang={lang}>
          {p.sentenceText}
        </p>
      )}
      <p class="bm-meta">{meta}</p>
    </>
  )
}
