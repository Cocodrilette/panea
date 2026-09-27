import { HEAD_H, PAD_X, PAD_Y, colsFor, rowsFor, snapSize, type Cell } from './metrics.ts'
import type { Rect } from './viewport.ts'

/**
 * Smart guides: while a tile is dragged or resized it snaps to the edges,
 * centres, spacing and sizes of the tiles around it, and the overlay shows
 * which relationship it snapped to.
 *
 * Everything here is in world coordinates; only the snap distance and the
 * overlay's line weight are divided by the zoom, so they stay constant on
 * screen.
 */

/** How close, in screen px, something must get before it snaps. */
export const SNAP_PX = 7
/** Two world coordinates this close count as aligned when drawing guides. */
const SAME = 1

type Axis = 'x' | 'y'

/** A guide line: for axis `x` it is vertical, at x = `at`, from y `from` to `to`. */
interface Line {
  axis: Axis
  at: number
  from: number
  to: number
}

/** A measured stretch along `axis`, drawn at the cross coordinate `cross`. */
interface Span {
  axis: Axis
  from: number
  to: number
  cross: number
  label: string
  kind: 'gap' | 'size'
}

export interface Marks {
  lines: Line[]
  spans: Span[]
}

const cross = (a: Axis): Axis => (a === 'x' ? 'y' : 'x')
const start = (r: Rect, a: Axis): number => (a === 'x' ? r.x : r.y)
const size = (r: Rect, a: Axis): number => (a === 'x' ? r.w : r.h)
const end = (r: Rect, a: Axis): number => start(r, a) + size(r, a)
const anchors = (r: Rect, a: Axis): number[] => [start(r, a), start(r, a) + size(r, a) / 2, end(r, a)]
const overlaps = (p: Rect, q: Rect, a: Axis): boolean => start(p, a) < end(q, a) && start(q, a) < end(p, a)

/** Middle of where two rects overlap on `a`, i.e. where a marker between them reads best. */
function between(p: Rect, q: Rect, a: Axis): number {
  return (Math.max(start(p, a), start(q, a)) + Math.min(end(p, a), end(q, a))) / 2
}

interface Gap {
  before: Rect
  after: Rect
  size: number
}

/** Gaps between each tile of `row` and its nearest neighbour after it along `a`. */
function rowGaps(row: Rect[], a: Axis): Gap[] {
  const gaps: Gap[] = []
  for (const p of row) {
    let next: Rect | null = null
    for (const q of row) {
      if (q === p || start(q, a) < end(p, a) || !overlaps(p, q, cross(a))) continue
      if (!next || start(q, a) < start(next, a)) next = q
    }
    if (next) gaps.push({ before: p, after: next, size: start(next, a) - end(p, a) })
  }
  return gaps
}

/** The tiles of `row` closest to `box` on either side along `a`. */
function neighbours(box: Rect, row: Rect[], a: Axis, slack: number): { before?: Rect; after?: Rect } {
  let before: Rect | undefined
  let after: Rect | undefined
  for (const o of row) {
    if (end(o, a) <= start(box, a) + slack && (!before || end(o, a) > end(before, a))) before = o
    if (start(o, a) >= end(box, a) - slack && (!after || start(o, a) < start(after, a))) after = o
  }
  return { before, after }
}

/**
 * The smallest nudge along `a` that lines `box` up with something, or 0.
 * Edge/centre alignment is tried first and wins ties, then equal spacing.
 */
function snapAxis(box: Rect, others: Rect[], a: Axis, tol: number): number {
  let best = Infinity
  const consider = (d: number) => {
    if (Math.abs(d) < Math.abs(best)) best = d
  }

  const mine = anchors(box, a)
  for (const o of others) for (const t of anchors(o, a)) for (const m of mine) consider(t - m)

  const row = others.filter((o) => overlaps(o, box, cross(a)))
  const { before, after } = neighbours(box, row, a, tol)
  for (const { size: g } of rowGaps(row, a)) {
    if (before) consider(end(before, a) + g - start(box, a))
    if (after) consider(start(after, a) - g - end(box, a))
  }
  if (before && after) {
    const room = start(after, a) - end(before, a) - size(box, a)
    if (room > 0) consider(end(before, a) + room / 2 - start(box, a))
  }

  return Math.abs(best) <= tol ? best : 0
}

/** Snap a dragged tile's position. */
export function snapMove(box: Rect, others: Rect[], tol: number): { x: number; y: number; marks: Marks } {
  const x = Math.round(box.x + snapAxis(box, others, 'x', tol))
  const moved = { ...box, x }
  const y = Math.round(box.y + snapAxis(moved, others, 'y', tol))
  const final = { ...moved, y }
  return { x, y, marks: { lines: alignLines(final, others, false), spans: gapSpans(final, others) } }
}

/**
 * Snap a resized tile's size. Tiles only come in whole character cells, so a
 * target is only taken when some cell count lands on it; otherwise the guide
 * would claim an alignment that is a few pixels off. Matching another tile's
 * size always works, since every tile shares the same cell.
 */
export function snapResize(
  box: Rect,
  raw: { w: number; h: number },
  others: Rect[],
  tol: number,
  cell: Cell,
): { w: number; h: number; marks: Marks } {
  const fallback = snapSize(raw.w, raw.h, cell)
  const w = snapLength(raw.w, box.x, others, 'x', tol, (t) => fitCells(t, cell.w, PAD_X, 20)) ?? fallback.w
  const h = snapLength(raw.h, box.y, others, 'y', tol, (t) => fitCells(t, cell.h, HEAD_H + PAD_Y, 5)) ?? fallback.h
  const final = { ...box, w, h }
  return { w, h, marks: { lines: alignLines(final, others, true), spans: sizeSpans(final, others, cell) } }
}

function snapLength(
  raw: number,
  origin: number,
  others: Rect[],
  a: Axis,
  tol: number,
  fit: (target: number) => number,
): number | null {
  const targets: number[] = []
  for (const o of others) targets.push(start(o, a) - origin, end(o, a) - origin, size(o, a))
  const near = targets.filter((t) => Math.abs(t - raw) <= tol).sort((p, q) => Math.abs(p - raw) - Math.abs(q - raw))
  for (const t of near) {
    const fitted = fit(t)
    if (Math.abs(fitted - t) <= SAME) return fitted
  }
  return null
}

/** The whole-cell length closest to `target`, mirroring boxForCells. */
function fitCells(target: number, cell: number, chrome: number, min: number): number {
  return Math.round(Math.max(min, Math.round((target - chrome) / cell)) * cell + chrome)
}

/**
 * Guide lines through every edge or centre of `box` that another tile shares.
 * While resizing only the far edges move, so only those get lines.
 */
function alignLines(box: Rect, others: Rect[], farEdgesOnly: boolean): Line[] {
  const lines: Line[] = []
  for (const a of ['x', 'y'] as const) {
    const c = cross(a)
    const mine = farEdgesOnly ? [end(box, a)] : anchors(box, a)
    for (const o of others) {
      const theirs = farEdgesOnly ? [start(o, a), end(o, a)] : anchors(o, a)
      for (const m of mine) {
        if (!theirs.some((t) => Math.abs(t - m) < SAME)) continue
        const from = Math.min(start(box, c), start(o, c))
        const to = Math.max(end(box, c), end(o, c))
        const same = lines.find((l) => l.axis === a && Math.abs(l.at - m) < SAME)
        if (same) {
          same.from = Math.min(same.from, from)
          same.to = Math.max(same.to, to)
        } else {
          lines.push({ axis: a, at: m, from, to })
        }
      }
    }
  }
  return lines
}

/** The gaps on either side of `box`, plus every gap nearby that they equal. */
function gapSpans(box: Rect, others: Rect[]): Span[] {
  const spans: Span[] = []
  for (const a of ['x', 'y'] as const) {
    const row = others.filter((o) => overlaps(o, box, cross(a)))
    const { before, after } = neighbours(box, row, a, 0)
    const mine: Gap[] = []
    if (before) mine.push({ before, after: box, size: start(box, a) - end(before, a) })
    if (after) mine.push({ before: box, after, size: start(after, a) - end(box, a) })

    const gaps = [...mine, ...rowGaps(row, a)].filter((g) => g.size > 0)
    const shown = new Set<Gap>()
    for (const g of mine) {
      const equal = gaps.filter((o) => o !== g && Math.abs(o.size - g.size) < SAME)
      if (!equal.length) continue
      shown.add(g)
      for (const o of equal) shown.add(o)
    }
    for (const g of shown) {
      spans.push({
        axis: a,
        from: end(g.before, a),
        to: start(g.after, a),
        cross: between(g.before, g.after, cross(a)),
        label: String(Math.round(g.size)),
        kind: 'gap',
      })
    }
  }
  return spans
}

/** Size markers on `box` and on every tile it now matches in width or height. */
function sizeSpans(box: Rect, others: Rect[], cell: Cell): Span[] {
  const spans: Span[] = []
  for (const a of ['x', 'y'] as const) {
    const matches = others.filter((o) => Math.abs(size(o, a) - size(box, a)) < SAME)
    if (!matches.length) continue
    const label = a === 'x' ? `${colsFor(box.w, cell)} cols` : `${rowsFor(box.h, cell)} filas`
    for (const r of [box, ...matches]) {
      spans.push({ axis: a, from: start(r, a), to: end(r, a), cross: start(r, cross(a)), label, kind: 'size' })
    }
  }
  return spans
}

/** Overlay that draws the marks inside the world, above every tile. */
export class Guides {
  private readonly el: HTMLDivElement

  constructor(world: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'guides'
    world.appendChild(this.el)
  }

  show(marks: Marks, zoom: number): void {
    this.el.style.setProperty('--s', String(1 / zoom))
    const parts: HTMLElement[] = []
    for (const l of marks.lines) {
      const d = div('guide-line')
      if (l.axis === 'x') place(d, l.at, l.from, 0, l.to - l.from)
      else place(d, l.from, l.at, l.to - l.from, 0)
      d.dataset.axis = l.axis
      parts.push(d)
    }
    for (const s of marks.spans) {
      const d = div(`guide-span ${s.kind}`)
      d.dataset.axis = s.axis
      if (s.axis === 'x') place(d, s.from, s.cross, s.to - s.from, 0)
      else place(d, s.cross, s.from, 0, s.to - s.from)
      const label = div('guide-label')
      label.textContent = s.label
      d.appendChild(label)
      parts.push(d)
    }
    this.el.replaceChildren(...parts)
  }

  clear(): void {
    if (this.el.childElementCount) this.el.replaceChildren()
  }
}

function div(className: string): HTMLDivElement {
  const d = document.createElement('div')
  d.className = className
  return d
}

function place(d: HTMLElement, x: number, y: number, w: number, h: number): void {
  d.style.left = `${x}px`
  d.style.top = `${y}px`
  d.style.width = `${w}px`
  d.style.height = `${h}px`
}
