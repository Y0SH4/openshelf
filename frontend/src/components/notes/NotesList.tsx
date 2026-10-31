import React, { useCallback, useEffect, useState } from "react"
import { Plus } from "lucide-react"
import { apiFetch } from "@/lib/api"
import { cn } from "@/lib/utils"
import { createNote, formatNoteDate, plainExcerpt, type NoteSummary } from "@/lib/notes"

interface NotesListProps {
  onOpen: (id: number) => void
  /** Title for new notes, e.g. the book being read */
  newNoteTitle?: string
  /** "page": card grid; "panel": one column for the reader's side panel */
  variant: "page" | "panel"
}

/** Notes as cards, most recently edited first. */
export const NotesList: React.FC<NotesListProps> = ({ onOpen, newNoteTitle = "", variant }) => {
  const [notes, setNotes] = useState<NoteSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/notes")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setNotes(await res.json())
    } catch (err) {
      console.error("Failed to load notes:", err)
      setError("Couldn't load your notes.")
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleCreate = async () => {
    setCreating(true)
    setError(null)
    try {
      onOpen(await createNote(newNoteTitle))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create a note.")
      setCreating(false)
    }
  }

  const isPanel = variant === "panel"

  return (
    <div className={cn(isPanel ? "py-4" : "pb-16")}>
      <button
        type="button"
        onClick={handleCreate}
        disabled={creating}
        className="h-10 px-4 flex items-center gap-2 eink-selected text-sm font-semibold hover:opacity-90 disabled:opacity-50"
      >
        <Plus className="w-4 h-4" />
        {creating ? "Creating…" : "New note"}
      </button>

      {error && (
        <p role="alert" className="mt-4 text-sm border border-foreground px-3 py-2">
          {error}
        </p>
      )}

      {!notes ? (
        !error && <p className="py-12 text-center text-sm text-muted-foreground">Loading notes…</p>
      ) : notes.length === 0 ? (
        <div className="mt-6 py-14 px-6 text-center border border-dashed border-foreground/60">
          <p className="font-serif text-xl font-bold">No notes yet</p>
          <p className="text-sm text-muted-foreground mt-2 max-w-sm mx-auto">
            Write down ideas from what you read. In the reader, select text on a page to quote
            it into a note.
          </p>
        </div>
      ) : (
        <ul
          className={cn(
            "mt-5 grid gap-4",
            isPanel ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
          )}
        >
          {notes.map((note) => {
            const excerpt = plainExcerpt(note.excerpt)
            return (
              <li key={note.id}>
                <button
                  type="button"
                  onClick={() => onOpen(note.id)}
                  className={cn(
                    "w-full h-full text-left border border-foreground p-4 flex flex-col hover:bg-accent",
                    !isPanel && "min-h-[9.5rem]"
                  )}
                >
                  <span
                    className={cn(
                      "font-serif text-lg font-bold leading-snug line-clamp-2",
                      !note.title && "text-muted-foreground"
                    )}
                  >
                    {note.title || "Untitled"}
                  </span>
                  {excerpt && (
                    <span className="mt-1.5 text-sm text-muted-foreground leading-relaxed line-clamp-3">
                      {excerpt}
                    </span>
                  )}
                  <span className="mt-auto pt-3 text-[11px] uppercase tracking-[0.12em] text-muted-foreground tabular-nums">
                    {formatNoteDate(note.updated_at)}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
