import { useEffect, useRef } from "react"

export interface Point {
  x: number
  y: number
}

interface PinchZoomOptions {
  /** The scrolling element */
  scrollRef: React.RefObject<HTMLElement | null>
  /** The element inside it that is scaled with a CSS transform while pinching */
  contentRef: React.RefObject<HTMLElement | null>
  /** Current scale, or null while the book isn't shown yet */
  getScale: () => number | null
  clamp: (scale: number) => number
  /** Called once the gesture ends. `start` is where it began, `end` where it
   *  ended (client coordinates); the point under `start` should end up under `end`. */
  onZoom: (scale: number, start: Point, end: Point) => void
  /** Double tap on a touch screen, at a client position */
  onDoubleTap: (at: Point) => void
}

interface Gesture {
  startScale: number
  scale: number
  start: Point
  current: Point
  /** Finger distance when the pinch started */
  distance: number
}

const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_SLOP = 30
/** Ctrl + wheel (and touchpad pinch) commits after this long without events */
const WHEEL_IDLE_MS = 180

const distanceOf = (t: TouchList) =>
  Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
const midpointOf = (t: TouchList): Point => ({
  x: (t[0].clientX + t[1].clientX) / 2,
  y: (t[0].clientY + t[1].clientY) / 2,
})

/**
 * Zooms the PDF (not the whole page) with:
 * - a two-finger pinch on touch screens,
 * - Ctrl + mouse wheel, and touchpad pinch (browsers send it as Ctrl + wheel),
 * - a double tap on touch screens.
 *
 * While the gesture runs, the content is scaled with a CSS transform, which
 * is smooth but blurry. When it ends, `onZoom` sets the real scale so pages
 * are drawn sharp again; the caller removes the transform with `resetPreview`
 * in the same frame, so nothing jumps.
 */
export function usePinchZoom(options: PinchZoomOptions) {
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })

  useEffect(() => {
    const main = options.scrollRef.current
    if (!main) return
    const opts = () => optionsRef.current

    let gesture: Gesture | null = null
    let wheelTimer: number | null = null
    let lastTap: { time: number; at: Point } | null = null
    let tapStart: Point | null = null

    const preview = () => {
      const content = opts().contentRef.current
      if (!content || !gesture) return
      const box = main.getBoundingClientRect()
      // Scale around the point where the gesture began, in content coordinates
      const ox = gesture.start.x - box.left + main.scrollLeft - content.offsetLeft
      const oy = gesture.start.y - box.top + main.scrollTop - content.offsetTop
      const dx = gesture.current.x - gesture.start.x
      const dy = gesture.current.y - gesture.start.y
      content.style.transformOrigin = `${ox}px ${oy}px`
      content.style.transform = `translate(${dx}px, ${dy}px) scale(${gesture.scale / gesture.startScale})`
    }

    const begin = (at: Point, distance = 0): boolean => {
      const scale = opts().getScale()
      if (scale == null) return false
      gesture = { startScale: scale, scale, start: at, current: at, distance }
      const content = opts().contentRef.current
      if (content) content.style.willChange = "transform"
      return true
    }

    const finish = () => {
      if (!gesture) return
      const { scale, start, current } = gesture
      gesture = null
      opts().onZoom(scale, start, current)
    }

    // ---------- Touch ----------
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault()
        tapStart = null
        begin(midpointOf(e.touches), distanceOf(e.touches))
      } else if (e.touches.length === 1) {
        tapStart = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      if (tapStart && e.touches.length === 1) {
        const t = e.touches[0]
        if (Math.hypot(t.clientX - tapStart.x, t.clientY - tapStart.y) > DOUBLE_TAP_SLOP) tapStart = null
      }
      if (!gesture || e.touches.length !== 2 || !gesture.distance) return
      e.preventDefault()
      gesture.scale = opts().clamp(gesture.startScale * (distanceOf(e.touches) / gesture.distance))
      gesture.current = midpointOf(e.touches)
      preview()
    }

    const onTouchEnd = (e: TouchEvent) => {
      if (gesture && e.touches.length < 2) {
        finish()
        return
      }
      // A quick tap that didn't move: check for a double tap
      if (e.touches.length !== 0 || !tapStart) return
      const now = performance.now()
      const at = tapStart
      tapStart = null
      if (
        lastTap &&
        now - lastTap.time < DOUBLE_TAP_MS &&
        Math.hypot(at.x - lastTap.at.x, at.y - lastTap.at.y) < DOUBLE_TAP_SLOP
      ) {
        lastTap = null
        opts().onDoubleTap(at)
      } else {
        lastTap = { time: now, at }
      }
    }

    // ---------- Ctrl + wheel / touchpad pinch ----------
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      if (!gesture && !begin({ x: e.clientX, y: e.clientY })) return
      if (!gesture) return
      // Line/page deltas (mouse wheels on some systems) are much coarser than pixels
      const delta = e.deltaMode === 0 ? e.deltaY : e.deltaY * 16
      gesture.scale = opts().clamp(gesture.scale * Math.exp(-delta * 0.01))
      preview()
      if (wheelTimer) window.clearTimeout(wheelTimer)
      wheelTimer = window.setTimeout(() => {
        wheelTimer = null
        finish()
      }, WHEEL_IDLE_MS)
    }

    // Safari's own pinch zoom of the whole page
    const stopSafariGesture = (e: Event) => e.preventDefault()

    main.addEventListener("touchstart", onTouchStart, { passive: false })
    main.addEventListener("touchmove", onTouchMove, { passive: false })
    main.addEventListener("touchend", onTouchEnd)
    main.addEventListener("touchcancel", onTouchEnd)
    main.addEventListener("wheel", onWheel, { passive: false })
    main.addEventListener("gesturestart", stopSafariGesture)
    main.addEventListener("gesturechange", stopSafariGesture)
    return () => {
      if (wheelTimer) window.clearTimeout(wheelTimer)
      main.removeEventListener("touchstart", onTouchStart)
      main.removeEventListener("touchmove", onTouchMove)
      main.removeEventListener("touchend", onTouchEnd)
      main.removeEventListener("touchcancel", onTouchEnd)
      main.removeEventListener("wheel", onWheel)
      main.removeEventListener("gesturestart", stopSafariGesture)
      main.removeEventListener("gesturechange", stopSafariGesture)
    }
  }, [options.scrollRef])
}

/** Removes the pinch preview transform. */
export function resetPreview(content: HTMLElement | null) {
  if (!content) return
  content.style.transform = ""
  content.style.transformOrigin = ""
  content.style.willChange = ""
}
