/**
 * The alignment Web Worker (plan §1.2, step 12): runs {@link alignBook} off the main thread so
 * the Library stays responsive while a novel aligns. One message in, progress messages out,
 * then a result or an error. `worker-runner.ts` creates one worker per book and terminates it
 * afterwards; the dictionary (Phase 4) will be loaded here once it exists.
 */

import { alignBook } from './pipeline.ts'
import type { WorkerRequest, WorkerResponse } from './worker-runner.ts'

const post = (message: WorkerResponse) => self.postMessage(message)

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const { data } = event
  if (data?.type !== 'align') return
  try {
    const result = alignBook(data.request, null, (progress) => post({ type: 'progress', progress }))
    post({ type: 'done', result })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
})
