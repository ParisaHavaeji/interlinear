// The three test pairs of plan.md §1.1 as the alignment pipeline wants them, loaded from disk
// for the Node tools (tools/gold.ts, tools/tune.ts) and the gold tests. The Gutenberg pairs are
// the committed fixtures; Demian is the two EPUBs in Input/, which are not in the repo, so
// callers check `havePair` first and skip when they are missing.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AlignRequest, AlignSide } from '../src/align/pipeline.ts'
import { parseEpub } from '../src/import/epub.ts'
import { flattenEpub } from '../src/import/file.ts'
import { parseTxt } from '../src/import/txt.ts'

export interface PairSpec {
  /** Pair id; the gold file is `tests/fixtures/<id>.gold.json`. */
  id: string
  title: string
  format: 'txt' | 'epub'
  /** Paths of the two texts, relative to the repository root. */
  de: string
  en: string
}

export const PAIRS: readonly PairSpec[] = [
  {
    id: 'kafka-verwandlung',
    title: 'Kafka, Die Verwandlung / Metamorphosis',
    format: 'txt',
    de: 'tests/fixtures/kafka-verwandlung.de.txt',
    en: 'tests/fixtures/kafka-verwandlung.en.txt',
  },
  {
    id: 'hesse-demian',
    title: 'Hesse, Demian (Calibre EPUB / Penguin Classics EPUB)',
    format: 'epub',
    de: 'Input/Demian (Hermann Hesse) (z-library.sk, 1lib.sk, z-lib.sk).epub',
    en: 'Input/Demian (Hermann Hesse) (z-library.sk, 1lib.sk, z-lib.sk) (2).epub',
  },
  {
    id: 'goethe-werther',
    title: 'Goethe, Die Leiden des jungen Werther / The Sorrows of Young Werther',
    format: 'txt',
    de: 'tests/fixtures/goethe-werther.de.txt',
    en: 'tests/fixtures/goethe-werther.en.txt',
  },
]

const ROOT = new URL('../', import.meta.url)

export function pairPath(relative: string): string {
  return fileURLToPath(new URL(relative, ROOT))
}

export function pairById(id: string): PairSpec {
  const spec = PAIRS.find((p) => p.id === id)
  if (spec === undefined) throw new Error(`Unknown pair "${id}"; one of ${PAIRS.map((p) => p.id).join(', ')}`)
  return spec
}

/** True when both files of the pair are on disk. */
export function havePair(spec: PairSpec): boolean {
  return existsSync(pairPath(spec.de)) && existsSync(pairPath(spec.en))
}

async function loadSide(spec: PairSpec, file: string): Promise<AlignSide> {
  const path = pairPath(file)
  if (spec.format === 'txt') return { paragraphs: parseTxt(readFileSync(path, 'utf8')), sections: [] }
  const book = await parseEpub(readFileSync(path))
  const text = flattenEpub(book, file)
  return { paragraphs: text.paragraphs, sections: text.sections }
}

/** Both sides of a pair as an {@link AlignRequest} (without options). */
export async function loadPair(spec: PairSpec): Promise<AlignRequest> {
  return { de: await loadSide(spec, spec.de), en: await loadSide(spec, spec.en) }
}
