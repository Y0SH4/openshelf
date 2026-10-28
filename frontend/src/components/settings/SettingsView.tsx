import React, { useCallback, useEffect, useState } from "react"
import { ArrowLeft, Folder, FolderPlus, FolderX, LogOut, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { apiFetch, readError, type LibraryFolder } from "@/lib/api"
import { FolderBrowser } from "@/components/settings/FolderBrowser"
import type { ThemeMode } from "@/components/library/LibraryHeader"

interface SettingsViewProps {
  username: string
  theme: ThemeMode
  onThemeChange: (theme: ThemeMode) => void
  onBack: () => void
  onLogout: () => void
}

const THEMES: { id: ThemeMode; label: string; swatch: string }[] = [
  { id: "light", label: "White", swatch: "bg-[#f6f5f1] text-[#111]" },
  { id: "sepia", label: "Sepia", swatch: "bg-[#f1e6cf] text-[#2e2418]" },
  { id: "dark", label: "Black", swatch: "bg-[#0a0a0a] text-[#ddd]" },
]

const Section: React.FC<{ title: string; description?: string; children: React.ReactNode }> = ({
  title,
  description,
  children,
}) => (
  <section className="py-7 border-b border-rule last:border-b-0">
    <h2 className="font-serif text-xl font-bold">{title}</h2>
    {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
    <div className="mt-4">{children}</div>
  </section>
)

/**
 * Kindle-style Settings page: library folders, page color, account.
 */
export const SettingsView: React.FC<SettingsViewProps> = ({
  username,
  theme,
  onThemeChange,
  onBack,
  onLogout,
}) => {
  const [folders, setFolders] = useState<LibraryFolder[] | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null)
  const [scanning, setScanning] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadFolders = useCallback(async () => {
    try {
      const res = await apiFetch("/api/library/folders")
      if (res.ok) setFolders(await res.json())
      else setError(await readError(res, "Couldn't load library folders"))
    } catch {
      setError("Can't reach OpenShelf.")
    }
  }, [])

  useEffect(() => {
    loadFolders()
  }, [loadFolders])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !browsing) onBack()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onBack, browsing])

  // Returns an error message for the browser dialog, or null on success
  const addFolder = async (path: string): Promise<string | null> => {
    try {
      const res = await apiFetch("/api/library/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      })
      if (!res.ok) return await readError(res, `Couldn't add folder (${res.status})`)
      const updated: LibraryFolder[] = await res.json()
      setFolders(updated)
      setBrowsing(false)
      const added = updated.find((f) => f.path === path)
      setError(null)
      setMessage(
        added
          ? `Added ${path} — ${added.book_count} ${added.book_count === 1 ? "book" : "books"} found.`
          : `Added ${path}.`
      )
      return null
    } catch {
      return "Can't reach OpenShelf."
    }
  }

  const removeFolder = async (id: number) => {
    setConfirmRemove(null)
    try {
      const res = await apiFetch(`/api/library/folders/${id}`, { method: "DELETE" })
      if (res.ok) {
        setFolders(await res.json())
        setError(null)
        setMessage("Folder removed. Your files and reading progress were not touched.")
      } else {
        setError(await readError(res, "Couldn't remove folder"))
      }
    } catch {
      setError("Can't reach OpenShelf.")
    }
  }

  const rescan = async () => {
    setScanning(true)
    setMessage(null)
    try {
      const res = await apiFetch("/api/library/scan", { method: "POST" })
      if (res.ok) {
        const { book_count }: { book_count: number } = await res.json()
        setMessage(`Scan complete — ${book_count} ${book_count === 1 ? "book" : "books"} in your library.`)
        await loadFolders()
      } else {
        setError(await readError(res, "Scan failed"))
      }
    } catch {
      setError("Can't reach OpenShelf.")
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      {/* Toolbar */}
      <div className="sticky top-0 z-30 bg-background border-b border-foreground">
        <div className="max-w-3xl mx-auto px-2 sm:px-6 h-14 flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="h-10 px-2 flex items-center gap-1.5 hover:bg-accent text-sm font-medium"
            title="Back to Library (Esc)"
          >
            <ArrowLeft className="w-5 h-5" />
            Library
          </button>
        </div>
      </div>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 pb-16">
        <h1 className="font-serif text-3xl sm:text-4xl font-bold tracking-tight pt-7 pb-2">
          Settings
        </h1>

        {(message || error) && (
          <div
            role={error ? "alert" : "status"}
            className={cn("mt-3 p-3 text-sm border", error ? "border-2 border-foreground" : "border-rule")}
          >
            {error ?? message}
          </div>
        )}

        <Section
          title="Library folders"
          description="OpenShelf scans these folders (and their sub-folders) for PDF and EPUB files."
        >
          {folders === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : folders.length === 0 ? (
            <div className="border border-dashed border-foreground/60 p-6 text-center">
              <p className="font-serif text-lg">No folders yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Add the folder where you keep your e-books.
              </p>
            </div>
          ) : (
            <ul className="border-t border-foreground">
              {folders.map((f) => (
                <li key={f.id} className="flex items-center gap-3 py-3 border-b border-rule">
                  {f.available ? (
                    <Folder className="w-5 h-5 shrink-0" />
                  ) : (
                    <FolderX className="w-5 h-5 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-sm truncate" title={f.path}>
                      {f.path}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {f.available
                        ? `${f.book_count} ${f.book_count === 1 ? "book" : "books"}`
                        : "Folder not found on the server"}
                    </p>
                  </div>
                  {confirmRemove === f.id ? (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => removeFolder(f.id)}
                        className="h-8 px-3 text-xs font-bold eink-selected"
                      >
                        Remove
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmRemove(null)}
                        className="h-8 px-3 text-xs border border-foreground hover:bg-accent"
                      >
                        Keep
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmRemove(f.id)}
                      className="h-8 px-3 text-xs border border-foreground/70 hover:bg-accent shrink-0"
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap gap-2 mt-4">
            <button
              type="button"
              onClick={() => {
                setMessage(null)
                setBrowsing(true)
              }}
              className="h-10 px-4 flex items-center gap-2 eink-selected text-sm font-semibold hover:opacity-90"
            >
              <FolderPlus className="w-4 h-4" />
              Add folder
            </button>
            {folders && folders.length > 0 && (
              <button
                type="button"
                onClick={rescan}
                disabled={scanning}
                className="h-10 px-4 flex items-center gap-2 border border-foreground text-sm font-medium hover:bg-accent disabled:opacity-50"
              >
                <RefreshCw className={cn("w-4 h-4", scanning && "animate-spin")} />
                {scanning ? "Scanning…" : "Scan now"}
              </button>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            New files show up automatically within a minute. Use “Scan now” to see them right away.
          </p>
        </Section>

        <Section title="Page color">
          <div className="grid grid-cols-3 gap-2 max-w-sm">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onThemeChange(t.id)}
                aria-pressed={theme === t.id}
                className={cn(
                  "flex flex-col items-center gap-1.5 py-3 border",
                  theme === t.id ? "border-foreground border-2" : "border-rule"
                )}
              >
                <span
                  className={cn(
                    "w-10 h-10 border border-black/30 flex items-center justify-center font-serif",
                    t.swatch
                  )}
                >
                  Aa
                </span>
                <span className="text-xs">{t.label}</span>
              </button>
            ))}
          </div>
        </Section>

        <Section title="Account">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                Signed in as
              </p>
              <p className="text-[15px] font-medium truncate">{username}</p>
            </div>
            <button
              type="button"
              onClick={onLogout}
              className="h-10 px-4 flex items-center gap-2 border border-foreground text-sm font-medium hover:bg-accent shrink-0"
            >
              <LogOut className="w-4 h-4" />
              Sign out
            </button>
          </div>
        </Section>
      </main>

      {browsing && <FolderBrowser onClose={() => setBrowsing(false)} onSelect={addFolder} />}
    </div>
  )
}
