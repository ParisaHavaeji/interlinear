// Downloads the Gutenberg test pairs (plan.md step 6) into tests/fixtures/ with the
// Gutenberg header, licence and title-page boilerplate stripped.
//
//   node tools/fetch-fixtures.ts [--cache <dir>] [--out <dir>]
//
// --cache keeps the raw downloads (pg<id>.txt) and reuses them on the next run.
// The stripped fixtures are committed, so this only needs re-running to change the manifest
// in tools/gutenberg.ts or to pick up a corrected Gutenberg edition.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURES, gutenbergUrl, joinParts, stripGutenberg } from './gutenberg.ts'

const args = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const outDir = resolve(option('--out') ?? fileURLToPath(new URL('../tests/fixtures/', import.meta.url)))
const cacheOption = option('--cache')
const cacheDir = cacheOption ? resolve(cacheOption) : undefined

async function fetchText(id: number): Promise<string> {
  const cached = cacheDir ? join(cacheDir, `pg${id}.txt`) : undefined
  if (cached && existsSync(cached)) return readFileSync(cached, 'utf8')
  const url = gutenbergUrl(id)
  const res = await fetch(url, { headers: { 'user-agent': 'interlinear-fixtures' } })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const text = await res.text()
  if (cached && cacheDir) {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(cached, text)
  }
  return text
}

mkdirSync(outDir, { recursive: true })
for (const fixture of FIXTURES) {
  const parts: string[] = []
  for (const part of fixture.parts) {
    parts.push(stripGutenberg(await fetchText(part.id), { startAt: part.startAt }))
  }
  const text = joinParts(parts)
  writeFileSync(join(outDir, fixture.file), text)
  const words = text.split(/\s+/).filter(Boolean).length
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim()).length
  const ids = fixture.parts.map((p) => `#${p.id}`).join(' + ')
  console.log(`${fixture.file.padEnd(26)} ${ids.padEnd(14)} ${paragraphs} paragraphs, ${words} words`)
}
console.log(`written to ${outDir}`)
