import { render } from 'preact'
import './index.css'
import { App } from './app.tsx'
import { registerServiceWorker, requestPersistentStorage } from './pwa/register'

render(<App />, document.getElementById('app')!)

registerServiceWorker()
requestPersistentStorage()
