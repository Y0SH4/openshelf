import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Offline support (see sw.template.js). Needs HTTPS or localhost; not in
// `pnpm dev`, where the service worker would serve stale files.
if ("serviceWorker" in navigator && import.meta.env.PROD && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.error("Service worker registration failed:", err)
    })
  })
}
