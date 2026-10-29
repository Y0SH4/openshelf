import React, { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import type { ThemeMode } from "@/components/library/LibraryHeader"

interface DisplayMenuProps {
  theme: ThemeMode
  onThemeChange: (theme: ThemeMode) => void
  /** Extra sections shown under the page color (e.g. zoom in the reader). */
  children?: React.ReactNode
  className?: string
}

const THEMES: { id: ThemeMode; label: string; swatch: string }[] = [
  { id: "light", label: "White", swatch: "bg-[#f6f5f1] text-[#111]" },
  { id: "sepia", label: "Sepia", swatch: "bg-[#f1e6cf] text-[#2e2418]" },
  { id: "dark", label: "Black", swatch: "bg-[#0a0a0a] text-[#ddd]" },
]

export const DisplayMenu: React.FC<DisplayMenuProps> = ({
  theme,
  onThemeChange,
  children,
  className,
}) => {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    // Capture phase + preventDefault so Esc closes only this menu,
    // not the reader underneath it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey, true)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey, true)
    }
  }, [open])

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Display settings"
        className={cn(
          "h-10 min-w-10 px-2 font-serif text-[17px] leading-none",
          open ? "eink-selected" : "hover:bg-accent"
        )}
      >
        A<span className="text-[13px]">a</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Display settings"
          className="absolute right-0 top-full mt-2 z-50 w-64 bg-popover text-popover-foreground border border-foreground p-4"
        >
          <p className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground mb-2">
            Page color
          </p>
          <div className="grid grid-cols-3 gap-2">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onThemeChange(t.id)}
                aria-pressed={theme === t.id}
                className={cn(
                  "flex flex-col items-center gap-1.5 py-2 border",
                  theme === t.id ? "border-foreground border-2" : "border-rule"
                )}
              >
                <span
                  className={cn(
                    "w-9 h-9 border border-black/30 flex items-center justify-center font-serif text-sm",
                    t.swatch
                  )}
                >
                  Aa
                </span>
                <span className="text-xs">{t.label}</span>
              </button>
            ))}
          </div>
          {children && <div className="eink-rule mt-4 pt-4">{children}</div>}
        </div>
      )}
    </div>
  )
}
