import React from "react"
import { LayoutGrid, List, LogOut, Search, Settings, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { DisplayMenu } from "@/components/reading/DisplayMenu"

export type ThemeMode = "light" | "sepia" | "dark"
export type FormatFilter = "all" | "pdf" | "epub"
export type SortMode = "title" | "progress" | "file"
export type ViewMode = "grid" | "list"

interface LibraryHeaderProps {
  search: string
  onSearchChange: (value: string) => void
  formatFilter: FormatFilter
  onFormatFilterChange: (filter: FormatFilter) => void
  totalBooks: number
  filteredCount: number
  theme: ThemeMode
  onThemeChange: (theme: ThemeMode) => void
  sortMode: SortMode
  onSortChange: (sort: SortMode) => void
  viewMode: ViewMode
  onViewModeChange: (mode: ViewMode) => void
  username?: string
  onLogout?: () => void
  onOpenSettings?: () => void
}

const FORMAT_TABS: { id: FormatFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pdf", label: "PDF" },
  { id: "epub", label: "EPUB" },
]

const SORT_LABELS: Record<SortMode, string> = {
  title: "Title",
  progress: "Progress",
  file: "File name",
}

/**
 * Kindle Library header:
 *  - top toolbar (wordmark, search, Aa)
 *  - big "Library" heading
 *  - All / PDF / EPUB tabs underlined like Kindle's "All | Downloaded"
 *  - Sort + Grid/List switch on the right
 */
export const LibraryHeader: React.FC<LibraryHeaderProps> = React.memo(
  ({
    search,
    onSearchChange,
    formatFilter,
    onFormatFilterChange,
    totalBooks,
    filteredCount,
    theme,
    onThemeChange,
    sortMode,
    onSortChange,
    viewMode,
    onViewModeChange,
    username,
    onLogout,
    onOpenSettings,
  }) => {
    return (
      <>
        {/* Toolbar (sibling of <header> so it stays sticky for the whole page) */}
        <div className="sticky top-0 z-30 bg-background border-b border-foreground">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3">
            <span className="font-serif text-lg font-bold tracking-tight shrink-0">
              OpenShelf
            </span>

            <label className="relative flex-1 max-w-md ml-auto">
              <span className="sr-only">Search your library</span>
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <input
                type="search"
                placeholder="Search your library"
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                className="w-full h-10 pl-9 pr-9 bg-transparent border border-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-foreground [&::-webkit-search-cancel-button]:hidden"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => onSearchChange("")}
                  className="absolute right-1 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center hover:bg-accent"
                  aria-label="Clear search"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </label>

            {onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="h-10 w-10 flex items-center justify-center hover:bg-accent shrink-0"
                title="Settings"
                aria-label="Settings"
              >
                <Settings className="w-5 h-5" />
              </button>
            )}
            <DisplayMenu theme={theme} onThemeChange={onThemeChange}>
              {onLogout && (
                <>
                  <p className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground mb-1">
                    Account
                  </p>
                  {username && (
                    <p className="text-sm font-medium truncate mb-3">{username}</p>
                  )}
                  <button
                    type="button"
                    onClick={onLogout}
                    className="w-full h-10 flex items-center justify-center gap-2 border border-foreground text-sm font-medium hover:bg-accent"
                  >
                    <LogOut className="w-4 h-4" />
                    Sign out
                  </button>
                </>
              )}
            </DisplayMenu>
          </div>
        </div>

        <header>
        {/* Title */}
        <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-7 pb-2 flex items-end justify-between gap-4">
          <h1 className="font-serif text-3xl sm:text-4xl font-bold tracking-tight">
            Library
          </h1>
          <span className="text-xs text-muted-foreground pb-1.5 tabular-nums">
            {filteredCount === totalBooks
              ? `${totalBooks} ${totalBooks === 1 ? "item" : "items"}`
              : `${filteredCount} of ${totalBooks} items`}
          </span>
        </div>

        {/* Tabs + sort + view */}
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex items-center justify-between gap-4 border-b border-rule">
          <nav className="flex items-center gap-6" aria-label="Format">
            {FORMAT_TABS.map((tab) => {
              const active = formatFilter === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onFormatFilterChange(tab.id)}
                  aria-pressed={active}
                  className={cn(
                    "relative h-11 text-sm",
                    active
                      ? "font-bold text-foreground after:absolute after:left-0 after:right-0 after:-bottom-px after:h-[3px] after:bg-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {tab.label}
                </button>
              )
            })}
          </nav>

          <div className="flex items-center gap-1">
            <label className="flex items-center gap-1.5 text-sm">
              <span className="text-muted-foreground hidden sm:inline">Sort:</span>
              <select
                value={sortMode}
                onChange={(e) => onSortChange(e.target.value as SortMode)}
                className="h-9 bg-transparent text-foreground [&>option]:bg-background font-medium pr-1 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
              >
                {(Object.keys(SORT_LABELS) as SortMode[]).map((key) => (
                  <option key={key} value={key}>
                    {SORT_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>

            <div className="h-5 w-px bg-rule mx-2" />

            <button
              type="button"
              onClick={() => onViewModeChange("grid")}
              aria-pressed={viewMode === "grid"}
              title="Grid view"
              className={cn(
                "w-9 h-9 flex items-center justify-center",
                viewMode === "grid" ? "eink-selected" : "hover:bg-accent"
              )}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => onViewModeChange("list")}
              aria-pressed={viewMode === "list"}
              title="List view"
              className={cn(
                "w-9 h-9 flex items-center justify-center",
                viewMode === "list" ? "eink-selected" : "hover:bg-accent"
              )}
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>
        </header>
      </>
    )
  }
)

LibraryHeader.displayName = "LibraryHeader"
