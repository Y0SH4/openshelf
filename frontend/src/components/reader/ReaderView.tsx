import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react"
import { apiFetch } from "@/lib/api"
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Languages,
  Minus,
  NotebookPen,
  Plus,
  TextQuote,
  X,
} from "lucide-react"
import { PdfPage } from "@/components/reader/PdfPage"
import { TranslationCard } from "@/components/reader/TranslationCard"
import { resetPreview, usePinchZoom, type Point } from "@/components/reader/usePinchZoom"
import { DisplayMenu } from "@/components/reading/DisplayMenu"
import { NotesEditor, type NotesEditorHandle } from "@/components/notes/NotesEditor"
import { NotesList } from "@/components/notes/NotesList"
import { createNote, readLastNoteId, storeLastNoteId, type PageLink } from "@/lib/notes"
import { loadPdfDocument, type PDFDocumentProxy } from "@/lib/pdf"
import { googleTranslateUrl, translationEnabled } from "@/lib/translate"
import { cn } from "@/lib/utils"
import type { Book } from "@/components/library/BookCard"
import type { ThemeMode } from "@/components/library/LibraryHeader"

interface ReaderViewProps {
  book: Book
  /** Open at this page instead of the saved one (link from the notes) */
  startPage?: number | null
  /** Opens a page link from the notes that points to another book */
  onOpenPage: (link: PageLink) => boolean
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

interface Selection {
  text: string
  page: number
  x: number
  y: number
}

const MIN_SCALE = 0.25
const MAX_SCALE = 4
/** "Fit width" never goes above this, so pages aren't huge on wide screens */
const MAX_FIT_SCALE = 1.6
/** Each zoom button press */
const ZOOM_STEP = 1.1
const ZOOM_KEY = "openshelf_reader_zoom"
const SAVE_DELAY_MS = 1200

/** "fit" follows the screen width (also after rotating a phone); a number is a fixed scale. */
type Zoom = "fit" | number

const clampScale = (s: number) =>
  Number(Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)).toFixed(3))

/** Space beside the pages: px-2 on phones, px-4 from `sm`, plus the page border */
const sidePadding = (width: number) => (width < 640 ? 8 : 16) * 2 + 2

function readStoredZoom(): Zoom {
  try {
    const v = localStorage.getItem(ZOOM_KEY)
    const n = Number(v)
    return v && v !== "fit" && Number.isFinite(n) && n > 0 ? clampScale(n) : "fit"
  } catch {
    return "fit"
  }
}
function storeZoom(zoom: Zoom) {
  try {
    localStorage.setItem(ZOOM_KEY, String(zoom))
  } catch {
    // ignore
  }
}

/** A point on a page that should stay under the same spot on screen while zooming. */
interface ZoomAnchor {
  page: number
  /** Position on the page, 0–1 */
  fx: number
  fy: number
  /** Where it should be, relative to the scrolling area */
  ax: number
  ay: number
}

/**
 * - The page fills the screen; tap the page to show/hide the toolbars.
 *   Scrolling hides them again.
 * - Always-on footer: "Page 42 of 280 · 15%".
 * - Toolbars: back to Library, Aa (page color + zoom), page scrubber, go to page.
 * - Progress auto-saves 1.2s after you stop on a page, and is flushed when
 *   the reader closes or the tab is hidden (fetch keepalive, JSON).
 * - Notes panel on the right; selected PDF text can be quoted into it.
 * - Zoom: "fit width" by default; buttons, pinch, Ctrl + wheel, double tap.
 * - Keys: ← / → page, + / − / 0 zoom, Esc back to Library.
 */
const formatMB = (bytes: number) => (bytes / 1_048_576).toFixed(1)

/** Real download progress when the size is known, otherwise a sliding bar. */
const DownloadProgress: React.FC<{ progress: { loaded: number; total: number } | null }> = ({
  progress,
}) => {
  const known = progress != null && progress.total > 0
  const ratio = known ? Math.min(1, progress.loaded / progress.total) : 0
  return (
    <div className="mt-5 w-64 max-w-full">
      <div
        className="h-1 bg-rule overflow-hidden"
        role="progressbar"
        aria-label="Downloading book"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? Math.round(ratio * 100) : undefined}
      >
        {known ? (
          <div
            className="h-full bg-foreground transition-[width] duration-200 ease-out"
            style={{ width: `${ratio * 100}%` }}
          />
        ) : (
          <div className="h-full w-1/3 bg-foreground eink-indeterminate" />
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground tabular-nums h-4">
        {known
          ? `${formatMB(progress.loaded)} / ${formatMB(progress.total)} MB · ${Math.round(ratio * 100)}%`
          : progress && progress.loaded > 0
          ? `${formatMB(progress.loaded)} MB`
          : "Connecting…"}
      </p>
    </div>
  )
}

export const ReaderView: React.FC<ReaderViewProps> = React.memo(
  ({ book, startPage, onOpenPage, onClose, theme, onThemeChange, onProgressSaved }) => {
    const isPdf = book.format === "pdf"
    const initialPageRef = useRef<number>(
      Math.max(1, startPage || book.progress?.current_page || 1)
    )

    const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
    const [baseSize, setBaseSize] = useState<{ width: number; height: number } | null>(null)
    const [loadingDoc, setLoadingDoc] = useState(isPdf)
    const [download, setDownload] = useState<{ loaded: number; total: number } | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [zoom, setZoom] = useState<Zoom>(readStoredZoom)
    /** Width of the reading area, for "fit width" */
    const [viewWidth, setViewWidth] = useState(0)
    const fitScale =
      baseSize && viewWidth > 0
        ? clampScale(Math.min(MAX_FIT_SCALE, (viewWidth - sidePadding(viewWidth)) / baseSize.width))
        : null
    const scale = zoom === "fit" ? fitScale : baseSize ? zoom : null

    const [currentPage, setCurrentPage] = useState<number>(initialPageRef.current)
    const [totalPages, setTotalPages] = useState<number>(book.progress?.total_pages || 1)
    const [pageInput, setPageInput] = useState<string>(String(initialPageRef.current))
    const [scrubPage, setScrubPage] = useState<number | null>(null)
    const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved")
    const [chromeVisible, setChromeVisible] = useState(true)
    const [notesOpen, setNotesOpen] = useState(false)
    /** Note shown in the panel; null shows the list of notes */
    const [panelNoteId, setPanelNoteId] = useState<number | null>(readLastNoteId)
    const [selection, setSelection] = useState<Selection | null>(null)
    /** Selected text being translated, with the page it's on */
    const [translating, setTranslating] = useState<{ text: string; page: number } | null>(null)
    const notesRef = useRef<NotesEditorHandle | null>(null)
    const pendingNotesAction = useRef<((notes: NotesEditorHandle) => void) | null>(null)

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
      setDownload(null)

      // PDF.js reports progress very often; update the bar at most ~10x a second
      let lastUpdate = 0
      const onProgress = (loaded: number, total: number) => {
        const now = performance.now()
        if (cancelled || (now - lastUpdate < 100 && loaded < total)) return
        lastUpdate = now
        setDownload({ loaded, total })
      }

      loadPdfDocument(`/api/books/${book.id}/raw`, onProgress)
        .then(async (pdf) => {
          loaded = pdf
          if (cancelled) return
          const first = await pdf.getPage(1)
          const vp = first.getViewport({ scale: 1 })
          if (cancelled) return

          setBaseSize({ width: vp.width, height: vp.height })
          setTotalPages(pdf.numPages)
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

    // ---------- Zoom ----------
    const contentRef = useRef<HTMLDivElement>(null)
    const scaleRef = useRef(scale)
    const fitScaleRef = useRef(fitScale)
    const anchorRef = useRef<ZoomAnchor | null>(null)

    /** The page spot under a screen point, to keep it there after zooming. */
    const anchorAt = useCallback((point: Point, target: Point = point): ZoomAnchor | null => {
      const main = scrollRef.current
      if (!main) return null
      const pageEl =
        document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>("[id^='page-']") ??
        document.getElementById(`page-${currentPageRef.current}`)
      const box = (pageEl?.firstElementChild as HTMLElement | null)?.getBoundingClientRect()
      if (!pageEl || !box || !box.width || !box.height) return null
      const area = main.getBoundingClientRect()
      return {
        page: Number(pageEl.id.slice("page-".length)),
        fx: (point.x - box.left) / box.width,
        fy: (point.y - box.top) / box.height,
        ax: target.x - area.left,
        ay: target.y - area.top,
      }
    }, [])

    const viewCenter = (): Point | null => {
      const area = scrollRef.current?.getBoundingClientRect()
      return area ? { x: area.left + area.width / 2, y: area.top + area.height / 2 } : null
    }

    /** Changes the zoom, keeping `anchor` (default: the middle of the screen) in place. */
    const applyZoom = useCallback(
      (next: Zoom, anchor?: ZoomAnchor | null) => {
        const nextScale = next === "fit" ? fitScaleRef.current : next
        if (nextScale != null && nextScale !== scaleRef.current) {
          const center = viewCenter()
          anchorRef.current = anchor ?? (center ? anchorAt(center) : null)
        } else {
          resetPreview(contentRef.current)
        }
        setZoom(next)
        storeZoom(next)
      },
      [anchorAt]
    )

    // After a zoom: drop the pinch preview and scroll so the anchor stays put.
    // Runs before the browser paints, so the view doesn't jump.
    useLayoutEffect(() => {
      scaleRef.current = scale
      fitScaleRef.current = fitScale
      const main = scrollRef.current
      const anchor = anchorRef.current
      anchorRef.current = null
      resetPreview(contentRef.current)
      if (!main || !anchor || scale == null) return
      const box = document
        .getElementById(`page-${anchor.page}`)
        ?.firstElementChild?.getBoundingClientRect()
      if (!box) return
      const area = main.getBoundingClientRect()
      main.scrollLeft += box.left + anchor.fx * box.width - (area.left + anchor.ax)
      main.scrollTop += box.top + anchor.fy * box.height - (area.top + anchor.ay)
      lastScrollTopRef.current = main.scrollTop
    }, [scale, fitScale])

    // Follow the width of the reading area (window resize, phone rotation,
    // notes panel), keeping the reading position while "fit width" re-fits
    useLayoutEffect(() => {
      const main = scrollRef.current
      if (!main) return
      const widthRef = { current: main.clientWidth }
      setViewWidth(widthRef.current)
      let timer: number | null = null
      const observer = new ResizeObserver(() => {
        if (timer) window.clearTimeout(timer)
        timer = window.setTimeout(() => {
          timer = null
          const width = main.clientWidth
          if (width === widthRef.current) return
          widthRef.current = width
          const center = viewCenter()
          if (center && readyRef.current) anchorRef.current = anchorAt(center)
          setViewWidth(width)
        }, 120)
      })
      observer.observe(main)
      return () => {
        if (timer) window.clearTimeout(timer)
        observer.disconnect()
      }
    }, [anchorAt])

    /** Snap to "fit" when a zoom lands close to it. */
    const toZoom = (next: number): Zoom => {
      const fit = fitScaleRef.current
      return fit != null && Math.abs(next - fit) / fit < 0.04 ? "fit" : clampScale(next)
    }

    usePinchZoom({
      scrollRef,
      contentRef,
      getScale: () => scaleRef.current,
      clamp: clampScale,
      onZoom: (next, start, end) => applyZoom(toZoom(next), anchorAt(start, end)),
      onDoubleTap: (at) => {
        const current = scaleRef.current
        const fit = fitScaleRef.current
        if (current == null || fit == null) return
        applyZoom(current > fit * 1.1 ? "fit" : clampScale(fit * 2), anchorAt(at))
      },
    })

    // ---------- Notes ----------
    const attachNotes = useCallback((handle: NotesEditorHandle | null) => {
      notesRef.current = handle
      if (handle && pendingNotesAction.current) {
        pendingNotesAction.current(handle)
        pendingNotesAction.current = null
      }
    }, [])

    useEffect(() => {
      if (panelNoteId != null) storeLastNoteId(panelNoteId)
    }, [panelNoteId])

    /** Runs `action` on the open note. With no note open, uses the last one
     *  used, or a new note named after this book. */
    const withNotes = async (action: (notes: NotesEditorHandle) => void) => {
      setNotesOpen(true)
      if (notesRef.current) return action(notesRef.current)
      pendingNotesAction.current = action
      let id = panelNoteId ?? readLastNoteId()
      try {
        if (id != null && !(await apiFetch(`/api/notes/${id}`)).ok) id = null
        if (id == null) id = await createNote(book.title)
        setPanelNoteId(id)
      } catch (err) {
        console.error("Couldn't open a note:", err)
        pendingNotesAction.current = null
      }
    }

    const openFromNotes = useCallback(
      (link: PageLink) => {
        if (link.bookId !== book.id) return onOpenPage(link)
        jumpToPage(link.page)
        if (window.matchMedia("(max-width: 639px)").matches) setNotesOpen(false)
        return true
      },
      [book.id, onOpenPage, jumpToPage]
    )

    // Show "Quote to notes" while text on a page is selected
    useEffect(() => {
      if (!isPdf) return
      const onSelectionChange = () => {
        const sel = window.getSelection()
        const text = sel?.toString().trim()
        if (!sel || sel.rangeCount === 0 || !text) return setSelection(null)
        const range = sel.getRangeAt(0)
        const start = range.startContainer
        const layer = (start instanceof Element ? start : start.parentElement)?.closest(".textLayer")
        const pageEl = layer?.closest<HTMLElement>("[id^='page-']")
        if (!pageEl || !scrollRef.current?.contains(pageEl)) return setSelection(null)
        const rect = range.getBoundingClientRect()
        setSelection({
          text,
          page: Number(pageEl.id.slice("page-".length)),
          x: rect.left + rect.width / 2,
          y: rect.top,
        })
      }
      document.addEventListener("selectionchange", onSelectionChange)
      return () => document.removeEventListener("selectionchange", onSelectionChange)
    }, [isPdf])

    const quoteSelection = () => {
      if (!selection) return
      const { text, page } = selection
      window.getSelection()?.removeAllRanges()
      setSelection(null)
      void withNotes((notes) => notes.insertQuote(text, book.title, { bookId: book.id, page }))
    }

    const translateSelection = async () => {
      if (!selection) return
      const { text, page } = selection
      if (!(await translationEnabled())) {
        window.open(googleTranslateUrl(text), "_blank", "noopener,noreferrer")
        return
      }
      window.getSelection()?.removeAllRanges()
      setSelection(null)
      setTranslating({ text, page })
    }

    const closeTranslation = useCallback(() => setTranslating(null), [])

    // Ask early, so Translate can open Google Translate right inside the click
    useEffect(() => {
      void translationEnabled()
    }, [])

    const addTranslationToNotes = (translated: string) => {
      if (!translating) return
      const { page } = translating
      setTranslating(null)
      void withNotes((notes) => notes.insertQuote(translated, book.title, { bookId: book.id, page }))
    }

    const zoomBy = useCallback(
      (factor: number) => {
        const current = scaleRef.current
        if (current == null) return
        const fit = fitScaleRef.current
        const next = current * factor
        // Stop at "fit width" when passing it
        const crossesFit = fit != null && (current - fit) * (next - fit) < 0
        applyZoom(crossesFit ? "fit" : toZoom(next))
      },
      // toZoom only reads refs
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [applyZoom]
    )
    const zoomIn = useCallback(() => zoomBy(ZOOM_STEP), [zoomBy])
    const zoomOut = useCallback(() => zoomBy(1 / ZOOM_STEP), [zoomBy])
    const fitWidth = useCallback(() => applyZoom("fit"), [applyZoom])
    const zoomLabel = zoom === "fit" ? "Fit" : `${Math.round((scale ?? 1) * 100)}%`

    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.defaultPrevented) return
        const target = e.target as HTMLElement | null
        if (target?.isContentEditable) {
          if (e.key === "Escape") target.blur()
          return
        }
        const tag = target?.tagName
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
        } else if (e.key === "0") {
          fitWidth()
        } else if (e.key === "Escape") {
          if (notesOpen) setNotesOpen(false)
          else onClose()
        }
      }
      document.addEventListener("keydown", onKey)
      return () => document.removeEventListener("keydown", onKey)
    }, [jumpToPage, zoomIn, zoomOut, fitWidth, onClose, notesOpen])

    // ---------- 5. Tap to toggle toolbars, scroll to hide ----------
    const handleTap = (e: React.MouseEvent) => {
      if (window.getSelection()?.toString()) return
      if ((e.target as HTMLElement).closest("button, a, input, select, iframe")) return
      lastScrollTopRef.current = scrollRef.current?.scrollTop ?? 0
      setChromeVisible((v) => !v)
    }

    const handleScroll = () => {
      setSelection(null)
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
    // Leave room for the notes panel on wider screens
    const besidePanel = notesOpen && "sm:right-[min(440px,45vw)]"

    return (
      <div className="relative h-[100dvh] bg-background text-foreground overflow-hidden select-none">
        <main
          ref={scrollRef}
          onClick={handleTap}
          onScroll={handleScroll}
          className={cn("absolute inset-0 overflow-auto touch-pan-x touch-pan-y", besidePanel)}
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
              <p className="font-serif text-lg max-w-md">Opening {book.title}…</p>
              <DownloadProgress progress={download} />
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
            <div
              ref={contentRef}
              className="min-w-full w-max flex flex-col items-center pt-16 pb-24 px-2 sm:px-4"
            >
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
            chromeVisible ? "translate-y-0" : "-translate-y-full",
            besidePanel
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

            <button
              type="button"
              onClick={() => setNotesOpen((open) => !open)}
              aria-pressed={notesOpen}
              className={cn(
                "h-10 w-10 flex items-center justify-center shrink-0",
                notesOpen ? "eink-selected" : "hover:bg-accent"
              )}
              title="Notes"
              aria-label="Notes"
            >
              <NotebookPen className="w-5 h-5" />
            </button>

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
                      disabled={scale == null || scale <= MIN_SCALE}
                      className="h-10 w-10 flex items-center justify-center hover:bg-accent disabled:opacity-30"
                      aria-label="Zoom out"
                    >
                      <Minus className="w-4 h-4" />
                    </button>
                    <span className="flex-1 text-center text-sm tabular-nums border-x border-foreground h-10 leading-10">
                      {zoomLabel}
                    </span>
                    <button
                      type="button"
                      onClick={zoomIn}
                      disabled={scale == null || scale >= MAX_SCALE}
                      className="h-10 w-10 flex items-center justify-center hover:bg-accent disabled:opacity-30"
                      aria-label="Zoom in"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={fitWidth}
                    disabled={zoom === "fit"}
                    className="mt-2 w-full h-9 text-sm border border-rule hover:bg-accent disabled:opacity-40"
                  >
                    Fit to width
                  </button>
                  <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
                    Pinch, Ctrl + scroll, or double-tap the page to zoom.
                  </p>
                </>
              )}
            </DisplayMenu>
          </div>
        </header>

        {isPdf && (
          <footer
            className={cn(
              "absolute bottom-0 inset-x-0 z-20 bg-background border-t border-foreground transition-transform duration-100",
              chromeVisible ? "translate-y-0" : "translate-y-full",
              besidePanel
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
                <div className="flex items-center border border-foreground h-7" role="group" aria-label="Zoom">
                  <button
                    type="button"
                    onClick={zoomOut}
                    disabled={scale == null || scale <= MIN_SCALE}
                    className="h-full w-7 flex items-center justify-center hover:bg-accent disabled:opacity-30"
                    aria-label="Zoom out"
                    title="Zoom out (−)"
                  >
                    <Minus className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={fitWidth}
                    className="h-full min-w-11 px-1 border-x border-foreground tabular-nums hover:bg-accent"
                    title="Fit to width (0)"
                  >
                    {zoomLabel}
                  </button>
                  <button
                    type="button"
                    onClick={zoomIn}
                    disabled={scale == null || scale >= MAX_SCALE}
                    className="h-full w-7 flex items-center justify-center hover:bg-accent disabled:opacity-30"
                    aria-label="Zoom in"
                    title="Zoom in (+)"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
                <span className="hidden sm:inline text-muted-foreground">{saveLabel}</span>
                <span className="font-medium tabular-nums">{shownPercent}%</span>
              </div>
            </div>
          </footer>
        )}

        {/* Always-on footer when toolbars are hidden */}
        {isPdf && !chromeVisible && doc && (
          <div
            className={cn(
              "pointer-events-none absolute bottom-0 inset-x-0 z-10 h-7 px-4 flex items-center justify-between text-[11px] text-muted-foreground bg-background/90 tabular-nums",
              besidePanel
            )}
          >
            <span>
              Page {currentPage} of {totalPages}
            </span>
            <span>{percent}%</span>
          </div>
        )}

        {selection && (
          <div
            className="fixed z-40 flex eink-selected text-sm font-medium -translate-x-1/2 divide-x divide-background/30"
            style={{
              left: Math.min(window.innerWidth - 130, Math.max(130, selection.x)),
              top: selection.y > 64 ? selection.y - 44 : selection.y + 28,
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <button
              type="button"
              onClick={quoteSelection}
              className="h-9 px-3 flex items-center gap-1.5 hover:opacity-80"
            >
              <TextQuote className="w-4 h-4" />
              Quote to notes
            </button>
            <button
              type="button"
              onClick={translateSelection}
              className="h-9 px-3 flex items-center gap-1.5 hover:opacity-80"
            >
              <Languages className="w-4 h-4" />
              Translate
            </button>
          </div>
        )}

        {translating && (
          <TranslationCard
            key={translating.text}
            text={translating.text}
            onClose={closeTranslation}
            onAddToNotes={addTranslationToNotes}
            className={cn(chromeVisible ? "bottom-[6.5rem]" : "bottom-10", besidePanel && "sm:left-[calc((100%-min(440px,45vw))/2)]")}
          />
        )}

        {notesOpen && (
          <aside
            className="absolute inset-y-0 right-0 z-30 w-full sm:w-[min(440px,45vw)] bg-background border-l border-foreground flex flex-col select-text"
            aria-label="Notes"
          >
            <div className="h-14 shrink-0 px-4 flex items-center gap-2 border-b border-foreground">
              {panelNoteId != null ? (
                <button
                  type="button"
                  onClick={() => setPanelNoteId(null)}
                  className="h-10 -ml-2 px-2 flex items-center gap-1 hover:bg-accent text-sm font-medium"
                  title="All notes"
                >
                  <ChevronLeft className="w-5 h-5" />
                  All notes
                </button>
              ) : (
                <h2 className="font-serif text-lg font-bold">Notes</h2>
              )}
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => setNotesOpen(false)}
                className="h-10 w-10 -mr-2 flex items-center justify-center hover:bg-accent"
                aria-label="Close notes"
                title="Close notes (Esc)"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4">
              {panelNoteId == null ? (
                <NotesList variant="panel" newNoteTitle={book.title} onOpen={setPanelNoteId} />
              ) : (
                <NotesEditor
                  key={panelNoteId}
                  ref={attachNotes}
                  noteId={panelNoteId}
                  onDeleted={() => {
                    storeLastNoteId(null)
                    setPanelNoteId(null)
                  }}
                  onOpenPage={openFromNotes}
                  toolbarClassName="sticky top-0 -mx-4 px-2"
                  toolbarExtra={
                    isPdf && (
                      <button
                        type="button"
                        onClick={() =>
                          notesRef.current?.insertPageLink(book.title, {
                            bookId: book.id,
                            page: currentPage,
                          })
                        }
                        className="h-9 px-2 ml-1 shrink-0 border border-foreground text-xs font-medium hover:bg-accent whitespace-nowrap"
                        title="Insert a link to this page"
                      >
                        + p. {currentPage}
                      </button>
                    )
                  }
                />
              )}
            </div>
          </aside>
        )}
      </div>
    )
  }
)

ReaderView.displayName = "ReaderView"
