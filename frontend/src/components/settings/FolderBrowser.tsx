import React, { useCallback, useEffect, useState } from "react"
import { ChevronRight, CornerLeftUp, Folder, X } from "lucide-react"
import { apiFetch, readError, type BrowseResult } from "@/lib/api"

interface FolderBrowserProps {
  onClose: () => void
  /** Called with the chosen absolute path. Return an error message to keep the dialog open. */
  onSelect: (path: string) => Promise<string | null>
}

/**
 * Kindle-style dialog for picking a folder on the server.
 * Click a folder to open it, "Up" to go to the parent, or type a path.
 */
export const FolderBrowser: React.FC<FolderBrowserProps> = ({ onClose, onSelect }) => {
  const [data, setData] = useState<BrowseResult | null>(null)
  const [pathInput, setPathInput] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = useCallback(async (path?: string) => {
    setLoading(true)
    setError(null)
    try {
      const query = path ? `?path=${encodeURIComponent(path)}` : ""
      const res = await apiFetch(`/api/fs/browse${query}`)
      if (res.ok) {
        const result: BrowseResult = await res.json()
        setData(result)
        setPathInput(result.path)
      } else {
        setError(await readError(res, `Can't open that folder (${res.status})`))
      }
    } catch {
      setError("Can't reach OpenShelf.")
    } finally {
      setLoading(false)
    }
  }, [])

  // Start in the server user's home folder
  useEffect(() => {
    open()
  }, [open])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  const choose = async () => {
    if (!data) return
    setSaving(true)
    setError(null)
    const problem = await onSelect(data.path)
    setSaving(false)
    if (problem) setError(problem)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-browser-title"
        className="bg-popover text-popover-foreground border border-foreground w-full sm:max-w-lg flex flex-col max-h-[90dvh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
          <div>
            <h2 id="folder-browser-title" className="font-serif text-xl font-bold">
              Choose a folder
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Books in this folder and its sub-folders will appear in your library.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 -mr-2 -mt-1 flex items-center justify-center hover:bg-accent shrink-0"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Path bar */}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            open(pathInput)
          }}
          className="flex border-y border-foreground"
        >
          <button
            type="button"
            onClick={() => data?.parent && open(data.parent)}
            disabled={!data?.parent || loading}
            className="h-11 w-11 flex items-center justify-center border-r border-foreground hover:bg-accent disabled:opacity-30 shrink-0"
            aria-label="Up one level"
            title="Up one level"
          >
            <CornerLeftUp className="w-4 h-4" />
          </button>
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            spellCheck={false}
            autoCapitalize="none"
            className="flex-1 min-w-0 h-11 px-3 bg-transparent text-sm font-mono focus:outline-none focus:bg-accent/50"
            aria-label="Folder path"
          />
          <button
            type="submit"
            className="h-11 px-4 border-l border-foreground text-sm font-medium hover:bg-accent shrink-0"
          >
            Go
          </button>
        </form>

        {/* Folder list */}
        <div className="flex-1 min-h-[240px] overflow-y-auto">
          {loading ? (
            <p className="text-sm text-muted-foreground text-center py-10">Loading…</p>
          ) : data && data.folders.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-10 px-5">
              No sub-folders here.
            </p>
          ) : (
            <ul>
              {data?.folders.map((f) => (
                <li key={f.path} className="border-b border-rule last:border-b-0">
                  <button
                    type="button"
                    onClick={() => open(f.path)}
                    className="w-full flex items-center gap-3 px-5 h-11 text-left hover:bg-accent"
                  >
                    <Folder className="w-4 h-4 shrink-0" />
                    <span className="flex-1 truncate text-[15px]">{f.name}</span>
                    <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <div role="alert" className="mx-5 my-3 p-2.5 border-2 border-foreground text-sm">
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="border-t border-foreground">
          {data && (
            <p className="px-5 pt-3 text-xs text-muted-foreground">
              {data.book_files > 0
                ? `${data.book_files} PDF/EPUB ${data.book_files === 1 ? "file" : "files"} directly in this folder`
                : "No PDF/EPUB files directly in this folder (sub-folders are scanned too)"}
            </p>
          )}
          <div className="grid grid-cols-2 mt-3 border-t border-foreground">
            <button
              type="button"
              onClick={onClose}
              className="h-12 text-[15px] hover:bg-accent border-r border-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={choose}
              disabled={!data || loading || saving}
              className="h-12 text-[15px] font-bold eink-selected hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Adding…" : "Use this folder"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
