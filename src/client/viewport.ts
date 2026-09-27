import type { Viewport as ViewportState } from '../shared/protocol.ts'

const MIN_ZOOM = 0.12
export const MAX_ZOOM = 2.5
const GRID = 32
/** How long a terminal keeps a scroll gesture after claiming it. */
const LATCH_MS = 250

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Pan/zoom camera over an infinite world, driven by a single CSS transform. */
export class Viewport {
  x = 0
  y = 0
  zoom = 1
  onChange: (() => void) | null = null

  private panning = false
  private latch: { tile: Element; at: number } | null = null

  constructor(
    private readonly root: HTMLElement,
    private readonly world: HTMLElement,
  ) {
    this.wire()
    this.apply()
  }

  get state(): ViewportState {
    return { x: this.x, y: this.y, zoom: this.zoom }
  }

  set state(s: ViewportState) {
    this.x = s.x
    this.y = s.y
    this.zoom = clamp(s.zoom)
    this.apply()
  }

  apply(): void {
    this.world.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.zoom})`
    const step = GRID * this.zoom
    this.root.style.backgroundSize = `${step}px ${step}px`
    this.root.style.backgroundPosition = `${this.x}px ${this.y}px`
    this.onChange?.()
  }

  /** Run `fn` with the world transform neutralised (for DOM measurement). */
  unscaled<T>(fn: () => T): T {
    const prev = this.world.style.transform
    this.world.style.transform = 'none'
    try {
      return fn()
    } finally {
      this.world.style.transform = prev
    }
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.x) / this.zoom, y: (sy - this.y) / this.zoom }
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const next = clamp(this.zoom * factor)
    if (next === this.zoom) return
    // Keep the world point under the cursor pinned to the cursor.
    this.x = sx - (sx - this.x) * (next / this.zoom)
    this.y = sy - (sy - this.y) * (next / this.zoom)
    this.zoom = next
    this.apply()
  }

  setZoom(next: number): void {
    this.zoomAt(window.innerWidth / 2, window.innerHeight / 2, clamp(next) / this.zoom)
  }

  panBy(dx: number, dy: number): void {
    this.x += dx
    this.y += dy
    this.apply()
  }

  /** Frame `rect` (world coords) inside the window. */
  fit(rect: Rect, padding = 80, maxZoom = 1): void {
    if (rect.w <= 0 || rect.h <= 0) return
    const vw = window.innerWidth - padding * 2
    const vh = window.innerHeight - padding * 2
    this.zoom = clamp(Math.min(vw / rect.w, vh / rect.h, maxZoom))
    this.x = padding + (vw - rect.w * this.zoom) / 2 - rect.x * this.zoom
    this.y = padding + (vh - rect.h * this.zoom) / 2 - rect.y * this.zoom
    this.apply()
  }

  /**
   * xterm computes its own mouse→cell math from `.xterm-screen`'s
   * getBoundingClientRect (which reflects our CSS zoom) divided by its
   * internal, unscaled cell size — so at any zoom other than 100% it picks
   * the wrong row/column (selection drifts up/down as you drag). There is no
   * public API to tell xterm about an ancestor transform, so mouse events
   * aimed at a terminal are intercepted ahead of xterm's own listeners and
   * redispatched with clientX/Y rescaled around the screen element, as if
   * the world were unscaled.
   */
  private wireTerminalCoordFix(): void {
    const CORRECTED = '__vpCorrected'

    const fix = (ev: MouseEvent): void => {
      if (Object.prototype.hasOwnProperty.call(ev, CORRECTED) || this.zoom === 1) return
      const target = ev.target as Element | null
      const screen = target?.closest('.tile')?.querySelector('.xterm-screen')
      if (!screen) return

      const rect = screen.getBoundingClientRect()
      const clientX = rect.left + (ev.clientX - rect.left) / this.zoom
      const clientY = rect.top + (ev.clientY - rect.top) / this.zoom

      ev.stopPropagation()
      // xterm's own handler would preventDefault to stop the native text
      // selection it replaces with its own — but that never runs now, since
      // the event it sees is the corrected copy below, not this one.
      if (ev.type === 'mousedown' && ev.button === 0) ev.preventDefault()

      const corrected = new MouseEvent(ev.type, {
        bubbles: true,
        cancelable: true,
        view: window,
        detail: ev.detail,
        clientX,
        clientY,
        button: ev.button,
        buttons: ev.buttons,
        ctrlKey: ev.ctrlKey,
        shiftKey: ev.shiftKey,
        altKey: ev.altKey,
        metaKey: ev.metaKey,
        relatedTarget: ev.relatedTarget,
      })
      Object.defineProperty(corrected, CORRECTED, { value: true })
      ev.target?.dispatchEvent(corrected)
    }

    // Capturing + attached to window so this always runs before xterm's own
    // listeners, which sit on the terminal element and on `document`.
    for (const type of ['mousedown', 'mousemove', 'mouseup'] as const) {
      window.addEventListener(type, fix, true)
    }
  }

  private wire(): void {
    this.wireTerminalCoordFix()

    this.root.addEventListener('pointerdown', (ev) => {
      const onBackground = ev.target === this.root || ev.target === this.world
      if (!onBackground || ev.button === 2) return
      this.panning = true
      this.root.classList.add('panning')
      this.root.setPointerCapture(ev.pointerId)

      const start = { x: ev.clientX, y: ev.clientY, vx: this.x, vy: this.y }
      const move = (e: PointerEvent) => {
        this.x = start.vx + (e.clientX - start.x)
        this.y = start.vy + (e.clientY - start.y)
        this.apply()
      }
      const up = () => {
        this.panning = false
        this.root.classList.remove('panning')
        this.root.removeEventListener('pointermove', move)
        this.root.removeEventListener('pointerup', up)
        this.root.removeEventListener('pointercancel', up)
        this.onChange?.()
      }
      this.root.addEventListener('pointermove', move)
      this.root.addEventListener('pointerup', up)
      this.root.addEventListener('pointercancel', up)
    })

    // Zoom is captured before the event can reach a focused terminal, which
    // would otherwise swallow it as scrollback movement. A trackpad pinch
    // arrives as a wheel event with ctrlKey set.
    this.root.addEventListener(
      'wheel',
      (ev) => {
        if (!ev.ctrlKey && !ev.metaKey) return
        ev.preventDefault()
        ev.stopPropagation()
        this.zoomAt(ev.clientX, ev.clientY, Math.exp(-ev.deltaY / 220))
      },
      { passive: false, capture: true },
    )

    // Plain scroll pans, but a terminal under the cursor gets first claim on
    // the gesture.
    this.root.addEventListener(
      'wheel',
      (ev) => {
        if (ev.ctrlKey || ev.metaKey) return
        const tile = (ev.target as Element | null)?.closest?.('.tile') ?? null

        // xterm calls preventDefault while it still has scrollback left to
        // move through, but lets the event bubble; panning here as well would
        // scroll the canvas out from under the text being read.
        if (ev.defaultPrevented) {
          if (tile) this.latch = { tile, at: ev.timeStamp }
          return
        }

        // The gesture stays latched to that terminal until the fingers stop,
        // so hitting the end of the scrollback mid-flick does not hand the
        // leftover momentum to the canvas.
        if (tile && this.latch?.tile === tile && ev.timeStamp - this.latch.at < LATCH_MS) {
          this.latch.at = ev.timeStamp
          ev.preventDefault()
          return
        }

        this.latch = null
        ev.preventDefault()
        this.panBy(-ev.deltaX, -ev.deltaY)
      },
      { passive: false },
    )
  }

  get isPanning(): boolean {
    return this.panning
  }
}

function clamp(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
}
