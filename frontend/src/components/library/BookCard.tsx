import React from "react"
import { EllipsisVertical } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ReadingProgressBar } from "@/components/reading/ReadingProgressBar"

export interface BookProgress {
  current_page: number
  total_pages: number
  progress_percent: number
}

export interface Book {
  id: string
  title: string
  file_name: string
  /** Path inside the library folder, e.g. "Programming/Rust.pdf" */
  rel_path?: string
  folder_id?: number
  format: "pdf" | "epub"
  progress?: BookProgress
  categories?: string[]
}

interface BookCardProps {
  book: Book
  onSelect: (book: Book) => void
  onManageCategories?: (book: Book) => void
  variant?: "grid" | "list"
}

/**
 * Kindle library item.
 *  - grid: bare cover with hairline border, "NEW" corner tag for unread books,
 *          title + thin progress line underneath.
 *  - list: small cover, title, collections, percent on the right.
 * The ⋮ button opens "Add to collection", like Kindle's long-press menu.
 */
export const BookCard: React.FC<BookCardProps> = React.memo(
  ({ book, onSelect, onManageCategories, variant = "grid" }) => {
    const progressPercent = book.progress?.progress_percent ?? 0
    const isNew = !book.progress || progressPercent <= 0
    const categories = book.categories ?? []
    // "Programming/Rust/Book.pdf" → "Programming/Rust"
    const subfolder = book.rel_path?.includes("/")
      ? book.rel_path.slice(0, book.rel_path.lastIndexOf("/"))
      : null

    const menuButton = onManageCategories && (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onManageCategories(book)
        }}
        className="w-8 h-8 shrink-0 flex items-center justify-center hover:bg-accent"
        title="Add to collection"
        aria-label={`Add “${book.title}” to collection`}
      >
        <EllipsisVertical className="w-4 h-4" />
      </button>
    )

    const cover = (
      <img
        src={`/api/books/${book.id}/cover`}
        alt=""
        className="w-full h-full object-cover grayscale-[15%]"
        loading="lazy"
        draggable={false}
      />
    )

    if (variant === "list") {
      return (
        <div className="group flex items-center gap-4 py-3 border-b border-rule">
          <button
            type="button"
            onClick={() => onSelect(book)}
            className="flex flex-1 min-w-0 items-center gap-4 text-left"
          >
            <div className="relative w-12 aspect-[2/3] shrink-0 border border-foreground/80 bg-card overflow-hidden">
              {cover}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-serif text-[15px] font-medium leading-snug line-clamp-2 group-hover:underline underline-offset-2">
                {book.title}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                <span className="uppercase tracking-wide">{book.format}</span>
                {subfolder && <> · {subfolder}</>}
                {categories.length > 0 && <> · {categories.join(", ")}</>}
              </p>
            </div>
            <div className="w-20 sm:w-32 shrink-0 text-right">
              {isNew ? (
                <Badge variant="kindle">New</Badge>
              ) : (
                <ReadingProgressBar percent={progressPercent} showLabel />
              )}
            </div>
          </button>
          {menuButton}
        </div>
      )
    }

    return (
      <div className="group flex flex-col">
        <button
          type="button"
          onClick={() => onSelect(book)}
          className="relative aspect-[2/3] w-full border border-foreground/80 bg-card overflow-hidden"
          aria-label={`Open ${book.title}`}
        >
          {cover}

          {/* Kindle corner tags */}
          {isNew && (
            <Badge variant="kindle" className="absolute top-0 right-0">
              New
            </Badge>
          )}
          <Badge variant="kindle" className="absolute bottom-0 left-0">
            {book.format}
          </Badge>

          {/* e-ink "pressed" feedback: a frame, not a lift */}
          <span className="pointer-events-none absolute inset-0 ring-0 group-hover:ring-2 ring-inset ring-foreground" />
        </button>

        <div className="mt-2 flex items-start gap-1">
          <button
            type="button"
            onClick={() => onSelect(book)}
            className="flex-1 min-w-0 text-left"
          >
            <h3 className="font-serif text-[13px] leading-snug line-clamp-2">
              {book.title}
            </h3>
          </button>
          <div className="-mr-2 -mt-1">{menuButton}</div>
        </div>

        <div className="mt-1.5 min-h-[18px]">
          {!isNew && <ReadingProgressBar percent={progressPercent} showLabel={false} />}
          {!isNew && (
            <span className="block text-[11px] text-muted-foreground mt-1 tabular-nums">
              {progressPercent >= 100 ? "Read" : `${Math.round(progressPercent)}%`}
            </span>
          )}
        </div>
      </div>
    )
  }
)

BookCard.displayName = "BookCard"
