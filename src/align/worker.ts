/**
 * The alignment Web Worker (plan §1.2, step 12): runs the pipeline off the main thread so the
 * Library stays responsive while a novel aligns. One message in, progress messages out, then a
 * result or an error. `worker-runner.ts` creates one worker per book and terminates it
 * afterwards, which is also how a cancelled job stops; the dictionary (Phase 4) will be loaded
 * here once it exists.
 *
 * A request with `neural: true` (step 15, "Re-align with high accuracy") takes the long way:
 * plan the book, load the language model (`neural-model.ts` is imported only then, so the
 * classical path never downloads it), embed the sentences of the paired chapters, and run the
 * two passes with the semantic feature. The progress bar is shared out as 0–5% planning, 5–15%
 * model download (instant once cached), 15–85% embedding, 85–95% the passes.
 */

import { embedSentences } from './neural.ts'
import { alignBook, alignPlanned, pairedSentences, planBook, type AlignRequest, type AlignResult, type AlignStage } from './pipeline.ts'
import type { WorkerRequest, WorkerResponse } from './worker-runner.ts'

const post = (message: WorkerResponse) => self.postMessage(message)
const report = (stage: AlignStage, fraction: number) => post({ type: 'progress', progress: { stage, fraction } })

self.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const { data } = event
  if (data?.type !== 'align') return
  try {
    const result = data.request.neural
      ? await alignWithModel(data.request)
      : alignBook(data.request, null, (progress) => post({ type: 'progress', progress }))
    post({ type: 'done', result })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
})

async function alignWithModel(request: AlignRequest): Promise<AlignResult> {
  const plan = planBook(request, (p) => report(p.stage, p.fraction / 3))
  report('model', 0.05)
  const [{ loadEmbedder }, { ORT_WASM_PATHS }] = await Promise.all([import('./neural-model.ts'), import('./neural-wasm.ts')])
  const embedder = await loadEmbedder({
    device: 'wasm',
    wasmPaths: ORT_WASM_PATHS,
    onDownload: (fraction) => report('model', 0.05 + 0.1 * fraction),
  })
  try {
    report('embed', 0.15)
    const embeddings = await embedSentences(embedder, pairedSentences(plan), {
      onProgress: (done, total) => report('embed', 0.15 + 0.7 * (total === 0 ? 1 : done / total)),
    })
    return alignPlanned(plan, null, (p) => report(p.stage, 0.85 + ((p.fraction - 0.15) / 0.8) * 0.1), embeddings)
  } finally {
    await embedder.dispose?.()
  }
}
