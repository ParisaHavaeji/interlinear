// Build the dictionary shards of plan.md step 21 into public/dict/:
//
//   node tools/build-dict/main.ts [--out <dir>] [--cache <dir>] [--limit <n>] [--no-freedict]
//                                 [--wiktionary <file.jsonl[.gz]>] [--freedict <file.tei|.tar.xz>]
//
// Downloads the kaikki.org German extract of the English Wiktionary (~100 MB gzipped; kaikki
// calls these per-language files deprecated, so if the URL ever dies the replacement is the
// all-languages raw-wiktextract-data.jsonl.gz filtered to lang_code "de") and the FreeDict
// deu-eng source archive (~17 MB, unpacked with `tar`, which handles .xz on Linux, macOS and
// Windows 10+) into the cache (node_modules/.cache/interlinear-dict by default) and
// reuses them on the next run; --wiktionary / --freedict point at local copies instead. The
// sources are streamed through tools/build-dict/{wiktionary,freedict,builder}.ts and written
// as gzipped shards plus index.json (format: src/dict/format.ts). Stale shards in the output
// directory are removed first. --limit reads only the first n Wiktionary lines, for a quick
// look at the output. public/dict/ is not committed: CI builds it (see .github/workflows).
import { execFileSync } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'
import type { DictSource } from '../../src/dict/format.ts'
import { DictionaryBuilder, encodeShards } from './builder.ts'
import { parseTeiEntry, TeiEntrySplitter } from './freedict.ts'
import { parseWiktionaryLine } from './wiktionary.ts'

const WIKTIONARY_URL = 'https://kaikki.org/dictionary/German/kaikki.org-dictionary-German.jsonl.gz'
const FREEDICT_VERSION = '1.9-fd1'
const FREEDICT_URL = `https://download.freedict.org/dictionaries/deu-eng/${FREEDICT_VERSION}/freedict-deu-eng-${FREEDICT_VERSION}.src.tar.xz`
/** Path of the TEI file inside the FreeDict archive. */
const FREEDICT_TEI = 'deu-eng/deu-eng.tei'

const args = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const outDir = resolve(option('--out') ?? fileURLToPath(new URL('../../public/dict/', import.meta.url)))
const cacheDir = resolve(option('--cache') ?? fileURLToPath(new URL('../../node_modules/.cache/interlinear-dict/', import.meta.url)))
const limit = option('--limit') !== undefined ? Number(option('--limit')) : Infinity
const withFreeDict = !args.includes('--no-freedict')
const t0 = Date.now()

const log = (msg: string): void => console.error(`[build-dict ${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`)
const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`

/** Download `url` into the cache unless it is there already; returns the local path. */
async function fetchCached(url: string): Promise<string> {
  const file = join(cacheDir, url.slice(url.lastIndexOf('/') + 1))
  if (existsSync(file)) {
    log(`using cached ${file} (${mb(statSync(file).size)})`)
    return file
  }
  mkdirSync(cacheDir, { recursive: true })
  log(`downloading ${url}`)
  const res = await fetch(url, { headers: { 'user-agent': 'interlinear-build-dict' } })
  if (!res.ok || res.body === null) throw new Error(`${url}: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  let got = 0
  let nextReport = 0
  const partial = `${file}.part`
  const body = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>)
  body.on('data', (chunk: Buffer) => {
    got += chunk.length
    if (total > 0 && got >= nextReport) {
      log(`  ${mb(got)} of ${mb(total)}`)
      nextReport += total / 10
    }
  })
  await pipeline(body, createWriteStream(partial))
  renameSync(partial, file)
  // The file's mtime records the source's own date, which index.json reports as its version.
  const modified = res.headers.get('last-modified')
  if (modified !== null && !Number.isNaN(Date.parse(modified))) utimesSync(file, new Date(), new Date(modified))
  log(`saved ${file} (${mb(got)})`)
  return file
}

/** The TEI file of a FreeDict source archive, unpacked into the cache with `tar`. */
function unpackFreeDict(archive: string): string {
  if (archive.endsWith('.tei')) return archive
  const tei = join(cacheDir, FREEDICT_TEI)
  if (existsSync(tei)) return tei
  log(`unpacking ${archive}`)
  try {
    execFileSync('tar', ['-xJf', archive, '-C', cacheDir, FREEDICT_TEI], { stdio: 'inherit' })
  } catch (err) {
    throw new Error(`could not unpack ${archive} with tar (is tar with xz support installed?): ${(err as Error).message}`)
  }
  if (!existsSync(tei)) throw new Error(`${archive} did not contain ${FREEDICT_TEI}`)
  return tei
}

async function main(): Promise<void> {
  const builder = new DictionaryBuilder()
  const sources: DictSource[] = []

  // 1. Wiktionary.
  const wiktFile = option('--wiktionary') ?? (await fetchCached(WIKTIONARY_URL))
  sources.push({ name: 'wiktionary', url: WIKTIONARY_URL, version: statSync(wiktFile).mtime.toISOString().slice(0, 10) })
  log(`reading ${wiktFile}`)
  const raw = createReadStream(wiktFile)
  const input = wiktFile.endsWith('.gz') ? raw.pipe(createGunzip()) : raw
  const skipped = new Map<string, number>()
  let lines = 0
  let entries = 0
  let links = 0
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (lines >= limit) break
    lines++
    if (line.trim() === '') continue
    const parsed = parseWiktionaryLine(line)
    if (parsed.entry !== null) {
      builder.addWiktionary(parsed.entry)
      entries++
    }
    if (parsed.links.length > 0) {
      builder.addLinks(parsed.links)
      links += parsed.links.length
    }
    if (parsed.skipped !== undefined) skipped.set(parsed.skipped, (skipped.get(parsed.skipped) ?? 0) + 1)
    if (lines % 100000 === 0) log(`  ${lines} lines, ${entries} entries, ${links} links`)
  }
  raw.destroy()
  log(`wiktionary: ${lines} lines → ${entries} entries, ${links} form links`)
  const top = [...skipped].sort((a, b) => b[1] - a[1]).slice(0, 12)
  log(`  skipped: ${top.map(([k, n]) => `${k} ${n}`).join(', ')}`)

  // 2. FreeDict.
  if (withFreeDict) {
    const archive = option('--freedict') ?? (await fetchCached(FREEDICT_URL))
    const tei = unpackFreeDict(archive)
    sources.push({ name: 'freedict', url: FREEDICT_URL, version: FREEDICT_VERSION })
    log(`reading ${tei}`)
    const splitter = new TeiEntrySplitter()
    let seen = 0
    let kept = 0
    for await (const chunk of createReadStream(tei, { encoding: 'utf8', highWaterMark: 1 << 20 })) {
      for (const xml of splitter.push(chunk as string)) {
        seen++
        const entry = parseTeiEntry(xml)
        if (entry === null) continue
        kept++
        builder.addFreeDict(entry)
      }
    }
    log(`freedict: ${seen} entries → ${kept} one-word entries`)
  }

  // 3. Shards.
  const { shards, stats } = builder.build()
  log(`merged: ${stats.lemmas} lemmas, ${stats.entries} entries, ${stats.forms} forms; ${stats.danglingLinks} dangling links dropped; freedict merged ${stats.freedictMerged}, added ${stats.freedictAdded}`)
  const { files, index } = encodeShards(shards, stats, sources)

  mkdirSync(outDir, { recursive: true })
  for (const name of readdirSync(outDir)) {
    if (/^[a-z_]{2}\.json\.gz$/.test(name) || name === 'index.json') rmSync(join(outDir, name))
  }
  for (const [name, gz] of files) writeFileSync(join(outDir, name), gz)
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n')
  const largest = Object.entries(index.shards).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 5)
  log(`wrote ${files.size} shards, ${mb(index.stats.bytes)} gzipped, version ${index.version} → ${outDir}`)
  log(`  largest: ${largest.map(([k, s]) => `${k} ${mb(s.bytes)}`).join(', ')}`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})
