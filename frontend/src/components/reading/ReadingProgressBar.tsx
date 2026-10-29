import React from "react"
import { cn } from "@/lib/utils"

interface ReadingProgressBarProps {
  percent: number
  currentPage?: number
  totalPages?: number
  showLabel?: boolean
  className?: string
}

export const ReadingProgressBar: React.FC<ReadingProgressBarProps> = React.memo(
  ({ percent, currentPage, totalPages, showLabel = true, className }) => {
    const clampedPercent = Math.min(100, Math.max(0, Math.round(percent)))

    return (
      <div className={cn("w-full flex flex-col gap-1 select-none", className)}>
        <div
          className="relative w-full h-[2px] bg-rule"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={clampedPercent}
        >
          <div
            className="absolute inset-y-0 left-0 bg-foreground"
            style={{ width: `${clampedPercent}%` }}
          />
        </div>

        {showLabel && (
          <div className="flex justify-between items-center text-[11px] text-muted-foreground tabular-nums">
            <span>
              {currentPage && totalPages
                ? `Page ${currentPage} of ${totalPages}`
                : ""}
            </span>
            <span className="text-foreground font-medium">
              {clampedPercent >= 100 ? "Read" : `${clampedPercent}%`}
            </span>
          </div>
        )}
      </div>
    )
  }
)

ReadingProgressBar.displayName = "ReadingProgressBar"
