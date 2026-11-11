import { render } from 'preact'
import './index.css'
import { setDefaultRunner } from './align/jobs.ts'
import { workerRunner } from './align/worker-runner.ts'
import { App } from './app.tsx'
import { ensureDictionary } from './dict/installer.ts'
import { registerServiceWorker, requestPersistentStorage } from './pwa/register'

// Alignment runs in a Web Worker in the browser; the queue itself is platform-free.
setDefaultRunner(workerRunner)

render(<App />, document.getElementById('app')!)

registerServiceWorker()
requestPersistentStorage()

// The dictionary's first-run download (plan.md step 23), once the shell has painted. On
// every later launch this is one look at the cache, and a check for a newer version online.
setTimeout(() => void ensureDictionary(), 1000)
