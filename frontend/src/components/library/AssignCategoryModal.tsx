import React, { useState, useEffect } from "react"
import { apiFetch } from "@/lib/api"
import { Check, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Book } from "@/components/library/BookCard"
import type { CategoryItem } from "@/components/library/CategoryFilterBar"

interface AssignCategoryModalProps {
  book: Book | null
  categories: CategoryItem[]
  isOpen: boolean
  onClose: () => void
  onSaved: (bookId: string, updatedCategoryNames: string[]) => void
  /** Optional: lets the dialog create a collection inline. */
  onCategoryCreated?: (newCategory: CategoryItem) => void
}

/**
 * Kindle "Add to Collection" dialog.
 * Square checkboxes, ink border, Cancel / Done footer.
 * Time Complexity: O(C) where C = number of categories.
 */
export const AssignCategoryModal: React.FC<AssignCategoryModalProps> = React.memo(
  ({ book, categories, isOpen, onClose, onSaved, onCategoryCreated }) => {
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
    const [saving, setSaving] = useState(false)
    const [errorMessage, setErrorMessage] = useState<string | null>(null)
    const [newName, setNewName] = useState("")
    const [creating, setCreating] = useState(false)

    // Sync initial selection only when a different book is opened,
    // so creating a collection doesn't wipe the user's ticks.
    const bookId = book?.id
    useEffect(() => {
      if (!book) return
      setErrorMessage(null)
      setNewName("")
      const bookCatNames = new Set(book.categories || [])
      const initialIds = new Set<string>()
      for (const cat of categories) {
        if (bookCatNames.has(cat.name)) initialIds.add(cat.id)
      }
      setSelectedIds(initialIds)
    }, [bookId]) // intentionally keyed on the book id only

    // Escape closes the dialog
    useEffect(() => {
      if (!isOpen) return
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") onClose()
      }
      document.addEventListener("keydown", onKey)
      return () => document.removeEventListener("keydown", onKey)
    }, [isOpen, onClose])

    if (!isOpen || !book) return null

    const toggleCategory = (catId: string) => {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(catId)) next.delete(catId)
        else next.add(catId)
        return next
      })
    }

    const handleCreate = async (e: React.FormEvent) => {
      e.preventDefault()
      const trimmed = newName.trim()
      if (!trimmed || !onCategoryCreated) return
      setCreating(true)
      setErrorMessage(null)
      try {
        const res = await apiFetch("/api/categories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        })
        if (res.ok) {
          const created: CategoryItem = await res.json()
          onCategoryCreated(created)
          setSelectedIds((prev) => new Set(prev).add(created.id))
          setNewName("")
        } else {
          setErrorMessage((await res.text()) || `Couldn't create collection (${res.status})`)
        }
      } catch (err: any) {
        setErrorMessage(`Could not reach the server: ${err?.message || err}`)
      } finally {
        setCreating(false)
      }
    }

    const handleSave = async () => {
      setSaving(true)
      setErrorMessage(null)
      try {
        const res = await apiFetch(`/api/books/${book.id}/categories`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category_ids: Array.from(selectedIds) }),
        })

        if (res.ok) {
          // Backend returns the names it actually saved, e.g. ["Fiction", "Rust"]
          let savedNames: string[]
          try {
            savedNames = await res.json()
          } catch {
            // Older backend that returns an empty 200 — fall back to local mapping
            savedNames = categories
              .filter((c) => selectedIds.has(c.id))
              .map((c) => c.name)
          }
          onSaved(book.id, savedNames)
          onClose()
        } else {
          const errText = await res.text()
          setErrorMessage(`Couldn't save (${res.status}): ${errText || res.statusText}`)
        }
      } catch (err: any) {
        setErrorMessage(`Could not reach the server: ${err?.message || err}`)
      } finally {
        setSaving(false)
      }
    }

    return (
      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-to-collection-title"
          className="bg-popover text-popover-foreground border border-foreground w-full sm:max-w-md select-none"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-4 border-b border-rule">
            <div className="min-w-0">
              <h2 id="add-to-collection-title" className="font-serif text-xl font-bold">
                Add to Collection
              </h2>
              <p className="text-sm text-muted-foreground mt-0.5 truncate font-serif italic">
                {book.title}
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

          {/* Collections */}
          <ul className="max-h-[50vh] overflow-y-auto">
            {categories.length === 0 ? (
              <li className="text-sm text-muted-foreground text-center py-8 px-5">
                No collections yet.
              </li>
            ) : (
              categories.map((cat) => {
                const isChecked = selectedIds.has(cat.id)
                return (
                  <li key={cat.id} className="border-b border-rule last:border-b-0">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={isChecked}
                      onClick={() => toggleCategory(cat.id)}
                      className="w-full flex items-center gap-4 px-5 h-12 text-left hover:bg-accent"
                    >
                      <span
                        className={cn(
                          "w-5 h-5 border-2 border-foreground flex items-center justify-center shrink-0",
                          isChecked && "bg-foreground text-background"
                        )}
                      >
                        {isChecked && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
                      </span>
                      <span className="flex-1 text-[15px]">{cat.name}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {cat.book_count > 0 ? cat.book_count : ""}
                      </span>
                    </button>
                  </li>
                )
              })
            )}
          </ul>

          {/* Inline "Create new collection" */}
          {onCategoryCreated && (
            <form
              onSubmit={handleCreate}
              className="flex items-center gap-2 px-5 py-3 border-t border-rule"
            >
              <Plus className="w-4 h-4 text-muted-foreground shrink-0" />
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Create new collection"
                className="flex-1 h-9 bg-transparent text-[15px] placeholder:text-muted-foreground focus:outline-none border-b border-transparent focus:border-foreground"
              />
              {newName.trim() && (
                <Button type="submit" size="sm" variant="outline" disabled={creating}>
                  {creating ? "…" : "Create"}
                </Button>
              )}
            </form>
          )}

          {errorMessage && (
            <div
              role="alert"
              className="mx-5 mb-3 p-2.5 border-2 border-foreground text-sm"
            >
              {errorMessage}
            </div>
          )}

          {/* Footer */}
          <div className="grid grid-cols-2 border-t border-foreground">
            <button
              type="button"
              onClick={onClose}
              className="h-12 text-[15px] hover:bg-accent border-r border-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="h-12 text-[15px] font-bold eink-selected hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Done"}
            </button>
          </div>
        </div>
      </div>
    )
  }
)

AssignCategoryModal.displayName = "AssignCategoryModal"
