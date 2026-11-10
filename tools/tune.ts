// Tune the aligner against the gold files (plan.md step 13).
//
//   node tools/tune.ts [--pairs kafka-verwandlung,hesse-demian,goethe-werther] [--rounds 2] [--quick]
//
// Coordinate descent over the feature weights (lexical, cognate, punctuation), the one-sided
// deletion scale and the Gale–Church variance: each knob in turn is set to every value of its
// grid while the others stay fixed, the best is kept, and the sweep repeats for `--rounds`
// rounds. The objective is the mean bead recall over the pairs (each pair counts once, so the
// three books weigh the same), with the total of correct beads as the tie-break. The script
// prints the baseline, every improvement, the final knobs and a confidence-threshold table
// (how many wrong and right beads fall at or below each threshold) for picking LOW_CONFIDENCE.
// Nothing is written: copy the winning values into features.ts / structure.ts by hand.
import { readFileSync } from 'node:fs'
import { DEFAULT_WEIGHTS, type FeatureWeights } from '../src/align/features.ts'
import { scoreGold, type GoldFile, type GoldScore } from '../src/align/gold.ts'
import { alignBook, type AlignBookOptions, type AlignRequest } from '../src/align/pipeline.ts'
import { havePair, loadPair, pairById, pairPath, PAIRS, type PairSpec } from './pairs.ts'

const args = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const rounds = Number(option('--rounds') ?? 2)
const quick = args.includes('--quick')
const wanted = option('--pairs')?.split(',').map(pairById) ?? PAIRS

interface Knobs {
  lexical: number
  cognate: number
  punctuation: number
  deletionScale: number
  variance: number
}

const GRID: Record<keyof Knobs, number[]> = quick
  ? { lexical: [2, 3, 4], cognate: [1, 1.5, 2], punctuation: [0.25, 0.5, 1], deletionScale: [50, 100, 200], variance: [6.8] }
  : {
      lexical: [0, 1, 2, 3, 4, 5, 6, 8],
      cognate: [0, 0.5, 1, 1.5, 2, 3, 4],
      punctuation: [0, 0.25, 0.5, 0.75, 1, 1.5, 2],
      deletionScale: [25, 50, 75, 100, 150, 200, 300, 500],
      variance: [3.4, 5, 6.8, 10, 13.6, 20],
    }

const BASELINE: Knobs = { ...DEFAULT_WEIGHTS, deletionScale: 100, variance: 6.8 }

function optionsOf(k: Knobs): AlignBookOptions {
  const weights: FeatureWeights = { lexical: k.lexical, cognate: k.cognate, punctuation: k.punctuation }
  return { weights, deletionScale: k.deletionScale, variance: k.variance }
}

interface Loaded {
  spec: PairSpec
  request: AlignRequest
  gold: GoldFile
}

const loaded: Loaded[] = []
for (const spec of wanted) {
  if (!havePair(spec)) {
    console.log(`${spec.id}: skipped (files missing)`)
    continue
  }
  const gold = JSON.parse(readFileSync(pairPath(`tests/fixtures/${spec.id}.gold.json`), 'utf8')) as GoldFile
  loaded.push({ spec, request: await loadPair(spec), gold })
}
if (loaded.length === 0) {
  console.error('no pairs to tune on')
  process.exit(1)
}

interface Evaluation {
  scores: GoldScore[]
  meanRecall: number
  correct: number
}

const cache = new Map<string, Evaluation>()
let evaluations = 0

function evaluate(k: Knobs): Evaluation {
  const key = JSON.stringify(k)
  const have = cache.get(key)
  if (have !== undefined) return have
  evaluations++
  const scores = loaded.map((l) => scoreGold(alignBook({ ...l.request, options: optionsOf(k) }).beads, l.gold))
  const e: Evaluation = {
    scores,
    meanRecall: scores.reduce((n, s) => n + s.recall, 0) / scores.length,
    correct: scores.reduce((n, s) => n + s.correct, 0),
  }
  cache.set(key, e)
  return e
}

const better = (a: Evaluation, b: Evaluation): boolean => a.meanRecall > b.meanRecall + 1e-9 || (Math.abs(a.meanRecall - b.meanRecall) < 1e-9 && a.correct > b.correct)

const pct = (x: number) => `${(100 * x).toFixed(1)}%`
function describe(e: Evaluation): string {
  return loaded.map((l, i) => `${l.spec.id} ${pct(e.scores[i].recall)} (${e.scores[i].correct}/${e.scores[i].gold})`).join('  ') + `  mean ${pct(e.meanRecall)}`
}
const knobText = (k: Knobs) => `lexical ${k.lexical}, cognate ${k.cognate}, punctuation ${k.punctuation}, deletionScale ${k.deletionScale}, variance ${k.variance}`

let best: Knobs = { ...BASELINE }
let bestEval = evaluate(best)
console.log(`baseline  ${knobText(best)}`)
console.log(`          ${describe(bestEval)}`)

for (let round = 1; round <= rounds; round++) {
  let improved = false
  for (const knob of Object.keys(GRID) as (keyof Knobs)[]) {
    for (const value of GRID[knob]) {
      if (value === best[knob]) continue
      const candidate = { ...best, [knob]: value }
      const e = evaluate(candidate)
      if (better(e, bestEval)) {
        best = candidate
        bestEval = e
        improved = true
        console.log(`round ${round}  ${knob} → ${value}: ${describe(e)}`)
      }
    }
  }
  if (!improved) {
    console.log(`round ${round}: no knob improves the score`)
    break
  }
}

console.log(`\nbest      ${knobText(best)}`)
console.log(`          ${describe(bestEval)}`)
console.log(`          ${evaluations} alignments of ${loaded.length} pair(s)`)

// Confidence threshold: how well does "confidence ≤ t" pick out the wrong beads?
console.log('\nthreshold  wrong≤t/wrong  right≤t/right  precision  recall  F1')
const judged = bestEval.scores.flatMap((s) => s.judged)
const wrong = judged.filter((j) => !j.correct)
const right = judged.filter((j) => j.correct)
for (const t of [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.97, 0.99]) {
  const flaggedWrong = wrong.filter((j) => j.bead.confidence <= t).length
  const flaggedRight = right.filter((j) => j.bead.confidence <= t).length
  const precision = flaggedWrong + flaggedRight === 0 ? 0 : flaggedWrong / (flaggedWrong + flaggedRight)
  const recall = wrong.length === 0 ? 1 : flaggedWrong / wrong.length
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  console.log(
    `${t.toFixed(2).padEnd(10)} ${`${flaggedWrong}/${wrong.length}`.padEnd(14)} ${`${flaggedRight}/${right.length}`.padEnd(14)} ${pct(precision).padEnd(10)} ${pct(recall).padEnd(7)} ${pct(f1)}`,
  )
}
