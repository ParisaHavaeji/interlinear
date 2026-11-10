import { render } from 'preact'
import './index.css'
import { setDefaultRunner } from './align/jobs.ts'
import { workerRunner } from './align/worker-runner.ts'
import { App } from './app.tsx'
import { registerServiceWorker, requestPersistentStorage } from './pwa/register'

// Alignment runs in a Web Worker in the browser; the queue itself is platform-free.
setDefaultRunner(workerRunner)

render(<App />, document.getElementById('app')!)

registerServiceWorker()
requestPersistentStorage()
