// Gold alignments (plan.md step 13) from the command line.
//
//   node tools/gold.ts dump <pair> [--n 150] [--out <dir>]
//       Align the pair with the current defaults and write <pair>.draft.json (the first N beads
//       in gold format, uncorrected) and <pair>.review.txt (the same beads with their texts, one
//       block per bead) to --out. Read the review, fix the draft's beads by hand, then:
//   node tools/gold.ts build <pair> <draft.json>
//       Validate the corrected draft (every sentence covered once, in order) and write
//       tests/fixtures/<pair>.gold.json with fresh sentence hashes.
//   node tools/gold.ts score [<pair> ...]
//       Align each pair and grade it against its gold file, printing recall, precision and the
//       beads that went wrong (with their texts, to the console only).
//
// Pairs: kafka-verwandlung, hesse-demian, goethe-werther (see tools/pairs.ts).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AlignedBead } from '../src/align/beads.ts'
import { goldFromBeads, scoreGold, validateGoldBeads, withSentenceHashes, type GoldFile } from '../src/align/gold.ts'
import { alignBook, type AlignResult } from '../src/align/pipeline.ts'
import type { ParagraphSentence } from '../src/align/sentences.ts'
import { havePair, loadPair, pairById, pairPath, PAIRS, type PairSpec } from './pairs.ts'

const args = process.argv.slice(2)
const command = args[0]
const positional = args.slice(1).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--')))
const option = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const goldPath = (spec: PairSpec) => pairPath(`tests/fixtures/${spec.id}.gold.json`)

async function align(spec: PairSpec): Promise<AlignResult> {
  if (!havePair(spec)) throw new Error(`${spec.id}: files missing (${spec.de}, ${spec.en})`)
  const request = await loadPair(spec)
  return alignBook(request)
}

function textOf(sentences: readonly ParagraphSentence[], idx: readonly number[]): string {
  const byIdx = new Map(sentences.map((s) => [s.idx, s.text]))
  return idx.map((i) => byIdx.get(i) ?? `<missing ${i}>`).join(' ‖ ')
}

function describeBead(result: AlignResult, b: { de: readonly number[]; en: readonly number[]; confidence?: number }, label: string): string {
  const shape = `${b.de.length}-${b.en.length}`
  const conf = b.confidence === undefined ? '' : `  conf ${b.confidence.toFixed(2)}`
  return [
    `#${label}  ${shape}  de[${b.de.join(',')}] en[${b.en.join(',')}]${conf}`,
    `  DE: ${textOf(result.sentences.de, b.de) || '∅'}`,
    `  EN: ${textOf(result.sentences.en, b.en) || '∅'}`,
  ].join('\n')
}

async function dump(spec: PairSpec): Promise<void> {
  const n = Number(option('--n') ?? 150)
  const outDir = resolve(option('--out') ?? '.')
  mkdirSync(outDir, { recursive: true })
  const result = await align(spec)
  const draft = goldFromBeads(spec.id, { de: spec.de, en: spec.en }, result.sentences, result.beads, n)
  const review = result.beads
    .slice(0, n)
    .map((b, k) => describeBead(result, { de: b.deSentenceIdx, en: b.enSentenceIdx, confidence: b.confidence }, String(k)))
    .join('\n\n')
  writeFileSync(join(outDir, `${spec.id}.draft.json`), JSON.stringify({ book: draft.book, beads: draft.beads }, null, 0).replace(/\},\{/g, '},\n{') + '\n')
  writeFileSync(join(outDir, `${spec.id}.review.txt`), review + '\n')
  console.log(`${spec.id}: ${result.beads.length} beads in ${result.stats.elapsedMs} ms; first ${n} written to ${outDir}`)
}

async function build(spec: PairSpec, draftPath: string): Promise<void> {
  const draft = JSON.parse(readFileSync(resolve(draftPath), 'utf8')) as Pick<GoldFile, 'beads' | 'notes'>
  const result = await align(spec)
  // A gap in the gold is fine where the aligner itself beads nothing (headings, front matter).
  const beaded = { de: new Set(result.beads.flatMap((b) => b.deSentenceIdx)), en: new Set(result.beads.flatMap((b) => b.enSentenceIdx)) }
  const problems = validateGoldBeads(draft.beads, (side, idx) => beaded[side].has(idx))
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  const gold = withSentenceHashes(
    {
      book: spec.id,
      sources: { de: spec.de, en: spec.en },
      notes:
        draft.notes ??
        `First ${draft.beads.length} beads of the paired text, hand-checked against the two editions. ` +
          'Sentence hashes are FNV-1a of the sentence text; a mismatch means the splitter changed and the file needs re-checking.',
      sentences: { de: {}, en: {} },
      beads: draft.beads,
    },
    result.sentences,
  )
  const out = goldPath(spec)
  writeFileSync(out, JSON.stringify(gold, null, 2) + '\n')
  const score = scoreGold(result.beads, gold)
  console.log(`${spec.id}: ${gold.beads.length} gold beads written to ${out}; current recall ${(100 * score.recall).toFixed(1)}%`)
}

async function score(specs: readonly PairSpec[]): Promise<void> {
  for (const spec of specs) {
    if (!havePair(spec)) {
      console.log(`${spec.id}: skipped (files missing)`)
      continue
    }
    const gold = JSON.parse(readFileSync(goldPath(spec), 'utf8')) as GoldFile
    const result = await align(spec)
    const s = scoreGold(result.beads, gold)
    console.log(
      `${spec.id}: recall ${(100 * s.recall).toFixed(1)}% (${s.correct}/${s.gold}), precision ${(100 * s.precision).toFixed(1)}% (${s.correct}/${s.predicted}), ${result.stats.elapsedMs} ms`,
    )
    for (const m of s.missed) console.log('  missed  ' + describeBead(result, m, 'gold').replace(/\n/g, '\n  '))
    for (const b of s.spurious) {
      const bead: AlignedBead = b
      console.log('  spurious ' + describeBead(result, { de: bead.deSentenceIdx, en: bead.enSentenceIdx, confidence: bead.confidence }, 'pred').replace(/\n/g, '\n  '))
    }
  }
}

switch (command) {
  case 'dump':
    await dump(pairById(positional[0]))
    break
  case 'build':
    await build(pairById(positional[0]), positional[1])
    break
  case 'score':
    await score(positional.length === 0 ? PAIRS : positional.map(pairById))
    break
  default:
    console.error('usage: node tools/gold.ts dump <pair> [--n 150] [--out <dir>] | build <pair> <draft.json> | score [<pair> ...]')
    process.exit(1)
}
