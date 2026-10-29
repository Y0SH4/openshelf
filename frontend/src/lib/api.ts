/**
 * fetch() for the OpenShelf API.
 * - Sends the session cookie (same-origin).
 * - If the server answers 401 (session expired / signed out in another tab),
 *   notifies App through an event so the sign-in screen is shown again.
 */
export const UNAUTHORIZED_EVENT = "openshelf:unauthorized"

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, { credentials: "same-origin", ...init })
  if (res.status === 401 && !input.startsWith("/api/auth/")) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  }
  return res
}

/** Error message from the server (text), or the fallback if empty. */
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
  /** Top-level folders the server allows choosing from (OPENSHELF_BROWSE_ROOTS) */
  roots: string[]
}
