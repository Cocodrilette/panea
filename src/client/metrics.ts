import { Terminal } from '@xterm/xterm'

export const FONT_FAMILY = 'ui-monospace, "SF Mono", Menlo, monospace'
export const FONT_SIZE = 12
export const LINE_HEIGHT = 1.15

/** Chrome around the terminal inside a tile, in unscaled px. */
export const HEAD_H = 30
export const PAD_X = 6
export const PAD_Y = 8

export interface Cell {
  w: number
  h: number
}

const PROBE_COLS = 80
const PROBE_ROWS = 10

/**
 * Cell size of a rendered terminal, derived from its own screen element.
 *
 * xterm's published build mangles private property names, so
 * `_core._renderService.dimensions` is not readable — and guessing from
 * fontSize × lineHeight is off by ~2px per row, which makes the terminal
 * overflow its tile. The rendered `.xterm-screen` divided by the terminal's
 * cols/rows is exact and uses only public DOM.
 *
 * The element must be measured with no ancestor CSS transform, or the zoom
 * factor leaks into the result.
 */
export function cellFromScreen(root: ParentNode, cols: number, rows: number): Cell | null {
  const screen = root.querySelector('.xterm-screen')
  if (!screen) return null
  const rect = screen.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  return { w: rect.width / cols, h: rect.height / rows }
}

/**
 * Measure once at startup, in a throwaway terminal mounted outside the
 * zoomable world. Tiles re-check against the first terminal that really
 * mounts, so a wrong guess here self-corrects.
 */
export function measureCell(): Cell {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-9999px;top:0;width:1200px;height:400px;visibility:hidden'
  document.body.appendChild(host)

  const term = new Terminal({
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    lineHeight: LINE_HEIGHT,
    cols: PROBE_COLS,
    rows: PROBE_ROWS,
  })
  term.open(host)

  const cell = cellFromScreen(host, PROBE_COLS, PROBE_ROWS)

  term.dispose()
  host.remove()

  return cell ?? { w: FONT_SIZE * 0.6, h: Math.round(FONT_SIZE * LINE_HEIGHT * 1.16) }
}

export function colsFor(width: number, cell: Cell): number {
  return Math.max(20, Math.floor((width - PAD_X) / cell.w))
}

export function rowsFor(height: number, cell: Cell): number {
  return Math.max(5, Math.floor((height - HEAD_H - PAD_Y) / cell.h))
}

/** Snap a tile box to whole character cells so the terminal fills it exactly. */
export function snapSize(width: number, height: number, cell: Cell): { w: number; h: number } {
  return boxForCells(colsFor(width, cell), rowsFor(height, cell), cell)
}

/** The tile box that fits exactly cols×rows of terminal. */
export function boxForCells(cols: number, rows: number, cell: Cell): { w: number; h: number } {
  return {
    w: Math.round(cols * cell.w + PAD_X),
    h: Math.round(rows * cell.h + HEAD_H + PAD_Y),
  }
}
