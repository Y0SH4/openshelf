import React, { useEffect, useState } from "react"
import { CloudCheck, Trash2 } from "lucide-react"
import {
  formatBytes,
  offlineSupported,
  removeBookOffline,
  useOfflineBooks,
} from "@/lib/offline"

/** Settings: books saved on this device, with their size. */
export const OfflineBooks: React.FC = () => {
  const books = Object.values(useOfflineBooks()).sort((a, b) => b.savedAt - a.savedAt)
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null)
  const total = books.reduce((sum, b) => sum + b.bytes, 0)

  useEffect(() => {
    navigator.storage
      ?.estimate?.()
      .then(({ usage, quota }) => {
        if (usage != null && quota) setStorage({ usage, quota })
      })
      .catch(() => {})
  }, [total])

  if (!offlineSupported()) {
    return (
      <p className="text-sm text-muted-foreground">
        Offline reading needs OpenShelf to be opened over HTTPS (for example through Tailscale
        Serve or a reverse proxy). This page was opened over plain HTTP.
      </p>
    )
  }

  if (books.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No books saved yet. Open a PDF and tap the cloud icon at the top of the reader.
      </p>
    )
  }

  return (
    <div>
      <ul className="border-t border-rule">
        {books.map((book) => (
          <li key={book.id} className="flex items-center gap-3 py-2.5 border-b border-rule">
            <CloudCheck className="w-4 h-4 shrink-0" aria-hidden />
            <span className="flex-1 min-w-0 truncate font-serif text-[15px]">{book.title}</span>
            <span className="text-xs text-muted-foreground tabular-nums shrink-0">
              {formatBytes(book.bytes)}
            </span>
            <button
              type="button"
              onClick={() => removeBookOffline(book.id)}
              className="h-8 w-8 shrink-0 flex items-center justify-center hover:bg-accent"
              aria-label={`Remove “${book.title}” from this device`}
              title="Remove from this device"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground tabular-nums">
        {books.length} {books.length === 1 ? "book" : "books"} · {formatBytes(total)}
        {storage &&
          ` · this browser may use up to ${formatBytes(storage.quota)} (${formatBytes(storage.usage)} used)`}
      </p>
    </div>
  )
}
