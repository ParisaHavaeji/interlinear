// Guards the committed Gutenberg fixtures in tests/fixtures/ (plan.md step 6): they must be
// present, boilerplate-free, start at the right heading and parse into a plausible book.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseTxt } from '../src/import/txt.ts'
import { FIXTURES } from '../tools/gutenberg.ts'

const read = (file: string) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')

describe.each(FIXTURES)('fixture $file', (fixture) => {
  const text = read(fixture.file)

  it('starts at the configured heading and has no Gutenberg boilerplate', () => {
    const firstLine = text.slice(0, text.indexOf('\n'))
    expect(firstLine).toMatch(fixture.parts[0]!.startAt)
    expect(text).not.toMatch(/gutenberg/i)
    expect(text).not.toMatch(/\*\*\* (START|END) OF/)
    expect(text.startsWith('﻿')).toBe(false)
    expect(text.includes('\r')).toBe(false)
    expect(text.endsWith('\n')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(false)
  })

  it('contains every volume heading', () => {
    for (const part of fixture.parts) {
      expect(text.split('\n').some((l) => part.startAt.test(l.trim()))).toBe(true)
    }
  })

  it('parses into a book-sized list of paragraphs', () => {
    const paragraphs = parseTxt(text)
    const words = text.split(/\s+/).filter(Boolean).length
    // Kafka's novella is ~20k words in ~100 long paragraphs per side; Werther is ~40k words
    // in ~440 paragraphs.
    expect(paragraphs.length).toBeGreaterThan(80)
    expect(words).toBeGreaterThan(15_000)
    expect(words).toBeLessThan(80_000)
    for (const p of paragraphs) expect(p.text).not.toMatch(/\s{2,}/)
  })
})

describe('fixture pairs', () => {
  it('have a German side shorter in words but not wildly different from the English side', () => {
    const words = (file: string) => read(file).split(/\s+/).filter(Boolean).length
    for (const stem of ['kafka-verwandlung', 'goethe-werther']) {
      const ratio = words(`${stem}.en.txt`) / words(`${stem}.de.txt`)
      expect(ratio).toBeGreaterThan(1)
      expect(ratio).toBeLessThan(1.4)
    }
  })
})
