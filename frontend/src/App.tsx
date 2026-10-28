import { useEffect, useMemo, useState, useCallback } from "react"
import { BookCard } from "@/components/library/BookCard"
import type { Book } from "@/components/library/BookCard"
import { LibraryHeader } from "@/components/library/LibraryHeader"
import type {
  ThemeMode,
  FormatFilter,
  SortMode,
  ViewMode,
} from "@/components/library/LibraryHeader"
import { CategoryFilterBar } from "@/components/library/CategoryFilterBar"
import type { CategoryItem } from "@/components/library/CategoryFilterBar"
import { AssignCategoryModal } from "@/components/library/AssignCategoryModal"
import { ReaderView } from "@/components/reader/ReaderView"
import { LoginScreen } from "@/components/auth/LoginScreen"
import { SettingsView } from "@/components/settings/SettingsView"
import { apiFetch, UNAUTHORIZED_EVENT, type AuthStatus } from "@/lib/api"

// localStorage can throw (private mode, blocked storage) — never let that break the app.
function readPref<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const v = localStorage.getItem(key) as T | null
    return v && allowed.includes(v) ? v : fallback
  } catch {
    return fallback
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

const THEME_COLORS: Record<ThemeMode, string> = {
  light: "#f6f5f1",
  sepia: "#f1e6cf",
  dark: "#0a0a0a",
}

type AuthState =
  | { status: "checking" }
  | { status: "offline" }
  | { status: "setup" }
  | { status: "login" }
  | { status: "ready"; username: string }

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "checking" })
  const [view, setView] = useState<"library" | "settings">("library")
  const [books, setBooks] = useState<Book[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [selectedBook, setSelectedBook] = useState<Book | null>(null)
  const [managingBook, setManagingBook] = useState<Book | null>(null)
  const [search, setSearch] = useState("")
  const [formatFilter, setFormatFilter] = useState<FormatFilter>("all")
  const [categories, setCategories] = useState<CategoryItem[]>([])
  const [selectedCategory, setSelectedCategory] = useState<string>("all")
  const [theme, setTheme] = useState<ThemeMode>(() =>
    readPref("openshelf_theme", "light", ["light", "sepia", "dark"] as const)
  )
  const [sortMode, setSortMode] = useState<SortMode>(() =>
    readPref("openshelf_sort", "title", ["title", "progress", "file"] as const)
  )
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    readPref("openshelf_view", "grid", ["grid", "list"] as const)
  )

  // Theme → <html> class + browser chrome color
  useEffect(() => {
    const root = document.documentElement
    root.classList.remove("dark", "sepia")
    if (theme === "dark") root.classList.add("dark")
    if (theme === "sepia") root.classList.add("sepia")
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", THEME_COLORS[theme])
    writePref("openshelf_theme", theme)
  }, [theme])

  useEffect(() => writePref("openshelf_sort", sortMode), [sortMode])
  useEffect(() => writePref("openshelf_view", viewMode), [viewMode])

  const fetchBooks = useCallback(() => {
    apiFetch("/api/books")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data: Book[]) => {
        setBooks(data)
        setLoadError(false)
        setLoading(false)
      })
      .catch((err) => {
        console.error("Gagal mengambil daftar buku:", err)
        setLoadError(true)
        setLoading(false)
      })
  }, [])

  const fetchCategories = useCallback(() => {
    apiFetch("/api/categories")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data: CategoryItem[]) => setCategories(data))
      .catch((err) => console.error("Gagal mengambil daftar kategori:", err))
  }, [])

  // 1. Who am I? (setup needed / signed in / signed out)
  const checkAuth = useCallback(() => {
    fetch("/api/auth/status", { credentials: "same-origin" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data: AuthStatus) => {
        if (data.user) setAuth({ status: "ready", username: data.user.username })
        else setAuth({ status: data.setup_required ? "setup" : "login" })
      })
      .catch(() => setAuth({ status: "offline" }))
  }, [])

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  // 2. Session expired / signed out elsewhere → back to the sign-in page
  useEffect(() => {
    const onUnauthorized = () => {
      setSelectedBook(null)
      setManagingBook(null)
      setAuth((prev) => (prev.status === "ready" ? { status: "login" } : prev))
    }
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [])

  // 3. Load the library once signed in
  const isReady = auth.status === "ready"
  useEffect(() => {
    if (!isReady) return
    setLoading(true)
    fetchBooks()
    fetchCategories()
  }, [isReady, fetchBooks, fetchCategories])

  const handleLogout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" })
    } catch {
      // Even if the server is unreachable, leave the library locally
    }
    setSelectedBook(null)
    setManagingBook(null)
    setBooks([])
    setCategories([])
    setView("library")
    setAuth({ status: "login" })
  }, [])

  const openSettings = useCallback(() => setView("settings"), [])
  const closeSettings = useCallback(() => {
    setView("library")
    // Folders may have changed → reload the shelf
    fetchBooks()
    fetchCategories()
  }, [fetchBooks, fetchCategories])

  // Filter + sort, memoized: O(N log N) only when inputs change
  const filteredBooks = useMemo(() => {
    const query = search.trim().toLowerCase()
    const result = books.filter((b) => {
      const matchesSearch = query === "" || b.title.toLowerCase().includes(query)
      const matchesFormat = formatFilter === "all" || b.format === formatFilter
      const matchesCategory =
        selectedCategory === "all" ||
        (b.categories?.includes(selectedCategory) ?? false)
      return matchesSearch && matchesFormat && matchesCategory
    })

    const byTitle = (a: Book, b: Book) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true })

    if (sortMode === "title") result.sort(byTitle)
    else if (sortMode === "file")
      result.sort((a, b) => a.file_name.localeCompare(b.file_name, undefined, { numeric: true }))
    else
      result.sort(
        (a, b) =>
          (b.progress?.progress_percent ?? 0) - (a.progress?.progress_percent ?? 0) ||
          byTitle(a, b)
      )
    return result
  }, [books, search, formatFilter, selectedCategory, sortMode])

  const handleCategoryCreated = useCallback((newCat: CategoryItem) => {
    setCategories((prev) =>
      [...prev, newCat].sort((a, b) => a.name.localeCompare(b.name))
    )
  }, [])

  const handleBookCategoriesUpdated = useCallback(
    (bookId: string, updatedCategoryNames: string[]) => {
      setBooks((prev) =>
        prev.map((b) =>
          b.id === bookId ? { ...b, categories: updatedCategoryNames } : b
        )
      )
      fetchCategories() // refresh counts
    },
    [fetchCategories]
  )

  const handleProgressSaved = useCallback(
    (
      bookId: string,
      currentPage: number,
      totalPages: number,
      progressPercent: number
    ) => {
      setBooks((prev) =>
        prev.map((b) =>
          b.id === bookId
            ? {
                ...b,
                progress: {
                  current_page: currentPage,
                  total_pages: totalPages,
                  progress_percent: progressPercent,
                },
              }
            : b
        )
      )
    },
    []
  )

  const closeManaging = useCallback(() => setManagingBook(null), [])

  // Sign-in gate
  if (auth.status === "checking") {
    return <div className="min-h-[100dvh] bg-background" aria-busy="true" />
  }
  if (auth.status === "offline") {
    return (
      <div className="min-h-[100dvh] bg-background text-foreground flex items-center justify-center p-6">
        <div className="max-w-sm w-full text-center border border-foreground p-8">
          <p className="font-serif text-xl font-bold">Can't reach OpenShelf</p>
          <p className="text-sm text-muted-foreground mt-2">
            Make sure the backend is running on port 3000.
          </p>
          <button
            type="button"
            onClick={() => {
              setAuth({ status: "checking" })
              checkAuth()
            }}
            className="mt-5 h-10 px-5 border border-foreground hover:bg-accent text-sm font-medium"
          >
            Try again
          </button>
        </div>
      </div>
    )
  }
  if (auth.status !== "ready") {
    return (
      <LoginScreen
        key={auth.status}
        mode={auth.status}
        onSuccess={(username) => setAuth({ status: "ready", username })}
      />
    )
  }

  // Settings page
  if (view === "settings") {
    return (
      <SettingsView
        username={auth.username}
        theme={theme}
        onThemeChange={setTheme}
        onBack={closeSettings}
        onLogout={handleLogout}
      />
    )
  }

  // Reading mode
  if (selectedBook) {
    return (
      <ReaderView
        key={selectedBook.id}
        book={selectedBook}
        onClose={() => setSelectedBook(null)}
        theme={theme}
        onThemeChange={setTheme}
        onProgressSaved={handleProgressSaved}
      />
    )
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <LibraryHeader
        search={search}
        onSearchChange={setSearch}
        formatFilter={formatFilter}
        onFormatFilterChange={setFormatFilter}
        totalBooks={books.length}
        filteredCount={filteredBooks.length}
        theme={theme}
        onThemeChange={setTheme}
        sortMode={sortMode}
        onSortChange={setSortMode}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        username={auth.username}
        onLogout={handleLogout}
        onOpenSettings={openSettings}
      />

      <CategoryFilterBar
        categories={categories}
        selectedCategory={selectedCategory}
        onSelectCategory={setSelectedCategory}
        onCategoryCreated={handleCategoryCreated}
        totalBooksCount={books.length}
      />

      <main className="max-w-6xl mx-auto px-4 sm:px-6 pt-6 pb-16">
        {loading ? (
          <div className="py-24 text-center">
            <p className="font-serif text-lg">Loading your library…</p>
            <p className="text-sm text-muted-foreground mt-1">
              Scanning books and reading progress
            </p>
          </div>
        ) : loadError ? (
          <div className="py-20 text-center border border-foreground px-6">
            <p className="font-serif text-xl font-bold">Can't reach OpenShelf</p>
            <p className="text-sm text-muted-foreground mt-2">
              Make sure the backend is running on port 3000.
            </p>
            <button
              type="button"
              onClick={() => {
                setLoading(true)
                fetchBooks()
                fetchCategories()
              }}
              className="mt-5 h-10 px-5 border border-foreground hover:bg-accent text-sm font-medium"
            >
              Try again
            </button>
          </div>
        ) : books.length === 0 ? (
          <div className="py-20 text-center border border-dashed border-foreground/60 px-6">
            <p className="font-serif text-2xl font-bold">Your library is empty</p>
            <p className="text-sm text-muted-foreground mt-2 max-w-sm mx-auto">
              Choose the folder where you keep your PDF and EPUB files. OpenShelf will
              scan it and its sub-folders.
            </p>
            <button
              type="button"
              onClick={openSettings}
              className="mt-6 h-11 px-6 eink-selected text-sm font-semibold hover:opacity-90"
            >
              Add a folder
            </button>
          </div>
        ) : filteredBooks.length === 0 ? (
          <div className="py-20 text-center">
            <p className="font-serif text-xl font-bold">No items</p>
            <p className="text-sm text-muted-foreground mt-2 max-w-sm mx-auto">
              {search
                ? `Nothing in your library matches “${search}”.`
                : selectedCategory !== "all"
                ? `“${selectedCategory}” is empty. Use ⋮ on a book to add it.`
                : "No books match these filters."}
            </p>
          </div>
        ) : viewMode === "list" ? (
          <div className="border-t border-rule">
            {filteredBooks.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                variant="list"
                onSelect={setSelectedBook}
                onManageCategories={setManagingBook}
              />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-x-5 gap-y-8">
            {filteredBooks.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                variant="grid"
                onSelect={setSelectedBook}
                onManageCategories={setManagingBook}
              />
            ))}
          </div>
        )}
      </main>

      <AssignCategoryModal
        book={managingBook}
        categories={categories}
        isOpen={!!managingBook}
        onClose={closeManaging}
        onSaved={handleBookCategoriesUpdated}
        onCategoryCreated={handleCategoryCreated}
      />
    </div>
  )
}
