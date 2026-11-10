/**
 * Alignment Layer D (plan §1.2, step 15): neural re-scoring of the sentence beads.
 *
 * A multilingual sentence-embedding model (`paraphrase-multilingual-MiniLM-L12-v2`, int8, run
 * locally by transformers.js in `neural-model.ts`) maps every German and English sentence to a
 * unit vector in which translations lie close together. The bead DP of step 10 gets one more
 * feature from it, **semantic similarity**: the cosine between the two sides of a bead, each
 * side pooled as the normalised sum of its sentences' vectors. Like the other overlap features
 * it costs `weight × (1 − similarity)` nats, scaled by the bead's size, so a one-sided bead pays
 * the full weight for its half pair and a translation pair pays almost nothing.
 *
 * The model only re-scores what Layer C already lets the DP choose between: the chapter pairs
 * and paragraph blocks are the same, the bead shapes are the same, and the classical features
 * stay in the sum. It cannot make an alignment structurally worse; it can only decide the beads
 * that length and dictionary evidence left open, which is where the remaining errors are.
 *
 * This module is the pure part: the {@link Embedder} contract, the vector arithmetic, the
 * batching that turns an embedder into {@link SentenceEmbeddings} keyed by `ParagraphSentence.idx`,
 * and the download-progress bookkeeping. It never imports the model library, so the tests
 * (`tests/neural.test.ts`) run it under Node with hand-made vectors. `neural-model.ts` loads the
 * real model; `worker.ts` runs the two together when a book is re-aligned with high accuracy.
 */

import type { ParagraphSentence } from './sentences.ts'

// ---------------------------------------------------------------------------------------------
// The model

/** Hugging Face id of the sentence-embedding model transformers.js downloads. */
export const MODEL_ID = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'
/** Weight precision: the 8-bit quantised ONNX export, about a quarter of the fp32 size. */
export const MODEL_DTYPE = 'q8'
/** Dimension of one sentence vector. */
export const EMBEDDING_DIM = 384
/** What the first download fetches, in megabytes (weights plus tokenizer), for the UI. */
export const MODEL_DOWNLOAD_MB = 135

/**
 * Nats of penalty for a bead whose two sides are semantically unrelated. Above the lexical
 * weight (5), because a translation pair scores 0.8–0.95 on this model where the dictionary
 * overlap of the same pair is often below 0.3. Checked against the gold files with the real
 * model (`node tools/neural.ts score`, weights 2–12): Kafka stays at 100% up to 9; Werther
 * goes from 95.9% to 97.3% at 5 and 6 and falls back below 95% from 7; Demian is 100% up to 3
 * and 98.7% from 4, the one disagreement being a clause the translator moved across a sentence
 * boundary, which the model beads as 2-2 (confidence 0.65) where the gold convention keeps two
 * 1-1 beads. The remaining Werther misses are its two one-sided gold beads; see the tests.
 */
export const SEMANTIC_WEIGHT = 6

/** Anything that turns sentences into unit vectors: the real model, or a stand-in in tests. */
export interface Embedder {
  /** One unit-length vector per text, in the same order. */
  embed(texts: readonly string[]): Promise<Float32Array[]>
  /** Free the model's memory. Optional; the alignment worker calls it when a book is done. */
  dispose?(): Promise<void> | void
}

// ---------------------------------------------------------------------------------------------
// Vector arithmetic

export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

/** The vector scaled to unit length; the zero vector stays zero. */
export function normalize(v: Float32Array): Float32Array {
  const norm = Math.sqrt(dot(v, v))
  const out = new Float32Array(v.length)
  if (norm === 0) return out
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm
  return out
}

/**
 * One side of a bead as a single unit vector: the normalised sum of its sentences' vectors, so
 * a German sentence rendered as two English ones meets the mean of the two. `null` for no
 * sentences.
 */
export function pooled(vectors: readonly Float32Array[]): Float32Array | null {
  if (vectors.length === 0) return null
  if (vectors.length === 1) return vectors[0]
  const sum = new Float32Array(vectors[0].length)
  for (const v of vectors) for (let i = 0; i < sum.length; i++) sum[i] += v[i]
  return normalize(sum)
}

/**
 * Semantic similarity of two sides of a bead, in [0, 1]: the cosine of their pooled vectors,
 * with the (rare, meaningless) negative cosines clamped to zero. Zero when a side is empty.
 */
export function sideSimilarity(a: readonly Float32Array[], b: readonly Float32Array[]): number {
  const pa = pooled(a)
  const pb = pooled(b)
  if (pa === null || pb === null) return 0
  return Math.min(1, Math.max(0, dot(pa, pb)))
}

// ---------------------------------------------------------------------------------------------
// Embedding a book

export interface EmbedOptions {
  /** Sentences per model call. Padding is to the longest text of a batch, so batches are formed over texts of similar length. */
  batchSize?: number
  /** Called after every batch with how many texts are done out of the total. */
  onProgress?: (done: number, total: number) => void
  /** Aborting stops before the next batch with an error named `AbortError`. */
  signal?: AbortSignal
}

export const DEFAULT_BATCH_SIZE = 16

function abortError(): Error {
  const err = new Error('Embedding cancelled')
  err.name = 'AbortError'
  return err
}

/**
 * Embed many texts through an {@link Embedder} in batches, longest texts first (so the slowest
 * batches come while the progress bar is at its most honest, and padding inside a batch is
 * small), returning the vectors in the order of `texts`.
 */
export async function embedTexts(embedder: Embedder, texts: readonly string[], options: EmbedOptions = {}): Promise<Float32Array[]> {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE)
  const order = texts.map((_, i) => i).sort((a, b) => texts[b].length - texts[a].length || a - b)
  const out: Float32Array[] = new Array(texts.length)
  options.onProgress?.(0, texts.length)
  for (let start = 0; start < order.length; start += batchSize) {
    if (options.signal?.aborted) throw abortError()
    const batch = order.slice(start, start + batchSize)
    const vectors = await embedder.embed(batch.map((i) => texts[i]))
    if (vectors.length !== batch.length) throw new Error(`The embedder returned ${vectors.length} vectors for ${batch.length} texts`)
    batch.forEach((i, k) => {
      out[i] = vectors[k]
    })
    options.onProgress?.(Math.min(texts.length, start + batch.length), texts.length)
  }
  return out
}

/**
 * Sentence vectors for the bead DP, keyed by `ParagraphSentence.idx` on each side (position in
 * the array; a sentence that was not embedded has no entry, and beads touching it are scored
 * classically).
 */
export interface SentenceEmbeddings {
  de: readonly (Float32Array | undefined)[]
  en: readonly (Float32Array | undefined)[]
}

/**
 * Embed the given sentences of both sides in one run (one progress total), placing each vector
 * at its sentence's `idx`. Pass only the sentences inside paired chapters: front matter and
 * unmatched chapters get no bead and need no vector.
 */
export async function embedSentences(
  embedder: Embedder,
  sentences: { de: readonly ParagraphSentence[]; en: readonly ParagraphSentence[] },
  options: EmbedOptions = {},
): Promise<SentenceEmbeddings> {
  const texts = [...sentences.de.map((s) => s.text), ...sentences.en.map((s) => s.text)]
  const vectors = await embedTexts(embedder, texts, options)
  const de: (Float32Array | undefined)[] = []
  const en: (Float32Array | undefined)[] = []
  sentences.de.forEach((s, k) => {
    de[s.idx] = vectors[k]
  })
  sentences.en.forEach((s, k) => {
    en[s.idx] = vectors[sentences.de.length + k]
  })
  return { de, en }
}

// ---------------------------------------------------------------------------------------------
// Download progress

/**
 * Turns the per-file progress events a model loader emits (several files, each reporting bytes
 * loaded of its total) into one fraction: bytes loaded over bytes expected across every file
 * seen so far. Files already in the cache report once with everything loaded, so a cached model
 * jumps straight to 1.
 */
export class DownloadTracker {
  private readonly files = new Map<string, { loaded: number; total: number }>()

  update(file: string, loaded: number, total: number): void {
    if (!(total > 0)) return
    this.files.set(file, { loaded: Math.min(loaded, total), total })
  }

  /** A file finished (its size may never have been reported). */
  done(file: string): void {
    const f = this.files.get(file)
    if (f !== undefined) f.loaded = f.total
    else this.files.set(file, { loaded: 1, total: 1 })
  }

  /** 0 before any size is known, 1 once every file seen is complete. */
  get fraction(): number {
    let loaded = 0
    let total = 0
    for (const f of this.files.values()) {
      loaded += f.loaded
      total += f.total
    }
    return total === 0 ? 0 : Math.min(1, loaded / total)
  }
}
