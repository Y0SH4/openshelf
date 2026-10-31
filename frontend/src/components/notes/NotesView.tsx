import React, { useEffect } from "react"
import { ArrowLeft } from "lucide-react"
import { NotesEditor } from "@/components/notes/NotesEditor"
import type { PageLink } from "@/lib/notes"

interface NotesViewProps {
  onBack: () => void
  onOpenPage: (link: PageLink) => boolean
}

/** The notes page, opened from the Library. */
export const NotesView: React.FC<NotesViewProps> = ({ onBack, onOpenPage }) => {
  // Esc leaves the editor first, then goes back to the Library
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      const active = document.activeElement as HTMLElement | null
      if (active?.isContentEditable) active.blur()
      else onBack()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onBack])

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
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

      <main className="max-w-3xl mx-auto px-4 sm:px-6">
        <h1 className="font-serif text-3xl sm:text-4xl font-bold tracking-tight pt-7 pb-3">
          Notes
        </h1>
        <NotesEditor onOpenPage={onOpenPage} toolbarClassName="sticky top-14 -mx-1" />
      </main>
    </div>
  )
}
