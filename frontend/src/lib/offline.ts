/**
 * Books saved for offline reading, and reading progress waiting to be sent.
 *
 * Book files live in Cache Storage ("openshelf-books", next to the service
 * worker's caches), keyed by their /api/books/{id}/raw URL. A small list in
 * localStorage remembers titles and sizes for the UI. Progress made without
 * a connection is queued in localStorage and sent when the server is back.
 */
import { useEffect, useState } from "react"
import { apiFetch } from "@/lib/api"

const BOOKS_CACHE = "openshelf-books"
const LIST_KEY = "openshelf_offline_books"
const PROGRESS_KEY = "openshelf_pending_progress"
export const OFFLINE_CHANGED_EVENT = "openshelf:offline-changed"

export interface OfflineBook {
  id: string
  title: string
  bytes: number
  savedAt: number
}

export interface PendingProgress {
  current_page: number
  total_pages: number
  at: number
}

const rawUrl = (id: string) => `/api/books/${id}/raw`

/** Cache Storage needs HTTPS (or localhost). */
export const offlineSupported = () => typeof caches !== "undefined" && window.isSecureContext

function readJson<T>(key: string): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") as T
  } catch {
    return {} as T
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore
  }
}

export function offlineBooks(): Record<string, OfflineBook> {
  return readJson<Record<string, OfflineBook>>(LIST_KEY)
}

function setOfflineBooks(list: Record<string, OfflineBook>) {
  writeJson(LIST_KEY, list)
  window.dispatchEvent(new Event(OFFLINE_CHANGED_EVENT))
}

/** Downloads a book into the offline cache. `onProgress` gets 0–1 when the size is known. */
export async function saveBookOffline(
  book: { id: string; title: string },
  onProgress?: (ratio: number | null) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!offlineSupported()) throw new Error("Offline reading needs OpenShelf to be opened over HTTPS.")
  // Ask the browser not to clear saved books when space runs low
  void navigator.storage?.persist?.().catch(() => false)

  const res = await apiFetch(rawUrl(book.id), { signal })
  if (!res.ok || !res.body) throw new Error(`Couldn't download the book (${res.status})`)
  const total = Number(res.headers.get("Content-Length")) || 0
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    onProgress?.(total ? loaded / total : null)
  }
  const blob = new Blob(chunks as BlobPart[], {
    type: res.headers.get("Content-Type") ?? "application/pdf",
  })
  const cache = await caches.open(BOOKS_CACHE)
  await cache.put(
    rawUrl(book.id),
    new Response(blob, {
      headers: { "Content-Type": blob.type, "Content-Length": String(blob.size) },
    })
  )
  setOfflineBooks({
    ...offlineBooks(),
    [book.id]: { id: book.id, title: book.title, bytes: blob.size, savedAt: Date.now() },
  })
}

export async function removeBookOffline(id: string): Promise<void> {
  if (offlineSupported()) await (await caches.open(BOOKS_CACHE)).delete(rawUrl(id))
  const list = offlineBooks()
  delete list[id]
  setOfflineBooks(list)
}

/** The saved file of a book, or null if it isn't saved on this device. */
export async function offlineBookData(id: string): Promise<ArrayBuffer | null> {
  if (!offlineSupported() || !offlineBooks()[id]) return null
  const res = await (await caches.open(BOOKS_CACHE)).match(rawUrl(id))
  return res ? res.arrayBuffer() : null
}

/** Clears everything kept on this device (on sign-out). */
export async function clearOfflineData(): Promise<void> {
  try {
    localStorage.removeItem(LIST_KEY)
    localStorage.removeItem(PROGRESS_KEY)
  } catch {
    // ignore
  }
  if (typeof caches !== "undefined") {
    await Promise.all([caches.delete(BOOKS_CACHE), caches.delete("openshelf-api")])
  }
  navigator.serviceWorker?.controller?.postMessage({ type: "clear-user-data" })
  window.dispatchEvent(new Event(OFFLINE_CHANGED_EVENT))
}

/** Saved books, kept up to date across components. */
export function useOfflineBooks(): Record<string, OfflineBook> {
  const [list, setList] = useState(offlineBooks)
  useEffect(() => {
    const update = () => setList(offlineBooks())
    window.addEventListener(OFFLINE_CHANGED_EVENT, update)
    window.addEventListener("storage", update)
    return () => {
      window.removeEventListener(OFFLINE_CHANGED_EVENT, update)
      window.removeEventListener("storage", update)
    }
  }, [])
  return list
}

/** Whether the browser thinks it has a network connection. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener("online", on)
    window.addEventListener("offline", off)
    return () => {
      window.removeEventListener("online", on)
      window.removeEventListener("offline", off)
    }
  }, [])
  return online
}

// ---------------------------------------------------------------------------
// Reading progress made offline
// ---------------------------------------------------------------------------

export function pendingProgress(): Record<string, PendingProgress> {
  return readJson<Record<string, PendingProgress>>(PROGRESS_KEY)
}

export function queueProgress(bookId: string, currentPage: number, totalPages: number) {
  writeJson(PROGRESS_KEY, {
    ...pendingProgress(),
    [bookId]: { current_page: currentPage, total_pages: totalPages, at: Date.now() },
  })
}

function dropPending(bookId: string, at: number) {
  const list = pendingProgress()
  // Keep it if newer progress was queued while this one was being sent
  if (list[bookId]?.at === at) {
    delete list[bookId]
    writeJson(PROGRESS_KEY, list)
  }
}

let flushing: Promise<number> | null = null

/** Sends queued progress. Resolves with how many books were updated. */
export function flushPendingProgress(): Promise<number> {
  flushing ??= (async () => {
    let sent = 0
    for (const [bookId, p] of Object.entries(pendingProgress())) {
      try {
        const res = await apiFetch(`/api/books/${bookId}/progress`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ current_page: p.current_page, total_pages: p.total_pages }),
        })
        // 404: the book is gone from the library; 400: page out of range now
        if (res.ok || res.status === 404 || res.status === 400) {
          dropPending(bookId, p.at)
          if (res.ok) sent++
        }
      } catch {
        break // still offline
      }
    }
    return sent
  })().finally(() => {
    flushing = null
  })
  return flushing
}

export const formatBytes = (bytes: number) =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
