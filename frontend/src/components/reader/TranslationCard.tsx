import React, { useEffect, useState } from "react"
import { Check, Copy, TextQuote, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { TRANSLATE_TO, languageName, translate, type Translation } from "@/lib/translate"

interface TranslationCardProps {
  text: string
  onClose: () => void
  /** Adds the translation to the notes */
  onAddToNotes: (translated: string) => void
  /** Classes for positioning (e.g. above the reader's footer) */
  className?: string
}

/** Translation of the selected text, shown above the reader's footer. */
export const TranslationCard: React.FC<TranslationCardProps> = ({
  text,
  onClose,
  onAddToNotes,
  className,
}) => {
  const [result, setResult] = useState<Translation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    translate(text, controller.signal)
      .then(setResult)
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : "Translation failed.")
        }
      })
    return () => controller.abort()
  }, [text])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
      }
    }
    // Capture phase so Esc closes the card, not the reader
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [onClose])

  const copy = async () => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.translated)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard can be blocked on plain-HTTP pages; the text stays selectable
    }
  }

  const button = "h-8 px-2.5 flex items-center gap-1.5 text-xs font-medium hover:bg-accent"

  return (
    <div
      role="dialog"
      aria-label={`Translation to ${TRANSLATE_TO.name}`}
      className={cn(
        "fixed z-40 left-1/2 -translate-x-1/2 w-[min(36rem,calc(100vw-1.5rem))] bg-popover text-popover-foreground border border-foreground select-text",
        className
      )}
    >
      <div className="flex items-center gap-2 px-4 h-10 border-b border-rule">
        <p className="flex-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
          {result?.source ? `${languageName(result.source)} → ` : ""}
          {TRANSLATE_TO.name}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="h-8 w-8 -mr-2 flex items-center justify-center hover:bg-accent"
          aria-label="Close translation"
          title="Close (Esc)"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="px-4 py-3 max-h-[40dvh] overflow-y-auto">
        {error ? (
          <p role="alert" className="text-sm">
            {error}
          </p>
        ) : result ? (
          <p className="font-serif text-[16px] leading-relaxed whitespace-pre-line">
            {result.translated}
          </p>
        ) : (
          <div aria-busy="true">
            <p className="text-sm text-muted-foreground">Translating…</p>
            <div className="mt-2 h-1 w-40 bg-rule overflow-hidden">
              <div className="h-full w-1/3 bg-foreground eink-indeterminate" />
            </div>
          </div>
        )}
      </div>

      {result && (
        <div className="flex items-center gap-1 px-2 py-1.5 border-t border-rule">
          <button type="button" onClick={copy} className={button}>
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" onClick={() => onAddToNotes(result.translated)} className={button}>
            <TextQuote className="w-3.5 h-3.5" />
            Add to notes
          </button>
        </div>
      )}
    </div>
  )
}
