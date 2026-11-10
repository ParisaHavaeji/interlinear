/** Preact bindings for Dexie's `liveQuery`: a component re-renders when the rows it reads change. */

import { liveQuery } from 'dexie'
import { useEffect, useState } from 'preact/hooks'
import type { Book } from './db.ts'
import { listBooks } from './books.ts'

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
