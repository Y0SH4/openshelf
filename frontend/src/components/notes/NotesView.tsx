import React, { useEffect } from "react"
import { ArrowLeft } from "lucide-react"
import { NotesEditor } from "@/components/notes/NotesEditor"
import { NotesList } from "@/components/notes/NotesList"
import { storeLastNoteId, type PageLink } from "@/lib/notes"

interface NotesViewProps {
  /** The open note, or null for the list of notes */
  noteId: number | null
  onOpenNote: (id: number | null) => void
  onBack: () => void
  onOpenPage: (link: PageLink) => boolean
}

/** Notes from the Library: cards of all notes, or one note open. */
export const NotesView: React.FC<NotesViewProps> = ({ noteId, onOpenNote, onBack, onOpenPage }) => {
  const showList = () => onOpenNote(null)

  useEffect(() => {
    if (noteId != null) storeLastNoteId(noteId)
  }, [noteId])

  // Esc leaves the editor first, then the note, then the notes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      const active = document.activeElement as HTMLElement | null
      if (active?.isContentEditable || active?.tagName === "TEXTAREA") active.blur()
      else if (noteId != null) onOpenNote(null)
      else onBack()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [noteId, onOpenNote, onBack])

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <div className="sticky top-0 z-30 bg-background border-b border-foreground">
        <div className="max-w-5xl mx-auto px-2 sm:px-6 h-14 flex items-center gap-2">
          <button
            type="button"
            onClick={noteId != null ? showList : onBack}
            className="h-10 px-2 flex items-center gap-1.5 hover:bg-accent text-sm font-medium"
            title={noteId != null ? "All notes (Esc)" : "Back to Library (Esc)"}
          >
            <ArrowLeft className="w-5 h-5" />
            {noteId != null ? "All notes" : "Library"}
          </button>
        </div>
      </div>

      {noteId != null ? (
        <main className="max-w-3xl mx-auto px-4 sm:px-6 pt-4">
          <NotesEditor
            key={noteId}
            noteId={noteId}
            onDeleted={() => {
              storeLastNoteId(null)
              showList()
            }}
            onOpenPage={onOpenPage}
            toolbarClassName="sticky top-14 -mx-1"
          />
        </main>
      ) : (
        <main className="max-w-5xl mx-auto px-4 sm:px-6">
          <h1 className="font-serif text-3xl sm:text-4xl font-bold tracking-tight pt-7 pb-5">
            Notes
          </h1>
          <NotesList variant="page" onOpen={onOpenNote} />
        </main>
      )}
    </div>
  )
}
