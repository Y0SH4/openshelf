/**
 * fetch() untuk API OpenShelf.
 * - Mengirim cookie session (same-origin).
 * - Jika server menjawab 401 (session habis / logout di tab lain), memberi tahu
 *   App lewat event agar layar login ditampilkan lagi.
 */
export const UNAUTHORIZED_EVENT = "openshelf:unauthorized"

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, { credentials: "same-origin", ...init })
  if (res.status === 401 && !input.startsWith("/api/auth/")) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  }
  return res
}

/** Pesan error dari server (teks), atau fallback jika kosong. */
export async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const text = (await res.text()).trim()
    return text || fallback
  } catch {
    return fallback
  }
}

export interface AuthStatus {
  setup_required: boolean
  user: { username: string } | null
}

/** A folder the library scans (GET /api/library/folders). */
export interface LibraryFolder {
  id: number
  path: string
  /** false when the folder is missing on the server (e.g. drive unplugged) */
  available: boolean
  book_count: number
}

/** One level of the server folder browser (GET /api/fs/browse). */
export interface BrowseResult {
  path: string
  parent: string | null
  folders: { name: string; path: string }[]
  /** PDF/EPUB files directly inside this folder */
  book_files: number
}
