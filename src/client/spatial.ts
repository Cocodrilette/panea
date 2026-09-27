import type { Rect } from './viewport.ts'

export type Direction = 'left' | 'right' | 'up' | 'down'

const ARROWS: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
}

/**
 * How much being off to the side costs compared to being far away. At 3, a
 * tile straight ahead wins over one three times closer but a full tile off
 * the line — which is what "the one to the right" means to a person.
 */
const ALIGN_WEIGHT = 3

/**
 * The direction of a ⌘⌥/ctrl+⌥ + arrow chord, or null. Read off `code`, not
 * `key`: with ⌥ held, macOS is free to hand `key` something else.
 */
export function arrowChord(ev: KeyboardEvent): Direction | null {
  if (!ev.altKey || ev.shiftKey || !(ev.metaKey || ev.ctrlKey)) return null
  return ARROWS[ev.code] ?? null
}

/**
 * The rect nearest to `from` in direction `dir`. A candidate counts only if
 * its centre lies past `from`'s centre in that direction; among those, the
 * gap along the axis is added to the misalignment across it (weighted), with
 * rects that overlap `from` across the axis counting as perfectly aligned.
 */
export function nearestInDirection<T>(from: Rect, items: T[], rectOf: (item: T) => Rect, dir: Direction): T | null {
  const horizontal = dir === 'left' || dir === 'right'
  const sign = dir === 'right' || dir === 'down' ? 1 : -1
  const fc = centre(from)

  let best: T | null = null
  let bestScore = Infinity

  for (const item of items) {
    const r = rectOf(item)
    const c = centre(r)
    const along = ((horizontal ? c.x - fc.x : c.y - fc.y) * sign)
    if (along <= 1) continue

    // Edge-to-edge gap along the axis, so a wide neighbour is not penalised
    // for having its centre far away.
    const gap = Math.max(
      0,
      horizontal
        ? sign > 0 ? r.x - (from.x + from.w) : from.x - (r.x + r.w)
        : sign > 0 ? r.y - (from.y + from.h) : from.y - (r.y + r.h),
    )
    const across = horizontal
      ? intervalGap(from.y, from.h, r.y, r.h)
      : intervalGap(from.x, from.w, r.x, r.w)
    // Tie-break among aligned rects by how centred they are.
    const offset = Math.abs(horizontal ? c.y - fc.y : c.x - fc.x)

    const score = gap + across * ALIGN_WEIGHT + offset * 0.1
    if (score < bestScore) {
      bestScore = score
      best = item
    }
  }
  return best
}

function intervalGap(a: number, aw: number, b: number, bw: number): number {
  return Math.max(0, b - (a + aw), a - (b + bw))
}

function centre(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
}
