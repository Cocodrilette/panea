import type { Viewport as ViewportState } from '../shared/protocol.ts'
import type { Rect, Viewport } from './viewport.ts'

const FLY_MS = 320

let flight = 0

/**
 * Animate the camera to `target`. Zoom is interpolated in log space and the
 * position follows the world point at the centre of the window, so a zoom-out
 * and a pan read as one movement instead of a slide plus a scale.
 *
 * Any other camera movement mid-flight (a drag, a pinch) wins: the flight
 * notices the camera is no longer where it left it and gives up.
 */
export function flyTo(viewport: Viewport, target: ViewportState, ms = FLY_MS): void {
  const id = ++flight
  const from = viewport.state
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (reduced || ms <= 0 || same(from, target)) {
    viewport.state = target
    return
  }

  const cx = window.innerWidth / 2
  const cy = window.innerHeight / 2
  const a = centreOf(from, cx, cy)
  const b = centreOf(target, cx, cy)
  const z0 = Math.log(from.zoom)
  const z1 = Math.log(target.zoom)
  const t0 = performance.now()
  let last = from

  const step = (now: number) => {
    if (id !== flight || !same(viewport.state, last)) return
    const p = Math.min(1, (now - t0) / ms)
    const e = 1 - (1 - p) ** 3
    if (p === 1) {
      viewport.state = target
      return
    }
    const zoom = Math.exp(z0 + (z1 - z0) * e)
    const wx = a.x + (b.x - a.x) * e
    const wy = a.y + (b.y - a.y) * e
    viewport.state = { x: cx - wx * zoom, y: cy - wy * zoom, zoom }
    last = viewport.state
    requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

/**
 * The camera `viewport.fit(rect)` would settle on, without moving it. Fit is
 * run and undone in the same task, so nothing is painted in between.
 */
export function fitTarget(viewport: Viewport, rect: Rect, padding?: number, maxZoom?: number): ViewportState {
  const before = viewport.state
  viewport.fit(rect, padding, maxZoom)
  const target = viewport.state
  viewport.state = before
  return target
}

/**
 * The smallest pan, at the current zoom, that brings `rect` fully into view
 * with `margin` px to spare. A rect bigger than the window gets its top-left
 * corner shown, which is where a terminal's title and first lines are.
 */
export function revealTarget(viewport: Viewport, rect: Rect, margin = 48): ViewportState {
  const { x, y, zoom } = viewport.state
  return {
    x: x + shift(rect.x * zoom + x, rect.w * zoom, window.innerWidth, margin),
    y: y + shift(rect.y * zoom + y, rect.h * zoom, window.innerHeight, margin),
    zoom,
  }
}

function shift(start: number, size: number, span: number, margin: number): number {
  if (size > span - margin * 2) return margin - start
  if (start < margin) return margin - start
  if (start + size > span - margin) return span - margin - (start + size)
  return 0
}

function centreOf(s: ViewportState, cx: number, cy: number): { x: number; y: number } {
  return { x: (cx - s.x) / s.zoom, y: (cy - s.y) / s.zoom }
}

function same(a: ViewportState, b: ViewportState): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.zoom - b.zoom) < 1e-4
}
