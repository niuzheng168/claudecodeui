import React from 'react'
import ReactDOM from 'react-dom/client'
import { scan } from 'react-scan'

import '@/index.css'
import 'katex/dist/katex.min.css'
import { markWorkbenchFrame } from '@/shared/codeyWorkbench'
import { getPageTitle, withDeploymentBasePath } from '@/shared/utils'

// Initialize i18n
import '@/modules/i18n'

// Keep node identity visible during authentication/loading, before the sidebar mounts.
document.title = getPageTitle(null, null)

// React Scan is a render-diagnostics overlay, and an expensive one: measured on
// this app it roughly halves the dev frame rate, adds ~14 MB of heap and injects
// a few thousand DOM nodes of its own. It is worth all of that while hunting a
// render bug and worth none of it the rest of the time, so it is opt-in —
// `localStorage.setItem('react-scan', 'on')` and reload.
scan({ enabled: import.meta.env.DEV && localStorage.getItem('react-scan') === 'on' })

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Unable to mount the app: #root is missing from the document')
}

// The Codey Portal serves a session another user shared with the reader from
// this same template and sets these page parameters (codey
// docs/codey-shared-sessions.md §6). That page is only the shared session: no
// service worker, no router, and none of the workspace app is loaded.
const sharedSession = (window as Window & { __CODEY_SHARED_SESSION__?: unknown }).__CODEY_SHARED_SESSION__

if (sharedSession) {
  void import('@/modules/shared-session').then(({ mountSharedSessionPage }) => {
    mountSharedSessionPage(rootElement, sharedSession)
  })
} else {
  // Register service worker for PWA + Web Push support
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(withDeploymentBasePath('/sw.js')).catch(err => {
      console.warn('Service worker registration failed:', err);
    });
  }

  // The Workbench reads these at the frame's `load` event, before the app chunk
  // below has run, and posts a new session's directories right then; importing
  // the module here also keeps those until the app shows them.
  markWorkbenchFrame()

  // The app is its own chunk so the shared-session page does not download it.
  void import('@/App').then(({ default: App }) => {
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    )
  })
}
