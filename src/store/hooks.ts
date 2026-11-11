/** Preact bindings for Dexie's `liveQuery` and the alignment job queue. */

import { liveQuery } from 'dexie'
import { useEffect, useMemo, useState } from 'preact/hooks'
import { getAlignmentJobs, subscribeAlignmentJobs, type AlignmentJob } from '../align/jobs.ts'
import type { Book, ProgressRow } from './db.ts'
import { listBooks } from './books.ts'
import { listProgress } from './progress.ts'

/**
 * Subscribe to a Dexie query. Returns `undefined` until the first result arrives.
 * `deps` re-subscribes like `useEffect` deps.
 */
export function useLiveQuery<T>(querier: () => Promise<T>, deps: readonly unknown[] = []): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined)
  useEffect(() => {
    const sub = liveQuery(querier).subscribe({
      next: (v) => setValue(() => v),
      error: (e) => console.error('liveQuery failed', e),
    })
    return () => sub.unsubscribe()
  }, deps)
  return value
}

/** All books, newest first; `undefined` while loading. */
export function useBooks(): Book[] | undefined {
  return useLiveQuery(() => listBooks(), [])
}

/** Every book's reading progress (step 29) by book id, live; `undefined` while loading. */
export function useProgress(): ReadonlyMap<string, ProgressRow> | undefined {
  const rows = useLiveQuery(() => listProgress(), [])
  return useMemo(() => (rows === undefined ? undefined : new Map(rows.map((r) => [r.bookId, r]))), [rows])
}

/** The alignment jobs queued or running, by book id; re-renders on every progress tick. */
export function useAlignmentJobs(): ReadonlyMap<string, AlignmentJob> {
  const [jobs, setJobs] = useState(getAlignmentJobs)
  useEffect(() => {
    setJobs(getAlignmentJobs())
    return subscribeAlignmentJobs(setJobs)
  }, [])
  return jobs
}
