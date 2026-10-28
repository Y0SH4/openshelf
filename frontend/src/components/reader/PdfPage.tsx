import React, { useEffect, useRef, useState } from "react"
import type { PDFDocumentProxy, PDFPageProxy } from "@/lib/pdf"
import { cn } from "@/lib/utils"

interface PageSize {
  width: number
  height: number
}

interface PdfPageProps {
  doc: PDFDocumentProxy
  pageNumber: number
  scale: number
  theme: "light" | "sepia" | "dark"
  /** Unscaled size of page 1 — used as the placeholder size so scrolling
   *  to a page lands in the right place before it has rendered. */
  baseSize: PageSize
  onPageVisible: (pageNumber: number) => void
}

/**
 * One PDF page on a "sheet of paper".
 * - Lazy canvas rendering near the viewport; canvas is dropped when far away.
 * - Mid-viewport detection reports the current page.
 * - HiDPI rendering (capped at 2x).
 * - Sepia / dark page tint via CSS filters (like Kindle page colors).
 */
export const PdfPage: React.FC<PdfPageProps> = React.memo(
  ({ doc, pageNumber, scale, theme, baseSize, onPageVisible }) => {
    const containerRef = useRef<HTMLDivElement>(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const [isNearViewport, setIsNearViewport] = useState(false)
    const [actualSize, setActualSize] = useState<PageSize | null>(null)
    const [rendered, setRendered] = useState(false)

    const size = actualSize ?? baseSize
    const cssWidth = Math.floor(size.width * scale)
    const cssHeight = Math.floor(size.height * scale)

    // 1. Which page is in the middle of the screen?
    useEffect(() => {
      const el = containerRef.current
      if (!el) return
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) onPageVisible(pageNumber)
          }
        },
        { rootMargin: "-45% 0px -45% 0px", threshold: 0 }
      )
      observer.observe(el)
      return () => observer.disconnect()
    }, [pageNumber, onPageVisible])

    // 2. Lazy render window
    useEffect(() => {
      const el = containerRef.current
      if (!el) return
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              setIsNearViewport(true)
            } else {
              setIsNearViewport(false)
              setRendered(false)
            }
          }
        },
        { rootMargin: "800px 0px 800px 0px", threshold: 0 }
      )
      observer.observe(el)
      return () => observer.disconnect()
    }, [])

    // 3. Render with PDF.js
    useEffect(() => {
      if (!isNearViewport) return

      let cancelled = false
      let renderTask: { cancel: () => void; promise: Promise<void> } | null = null

      const renderPage = async () => {
        try {
          const page: PDFPageProxy = await doc.getPage(pageNumber)
          if (cancelled) return

          const unscaled = page.getViewport({ scale: 1.0 })
          setActualSize((prev) =>
            prev && prev.width === unscaled.width && prev.height === unscaled.height
              ? prev
              : { width: unscaled.width, height: unscaled.height }
          )

          const canvas = canvasRef.current
          if (!canvas) return
          const ctx = canvas.getContext("2d", { alpha: false })
          if (!ctx) return

          const dpr = Math.min(window.devicePixelRatio || 1, 2)
          const viewport = page.getViewport({ scale: scale * dpr })

          canvas.width = Math.floor(viewport.width)
          canvas.height = Math.floor(viewport.height)
          canvas.style.width = `${Math.floor(unscaled.width * scale)}px`
          canvas.style.height = `${Math.floor(unscaled.height * scale)}px`

          renderTask = page.render({ canvasContext: ctx, viewport })
          await renderTask.promise
          if (!cancelled) setRendered(true)
        } catch (err: any) {
          if (err?.name !== "RenderingCancelledException" && !cancelled) {
            console.error(`Error rendering page ${pageNumber}:`, err)
          }
        }
      }

      renderPage()

      return () => {
        cancelled = true
        try {
          renderTask?.cancel()
        } catch {
          // ignore
        }
      }
    }, [doc, pageNumber, scale, isNearViewport])

    const tint =
      theme === "dark"
        ? "invert-[0.88] hue-rotate-180 contrast-[1.1]"
        : theme === "sepia"
        ? "sepia-[0.45] brightness-[0.97] contrast-[0.96]"
        : ""

    return (
      <div
        ref={containerRef}
        id={`page-${pageNumber}`}
        className="flex flex-col items-center py-2 scroll-mt-16"
      >
        <div
          style={{ width: `${cssWidth}px`, height: `${cssHeight}px` }}
          className={cn(
            "relative overflow-hidden border border-rule",
            theme === "dark" ? "bg-[#111]" : theme === "sepia" ? "bg-[#f3e9d2]" : "bg-white"
          )}
        >
          {!rendered && (
            <div className="absolute inset-0 flex items-center justify-center font-serif text-sm text-muted-foreground/60">
              {pageNumber}
            </div>
          )}
          <canvas
            ref={canvasRef}
            className={cn("block", rendered ? "opacity-100" : "opacity-0", tint)}
          />
        </div>
      </div>
    )
  }
)

PdfPage.displayName = "PdfPage"
