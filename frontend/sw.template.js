/* OpenShelf service worker. Built into dist/sw.js by the `serviceWorker`
 * plugin in vite.config.ts, which fills in VERSION and PRECACHE. */

const VERSION = "__VERSION__"
/** Every file of this build: the app opens without a connection */
const PRECACHE = __PRECACHE__

const APP_CACHE = `openshelf-app-${VERSION}`
/** Last good answers from the API (library, collections, notes…) */
const API_CACHE = "openshelf-api"
const FONT_CACHE = "openshelf-fonts"
/** Books saved for offline reading (filled by the page, see src/lib/offline.ts) */
const BOOKS_CACHE = "openshelf-books"

/** Give up on the server after this long and answer from the cache */
const NETWORK_TIMEOUT_MS = 4000

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(APP_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("openshelf-app-") && key !== APP_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener("message", (event) => {
  // Sign-out: don't leave the library or books on a shared device
  if (event.data?.type === "clear-user-data") {
    event.waitUntil(Promise.all([caches.delete(API_CACHE), caches.delete(BOOKS_CACHE)]))
  }
})

/** Read-only API answers worth keeping for offline use */
const CACHED_API = [
  /^\/api\/auth\/status$/,
  /^\/api\/books$/,
  /^\/api\/categories$/,
  /^\/api\/notes(\/\d+)?$/,
  /^\/api\/translate$/,
]

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const url = new URL(request.url)

  if (url.origin === "https://fonts.googleapis.com" || url.origin === "https://fonts.gstatic.com") {
    event.respondWith(staleWhileRevalidate(request, FONT_CACHE))
    return
  }
  if (url.origin !== self.location.origin) return

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, APP_CACHE, "/index.html"))
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request, APP_CACHE))
  } else if (/^\/api\/books\/[^/]+\/cover$/.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request, API_CACHE))
  } else if (CACHED_API.some((re) => re.test(url.pathname))) {
    event.respondWith(networkFirst(request, API_CACHE))
  } else if (!url.pathname.startsWith("/api/")) {
    event.respondWith(cacheFirst(request, APP_CACHE))
  }
  // Everything else (book files, saves…) goes straight to the server
})

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) (await caches.open(cacheName)).put(request, response.clone())
  return response
}

async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName)
  const network = fetch(request).then((response) => {
    // Only successful answers: a 401 must not hide the sign-in screen later
    if (response.ok) cache.put(request, response.clone())
    return response
  })
  try {
    return await withTimeout(network, NETWORK_TIMEOUT_MS)
  } catch {
    const cached =
      (await cache.match(request)) ?? (fallbackUrl ? await caches.match(fallbackUrl) : undefined)
    if (cached) return cached
    return network
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  const network = fetch(request)
    .then((response) => {
      if (response.ok || response.type === "opaque") cache.put(request, response.clone())
      return response
    })
    .catch(() => undefined)
  return cached ?? (await network) ?? Response.error()
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
