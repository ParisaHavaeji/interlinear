/**
 * The browser side of the alignment worker: the message protocol shared with `worker.ts` and
 * the {@link Runner} that spawns one module worker per book. Kept apart from `jobs.ts` so the
 * queue stays free of DOM types and runs under Node in the tests; `main.tsx` installs this
 * runner as the default at startup.
 */

import { AlignmentCancelled, type Runner } from './jobs.ts'
import type { AlignProgress, AlignRequest, AlignResult } from './pipeline.ts'

export interface WorkerRequest {
  type: 'align'
  request: AlignRequest
}

export type WorkerResponse =
  | { type: 'progress'; progress: AlignProgress }
  | { type: 'done'; result: AlignResult }
  | { type: 'error'; message: string }

/** Runs the pipeline in `worker.ts`, one worker per call, terminated when done or cancelled. */
export const workerRunner: Runner = (request, onProgress, signal) =>
  new Promise<AlignResult>((resolve, reject) => {
    if (signal.aborted) {
      reject(new AlignmentCancelled())
      return
    }
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    const finish = () => {
      signal.removeEventListener('abort', cancel)
      worker.terminate()
    }
    const cancel = () => {
      finish()
      reject(new AlignmentCancelled())
    }
    signal.addEventListener('abort', cancel)
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data
      if (msg.type === 'progress') onProgress(msg.progress)
      else if (msg.type === 'done') {
        finish()
        resolve(msg.result)
      } else {
        finish()
        reject(new Error(msg.message))
      }
    }
    worker.onerror = (event) => {
      finish()
      reject(new Error(event.message || 'The alignment worker failed'))
    }
    const message: WorkerRequest = { type: 'align', request }
    worker.postMessage(message)
  })
