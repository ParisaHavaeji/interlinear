/**
 * Reader preferences in the `settings` table (plan §2): one row per key, the value as stored.
 * Step 24 keeps the article colours here, step 28 the aA menu's choices (`reader/appearance.ts`).
 * Every read goes through a `sanitize` function so a stale or malformed row falls back to the
 * default rather than breaking a screen.
 */

import { useLiveQuery } from './hooks.ts'
import { db } from './db.ts'

export const ARTICLE_COLOURS_KEY = 'articleColours'
export const APPEARANCE_KEY = 'appearance'

/** The stored value of a setting, or `fallback` when there is none. */
export async function getSetting<T>(key: string, sanitize: (value: unknown) => T): Promise<T> {
  const row = await db().settings.get(key)
  return sanitize(row?.value)
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db().settings.put({ key, value })
}

/** The setting's value, live: re-renders when it is changed anywhere. `fallback` until it loads. */
export function useSetting<T>(key: string, sanitize: (value: unknown) => T): T {
  const value = useLiveQuery(() => getSetting(key, sanitize), [key])
  return value === undefined ? sanitize(undefined) : value
}
