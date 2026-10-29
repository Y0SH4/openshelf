import React, { useState, useEffect, useRef, useCallback } from "react"
import { apiFetch } from "@/lib/api"
import { ArrowLeft, ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react"
import { PdfPage } from "@/components/reader/PdfPage"
import { DisplayMenu } from "@/components/reading/DisplayMenu"
import { loadPdfDocument, type PDFDocumentProxy } from "@/lib/pdf"
import { cn } from "@/lib/utils"
import type { Book } from "@/components/library/BookCard"
import type { ThemeMode } from "@/components/library/LibraryHeader"

interface ReaderViewProps {
  book: Book
  onClose: () => void
  theme: ThemeMode
  onThemeChange: (theme: ThemeMode) => void
  onProgressSaved: (
    bookId: string,
    currentPage: number,
    totalPages: number,
    progressPercent: number
  ) => void
}

type SaveStatus = "saved" | "saving" | "unsaved"

const MIN_SCALE = 0.6
const MAX_SCALE = 2.5
const SCALE_KEY = "openshelf_reader_scale"
const SAVE_DELAY_MS = 1200

const clampScale = (s: number) =>
  Number(Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)).toFixed(2))

function readStoredScale(): number | null {
  try {
    const v = Number(localStorage.getItem(SCALE_KEY))
    return Number.isFinite(v) && v > 0 ? clampScale(v) : null
  } catch {
    return null
  }
}
function storeScale(s: number) {
  try {
    localStorage.setItem(SCALE_KEY, String(s))
  } catch {
    // ignore
  }
}

/**
 * - The page fills the screen; tap the page to show/hide the toolbars.
 *   Scrolling hides them again.
 * - Always-on footer: "Page 42 of 280 · 15%".
 * - Toolbars: back to Library, Aa (page color + zoom), page scrubber, go to page.
 * - Progress auto-saves 1.2s after you stop on a page, and is flushed when
 *   the reader closes or the tab is hidden (fetch keepalive, JSON).
 * - Keys: ← / → page, + / − zoom, Esc back to Library.
 */
export const ReaderView: React.FC<ReaderViewProps> = React.memo(
  ({ book, onClose, theme, onThemeChange, onProgressSaved }) => {
    const isPdf = book.format === "pdf"
    const initialPageRef = useRef<number>(Math.max(1, book.progress?.current_page || 1))

    const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
    const [baseSize, setBaseSize] = useState<{ width: number; height: number } | null>(null)
    const [loadingDoc, setLoadingDoc] = useState(isPdf)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [scale, setScale] = useState<number | null>(readStoredScale)

    const [currentPage, setCurrentPage] = useState<number>(initialPageRef.current)
    const [totalPages, setTotalPages] = useState<number>(book.progress?.total_pages || 1)
    const [pageInput, setPageInput] = useState<string>(String(initialPageRef.current))
    const [scrubPage, setScrubPage] = useState<number | null>(null)
    const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved")
    const [chromeVisible, setChromeVisible] = useState(true)

    const scrollRef = useRef<HTMLDivElement>(null)
    const debounceRef = useRef<number | null>(null)
    const lastSavedPageRef = useRef<number>(initialPageRef.current)
    const currentPageRef = useRef<number>(initialPageRef.current)
    const totalPagesRef = useRef<number>(totalPages)
    const readyRef = useRef(false) // true once we've jumped to the saved page
    const lastScrollTopRef = useRef(0)
    const onProgressSavedRef = useRef(onProgressSaved)

    useEffect(() => {
      currentPageRef.current = currentPage
    }, [currentPage])
    useEffect(() => {
      totalPagesRef.current = totalPages
    }, [totalPages])
    useEffect(() => {
      onProgressSavedRef.current = onProgressSaved
    }, [onProgressSaved])

    const percent = Math.min(100, Math.max(0, Math.round((currentPage / (totalPages || 1)) * 100)))

    // ---------- 1. Load the PDF ----------
    useEffect(() => {
      if (!isPdf) return
      let cancelled = false
      let loaded: PDFDocumentProxy | null = null
      setLoadingDoc(true)
      setLoadError(null)

      loadPdfDocument(`/api/books/${book.id}/raw`)
        .then(async (pdf) => {
          loaded = pdf
          if (cancelled) return
          const first = await pdf.getPage(1)
          const vp = first.getViewport({ scale: 1 })
          if (cancelled) return

          setBaseSize({ width: vp.width, height: vp.height })
          setTotalPages(pdf.numPages)
          // First time: fit the page to the screen width
          setScale((s) => {
            if (s != null) return s
            const available = (scrollRef.current?.clientWidth ?? window.innerWidth) - 32
            return clampScale(Math.min(1.6, available / vp.width))
          })
          setDoc(pdf)
          setLoadingDoc(false)
        })
        .catch((err) => {
          if (cancelled) return
          console.error("Failed to load PDF:", err)
          setLoadError("This PDF couldn't be rendered. Showing the browser's viewer instead.")
          setLoadingDoc(false)
        })

      return () => {
        cancelled = true
        loaded?.destroy().catch(() => {})
      }
    }, [book.id, isPdf])

    // ---------- 2. Save progress ----------
    const saveProgress = useCallback(
      async (page: number, total: number, keepalive = false) => {
        setSaveStatus("saving")
        try {
          const res = await apiFetch(`/api/books/${book.id}/progress`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ current_page: page, total_pages: total }),
            keepalive,
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json()
          lastSavedPageRef.current = page
          setSaveStatus("saved")
          onProgressSavedRef.current(
            book.id,
            data.current_page,
            data.total_pages,
            data.progress_percent
          )
        } catch (err) {
          console.error("Auto-save failed:", err)
          setSaveStatus("unsaved")
        }
      },
      [book.id]
    )

    useEffect(() => {
      if (!doc || !readyRef.current) return
      if (currentPage === lastSavedPageRef.current) return

      setSaveStatus("unsaved")
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null
        saveProgress(currentPage, totalPages)
      }, SAVE_DELAY_MS)

      return () => {
        if (debounceRef.current) {
          window.clearTimeout(debounceRef.current)
          debounceRef.current = null
        }
      }
    }, [currentPage, totalPages, doc, saveProgress])

    // Flush unsaved progress when the reader closes or the tab is hidden.
    // Runs once per book (deps are stable), not on every page change.
    useEffect(() => {
      const flush = () => {
        const page = currentPageRef.current
        if (!readyRef.current || page === lastSavedPageRef.current) return
        lastSavedPageRef.current = page
        void saveProgress(page, totalPagesRef.current, true)
      }
      const onVisibility = () => {
        if (document.visibilityState === "hidden") flush()
      }
      window.addEventListener("pagehide", flush)
      document.addEventListener("visibilitychange", onVisibility)
      return () => {
        window.removeEventListener("pagehide", flush)
        document.removeEventListener("visibilitychange", onVisibility)
        flush()
      }
    }, [saveProgress])

    // ---------- 3. Jump to the saved page once ----------
    useEffect(() => {
      if (!doc || scale == null || readyRef.current) return
      const target = Math.min(initialPageRef.current, doc.numPages)
      const t = window.setTimeout(() => {
        document.getElementById(`page-${target}`)?.scrollIntoView({ block: "start" })
        setCurrentPage(target)
        setPageInput(String(target))
        // Let the observers settle before trusting their page reports
        window.setTimeout(() => {
          readyRef.current = true
          lastScrollTopRef.current = scrollRef.current?.scrollTop ?? 0
        }, 120)
      }, 30)
      return () => window.clearTimeout(t)
    }, [doc, scale])

    // ---------- 4. Page tracking & navigation ----------
    const handlePageVisible = useCallback((pageNum: number) => {
      if (!readyRef.current) return
      setCurrentPage(pageNum)
      setPageInput(String(pageNum))
    }, [])

    const jumpToPage = useCallback(
      (target: number) => {
        const clamped = Math.min(totalPagesRef.current, Math.max(1, target))
        const el = document.getElementById(`page-${clamped}`)
        if (!el) return
        el.scrollIntoView({ block: "start" }) // instant, like e-ink
        setCurrentPage(clamped)
        setPageInput(String(clamped))
        lastScrollTopRef.current = scrollRef.current?.scrollTop ?? 0
      },
      []
    )

    // Keep the same page in view when zoom changes
    const prevScaleRef = useRef(scale)
    useEffect(() => {
      if (scale == null || prevScaleRef.current === scale) return
      const hadScale = prevScaleRef.current != null
      prevScaleRef.current = scale
      storeScale(scale)
      if (!hadScale || !readyRef.current) return
      const page = currentPageRef.current
      readyRef.current = false
      requestAnimationFrame(() => {
        document.getElementById(`page-${page}`)?.scrollIntoView({ block: "start" })
        window.setTimeout(() => {
          readyRef.current = true
          lastScrollTopRef.current = scrollRef.current?.scrollTop ?? 0
        }, 120)
      })
    }, [scale])

    const zoomIn = useCallback(() => setScale((s) => clampScale((s ?? 1) + 0.1)), [])
    const zoomOut = useCallback(() => setScale((s) => clampScale((s ?? 1) - 0.1)), [])
    const fitWidth = useCallback(() => {
      if (!baseSize) return
      const available = (scrollRef.current?.clientWidth ?? window.innerWidth) - 32
      setScale(clampScale(available / baseSize.width))
    }, [baseSize])

    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.defaultPrevented) return
        const tag = (e.target as HTMLElement | null)?.tagName
        if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return
        if (e.key === "ArrowRight") {
          e.preventDefault()
          jumpToPage(currentPageRef.current + 1)
        } else if (e.key === "ArrowLeft") {
          e.preventDefault()
          jumpToPage(currentPageRef.current - 1)
        } else if (e.key === "+" || e.key === "=") {
          zoomIn()
        } else if (e.key === "-") {
          zoomOut()
        } else if (e.key === "Escape") {
          onClose()
        }
      }
      document.addEventListener("keydown", onKey)
      return () => document.removeEventListener("keydown", onKey)
    }, [jumpToPage, zoomIn, zoomOut, onClose])

    // ---------- 5. Tap to toggle toolbars, scroll to hide ----------
    const handleTap = (e: React.MouseEvent) => {
      if (window.getSelection()?.toString()) return
      if ((e.target as HTMLElement).closest("button, a, input, select, iframe")) return
      lastScrollTopRef.current = scrollRef.current?.scrollTop ?? 0
      setChromeVisible((v) => !v)
    }

    const handleScroll = () => {
      const el = scrollRef.current
      if (!el || !chromeVisible || !readyRef.current) return
      if (Math.abs(el.scrollTop - lastScrollTopRef.current) > 160) {
        setChromeVisible(false)
      }
    }

    const handlePageInputSubmit = (e: React.FormEvent) => {
      e.preventDefault()
      const parsed = parseInt(pageInput, 10)
      if (!isNaN(parsed)) jumpToPage(parsed)
      else setPageInput(String(currentPage))
    }

    const shownPage = scrubPage ?? currentPage
    const shownPercent = Math.round((shownPage / (totalPages || 1)) * 100)
    const saveLabel =
      saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "Saved" : "Not saved yet"

    return (
      <div className="relative h-[100dvh] bg-background text-foreground overflow-hidden select-none">
        <main
          ref={scrollRef}
          onClick={handleTap}
          onScroll={handleScroll}
          className="absolute inset-0 overflow-auto"
        >
          {!isPdf ? (
            <div className="h-full flex items-center justify-center p-6">
              <div className="max-w-sm text-center border border-foreground p-8">
                <p className="font-serif text-xl font-bold">EPUB reading is coming soon</p>
                <p className="text-sm text-muted-foreground mt-2">
                  OpenShelf can only display PDFs right now. You can download this book
                  and open it in another reader.
                </p>
                <a
                  href={`/api/books/${book.id}/raw`}
                  download={book.file_name}
                  className="inline-flex items-center justify-center mt-5 h-10 px-5 eink-selected text-sm font-medium"
                >
                  Download EPUB
                </a>
              </div>
            </div>
          ) : loadingDoc ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-6">
              <p className="font-serif text-lg">Opening {book.title}…</p>
              <div className="mt-4 w-40 h-[2px] bg-rule overflow-hidden">
                <div className="h-full w-1/3 bg-foreground animate-pulse" />
              </div>
            </div>
          ) : loadError ? (
            <div className="h-full flex flex-col pt-16 pb-8 px-4">
              <p className="text-sm text-center mb-3 font-serif italic">{loadError}</p>
              <iframe
                src={`/api/books/${book.id}/raw`}
                className="flex-1 w-full border border-foreground"
                title={book.title}
              />
            </div>
          ) : doc && baseSize && scale != null ? (
            <div className="min-w-full w-max flex flex-col items-center pt-16 pb-24 px-4">
              {Array.from({ length: totalPages }, (_, idx) => idx + 1).map((pageNum) => (
                <PdfPage
                  key={pageNum}
                  doc={doc}
                  pageNumber={pageNum}
                  scale={scale}
                  theme={theme}
                  baseSize={baseSize}
                  onPageVisible={handlePageVisible}
                />
              ))}
            </div>
          ) : null}
        </main>

        <header
          className={cn(
            "absolute top-0 inset-x-0 z-20 bg-background border-b border-foreground transition-transform duration-100",
            chromeVisible ? "translate-y-0" : "-translate-y-full"
          )}
          aria-hidden={!chromeVisible}
        >
          <div className="h-14 px-2 sm:px-4 flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-10 px-2 flex items-center gap-1.5 hover:bg-accent shrink-0 text-sm font-medium"
              title="Back to Library (Esc)"
            >
              <ArrowLeft className="w-5 h-5" />
              <span className="hidden sm:inline">Library</span>
            </button>

            <h1 className="flex-1 min-w-0 text-center font-serif text-[15px] font-medium truncate px-2">
              {book.title}
            </h1>

            <DisplayMenu theme={theme} onThemeChange={onThemeChange}>
              {isPdf && (
                <>
                  <p className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground mb-2">
                    Zoom
                  </p>
                  <div className="flex items-center border border-foreground">
                    <button
                      type="button"
                      onClick={zoomOut}
                      disabled={scale != null && scale <= MIN_SCALE}
                      className="h-10 w-10 flex items-center justify-center hover:bg-accent disabled:opacity-30"
                      aria-label="Zoom out"
                    >
                      <Minus className="w-4 h-4" />
                    </button>
                    <span className="flex-1 text-center text-sm tabular-nums border-x border-foreground h-10 leading-10">
                      {Math.round((scale ?? 1) * 100)}%
                    </span>
                    <button
                      type="button"
                      onClick={zoomIn}
                      disabled={scale != null && scale >= MAX_SCALE}
                      className="h-10 w-10 flex items-center justify-center hover:bg-accent disabled:opacity-30"
                      aria-label="Zoom in"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={fitWidth}
                    className="mt-2 w-full h-9 text-sm border border-rule hover:bg-accent"
                  >
                    Fit to width
                  </button>
                </>
              )}
            </DisplayMenu>
          </div>
        </header>

        {isPdf && (
          <footer
            className={cn(
              "absolute bottom-0 inset-x-0 z-20 bg-background border-t border-foreground transition-transform duration-100",
              chromeVisible ? "translate-y-0" : "translate-y-full"
            )}
            aria-hidden={!chromeVisible}
          >
            <div className="max-w-3xl mx-auto px-3 sm:px-6 pt-3 pb-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => jumpToPage(currentPage - 1)}
                  disabled={currentPage <= 1}
                  className="h-9 w-9 flex items-center justify-center hover:bg-accent disabled:opacity-30 shrink-0"
                  aria-label="Previous page"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <input
                  type="range"
                  min={1}
                  max={Math.max(1, totalPages)}
                  value={shownPage}
                  onChange={(e) => setScrubPage(Number(e.target.value))}
                  onPointerUp={() => {
                    if (scrubPage != null) jumpToPage(scrubPage)
                    setScrubPage(null)
                  }}
                  onKeyUp={() => {
                    if (scrubPage != null) jumpToPage(scrubPage)
                    setScrubPage(null)
                  }}
                  className="eink-range flex-1"
                  style={{ ["--fill" as string]: `${shownPercent}%` } as React.CSSProperties}
                  aria-label="Page"
                />
                <button
                  type="button"
                  onClick={() => jumpToPage(currentPage + 1)}
                  disabled={currentPage >= totalPages}
                  className="h-9 w-9 flex items-center justify-center hover:bg-accent disabled:opacity-30 shrink-0"
                  aria-label="Next page"
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              </div>

              <div className="mt-1 flex items-center justify-between gap-3 text-xs">
                <form onSubmit={handlePageInputSubmit} className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">Page</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={scrubPage != null ? String(scrubPage) : pageInput}
                    onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ""))}
                    onBlur={handlePageInputSubmit}
                    className="w-12 h-7 text-center border border-foreground bg-transparent tabular-nums focus:outline-none focus:ring-2 focus:ring-foreground"
                    aria-label="Go to page"
                  />
                  <span className="text-muted-foreground tabular-nums">of {totalPages}</span>
                </form>
                <span className="text-muted-foreground">{saveLabel}</span>
                <span className="font-medium tabular-nums">{shownPercent}%</span>
              </div>
            </div>
          </footer>
        )}

        {/* Always-on footer when toolbars are hidden */}
        {isPdf && !chromeVisible && doc && (
          <div className="pointer-events-none absolute bottom-0 inset-x-0 z-10 h-7 px-4 flex items-center justify-between text-[11px] text-muted-foreground bg-background/90 tabular-nums">
            <span>
              Page {currentPage} of {totalPages}
            </span>
            <span>{percent}%</span>
          </div>
        )}
      </div>
    )
  }
)

ReaderView.displayName = "ReaderView"
