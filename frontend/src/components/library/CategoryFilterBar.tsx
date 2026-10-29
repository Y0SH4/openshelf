import React, { useState } from "react"
import { apiFetch } from "@/lib/api"
import { Plus, X } from "lucide-react"
import { cn } from "@/lib/utils"

export interface CategoryItem {
  id: string
  name: string
  book_count: number
}

interface CategoryFilterBarProps {
  categories: CategoryItem[]
  selectedCategory: string
  onSelectCategory: (categoryName: string) => void
  onCategoryCreated: (newCategory: CategoryItem) => void
  totalBooksCount: number
}

/**
 * Kindle "Collections" filter row.
 * Outlined square chips; the selected one is inverted (ink on paper → paper on ink).
 */
export const CategoryFilterBar: React.FC<CategoryFilterBarProps> = React.memo(
  ({
    categories,
    selectedCategory,
    onSelectCategory,
    onCategoryCreated,
    totalBooksCount,
  }) => {
    const [isCreating, setIsCreating] = useState(false)
    const [newCategoryName, setNewCategoryName] = useState("")
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const closeForm = () => {
      setIsCreating(false)
      setNewCategoryName("")
      setError(null)
    }

    const handleCreateCategory = async (e: React.FormEvent) => {
      e.preventDefault()
      const trimmed = newCategoryName.trim()
      if (!trimmed) return

      setSubmitting(true)
      setError(null)
      try {
        const res = await apiFetch("/api/categories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        })

        if (res.ok) {
          const created: CategoryItem = await res.json()
          onCategoryCreated(created)
          closeForm()
          onSelectCategory(created.name)
        } else {
          setError((await res.text()) || `Couldn't create collection (${res.status})`)
        }
      } catch (err) {
        console.error("Failed to create collection:", err)
        setError("Could not reach the server.")
      } finally {
        setSubmitting(false)
      }
    }

    const chip = (active: boolean) =>
      cn(
        "h-8 px-3 text-[13px] border shrink-0 flex items-center gap-2 whitespace-nowrap",
        active
          ? "eink-selected border-foreground font-semibold"
          : "border-foreground/70 hover:bg-accent"
      )

    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-4">
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-none pb-1">
          <span className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground mr-1 shrink-0">
            Collections
          </span>

          <button
            type="button"
            onClick={() => onSelectCategory("all")}
            aria-pressed={selectedCategory === "all"}
            className={chip(selectedCategory === "all")}
          >
            All
            <span className="tabular-nums opacity-70">{totalBooksCount}</span>
          </button>

          {categories.map((cat) => {
            const isSelected = selectedCategory === cat.name
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => onSelectCategory(cat.name)}
                aria-pressed={isSelected}
                className={chip(isSelected)}
              >
                {cat.name}
                {cat.book_count > 0 && (
                  <span className="tabular-nums opacity-70">{cat.book_count}</span>
                )}
              </button>
            )
          })}

          {isCreating ? (
            <form
              onSubmit={handleCreateCategory}
              className="flex items-center shrink-0 border border-foreground h-8"
            >
              <input
                type="text"
                placeholder="Collection name"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && closeForm()}
                autoFocus
                className="h-full w-40 px-2 bg-transparent text-[13px] focus:outline-none"
              />
              <button
                type="submit"
                disabled={submitting || !newCategoryName.trim()}
                className="h-full px-3 text-[13px] font-semibold eink-selected disabled:opacity-40"
              >
                {submitting ? "…" : "Add"}
              </button>
              <button
                type="button"
                onClick={closeForm}
                className="h-full w-8 flex items-center justify-center hover:bg-accent"
                aria-label="Cancel"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setIsCreating(true)}
              className="h-8 px-3 text-[13px] border border-dashed border-foreground/60 text-muted-foreground hover:text-foreground hover:bg-accent flex items-center gap-1.5 shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              New collection
            </button>
          )}
        </div>
        {error && <p className="text-xs mt-2 underline decoration-dotted">{error}</p>}
      </div>
    )
  }
)

CategoryFilterBar.displayName = "CategoryFilterBar"
