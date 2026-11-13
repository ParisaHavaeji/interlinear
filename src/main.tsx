import { render } from 'preact'
import './index.css'
import { setDefaultRunner } from './align/jobs.ts'
import { workerRunner } from './align/worker-runner.ts'
import { App } from './app.tsx'
import { ensureDictionary } from './dict/installer.ts'
import { installOverscrollGuard } from './pwa/overscroll-guard.ts'
import { registerServiceWorker, requestPersistentStorage } from './pwa/register'
import { claimOAuthCallback, startSync } from './sync/browser.ts'

// Alignment runs in a Web Worker in the browser; the queue itself is platform-free.
setDefaultRunner(workerRunner)

// A page that came back from Google sign-in (plan.md step 36) carries `?code=`: take it out of
// the URL before the shell reads its route, then finish the sign-in once the shell has painted.
const oauth = claimOAuthCallback()

render(<App />, document.getElementById('app')!)

registerServiceWorker()
requestPersistentStorage()
installOverscrollGuard()
void startSync(oauth)

// The dictionary's first-run download (plan.md step 23), once the shell has painted. On
// every later launch this is one look at the cache, and a check for a newer version online.
setTimeout(() => void ensureDictionary(), 1000)
