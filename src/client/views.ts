/**
 * Saved views: camera bookmarks in slots 1–9, persisted in the layout.
 *
 * ⌥⇧digit saves, ⌥digit recalls. ⌘⇧digit would have been the obvious
 * chord, but macOS takes ⌘⇧3/4/5 for screenshots before the browser ever
 * sees them, and ⌘digit/ctrl+digit are the canvas's zoom/fit and Chrome's
 * tab switching. ⌥digit is free in both Chrome and macOS; the only thing it
 * costs is Meta-digit inside the terminals (macOptionIsMeta sends ESC 1).
 */
import './views.css'

import type { Layout, SavedView, Viewport as ViewportState } from '../shared/protocol.ts'
import type { Viewport } from './viewport.ts'

const SLOTS = 9
const RECALL_MS = 420

export interface ViewsHost {
  /** The live layout; `init` replaces the object, so it is read every time. */
  layout: () => Layout
  save: () => void
  toast: (message: string, kind?: 'info' | 'warn' | 'error') => void
}

export class Views {
  private readonly viewport: Viewport
  private readonly host: ViewsHost
  private readonly listEl: HTMLUListElement
  private frame = 0

  constructor(viewport: Viewport, host: ViewsHost) {
    this.viewport = viewport
    this.host = host
    this.listEl = document.getElementById('views-list') as HTMLUListElement
    document.getElementById('views-add')?.addEventListener('click', () => this.saveNamed())
    this.wireKeys()
    this.render()
  }

  private get list(): SavedView[] {
    const layout = this.host.layout()
    layout.views ??= []
    return layout.views
  }

  /** Overwriting a slot keeps its name: the chord re-aims a view, it does not rename it. */
  saveSlot(slot: number, name?: string): void {
    const cam = this.viewport.state
    const prev = this.list.find((v) => v.slot === slot)
    const view: SavedView = { slot, ...cam, name: name ?? prev?.name }
    if (!view.name) delete view.name
    const layout = this.host.layout()
    layout.views = [...this.list.filter((v) => v.slot !== slot), view].sort((a, b) => a.slot - b.slot)
    this.host.save()
    this.render()
    this.host.toast(`vista ${slot}${view.name ? ` · ${view.name}` : ''} guardada`)
  }

  recall(slot: number): void {
    const view = this.list.find((v) => v.slot === slot)
    if (!view) {
      this.host.toast(`no hay vista en ${slot} — guárdala con ⌥⇧${slot}`, 'warn')
      return
    }
    this.animateTo(view)
  }

  remove(slot: number): void {
    const layout = this.host.layout()
    layout.views = this.list.filter((v) => v.slot !== slot)
    this.host.save()
    this.render()
  }

  /** From the menu: ask for a name and take the first free slot. */
  private saveNamed(): void {
    const taken = new Set(this.list.map((v) => v.slot))
    const slot = Array.from({ length: SLOTS }, (_, i) => i + 1).find((n) => !taken.has(n))
    if (!slot) {
      this.host.toast('los 9 slots están ocupados: borra una vista o sobrescríbela con ⌥⇧1…9', 'warn')
      return
    }
    const name = prompt(`Nombre para la vista ${slot} (opcional):`)
    if (name === null) return
    this.saveSlot(slot, name.trim() || undefined)
  }

  private rename(view: SavedView): void {
    const name = prompt(`Nombre para la vista ${view.slot}:`, view.name ?? '')
    if (name === null) return
    if (name.trim()) view.name = name.trim()
    else delete view.name
    this.host.save()
    this.render()
  }

  render(): void {
    this.listEl.textContent = ''
    if (!this.list.length) {
      const empty = document.createElement('li')
      empty.className = 'views-empty'
      empty.textContent = 'sin vistas — ⌥⇧1…9 guarda'
      this.listEl.appendChild(empty)
      return
    }

    for (const view of this.list) {
      const li = document.createElement('li')
      li.dataset.slot = String(view.slot)

      const go = document.createElement('button')
      go.className = 'views-go'
      go.title = `Ir a la vista (⌥${view.slot})`
      go.textContent = `${view.slot} · ${view.name ?? `${Math.round(view.zoom * 100)}%`}`
      go.addEventListener('click', () => this.recall(view.slot))

      const edit = document.createElement('button')
      edit.className = 'views-icon'
      edit.title = 'Renombrar'
      edit.textContent = '✎'
      edit.addEventListener('click', () => this.rename(view))

      const del = document.createElement('button')
      del.className = 'views-icon'
      del.title = 'Borrar vista'
      del.textContent = '✕'
      del.addEventListener('click', () => this.remove(view.slot))

      li.append(go, edit, del)
      this.listEl.appendChild(li)
    }
  }

  /**
   * Glide instead of cutting, so the eye keeps track of where it went. Zoom
   * is interpolated in log space (each step feels the same size) and position
   * as the world point at the centre of the screen, which keeps the path from
   * swinging out wide when zoom and position change together. Any other
   * camera movement mid-flight (a drag, a pinch) cancels the glide.
   */
  private animateTo(to: ViewportState): void {
    cancelAnimationFrame(this.frame)
    const from = this.viewport.state
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.viewport.state = to
      return
    }

    const cx = window.innerWidth / 2
    const cy = window.innerHeight / 2
    const c0 = { x: (cx - from.x) / from.zoom, y: (cy - from.y) / from.zoom }
    const c1 = { x: (cx - to.x) / to.zoom, y: (cy - to.y) / to.zoom }
    const lz0 = Math.log(from.zoom)
    const lz1 = Math.log(to.zoom)
    const start = performance.now()
    let last = from

    const step = (now: number): void => {
      const cur = this.viewport.state
      if (cur.x !== last.x || cur.y !== last.y || cur.zoom !== last.zoom) return

      const t = Math.min(1, (now - start) / RECALL_MS)
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
      if (t === 1) {
        this.viewport.state = to
        return
      }
      const zoom = Math.exp(lz0 + (lz1 - lz0) * e)
      const wx = c0.x + (c1.x - c0.x) * e
      const wy = c0.y + (c1.y - c0.y) * e
      this.viewport.state = { x: cx - wx * zoom, y: cy - wy * zoom, zoom }
      last = this.viewport.state
      this.frame = requestAnimationFrame(step)
    }
    this.frame = requestAnimationFrame(step)
  }

  /**
   * Captured on window so it runs before xterm's textarea listener: with a
   * terminal focused, ⌥digit would otherwise go out as Meta-digit. `ev.code`
   * because ⌥ changes `ev.key` (⌥1 is "¡" on a US layout, and AZERTY needs
   * shift just to reach a digit).
   */
  private wireKeys(): void {
    window.addEventListener(
      'keydown',
      (ev) => {
        if (!ev.altKey || ev.metaKey || ev.ctrlKey) return
        const m = /^Digit([1-9])$/.exec(ev.code)
        if (!m) return
        // A real text field (the session search) keeps its keys; xterm's own
        // hidden textarea is the one input we do want to take them from.
        const target = ev.target as HTMLElement | null
        if (target?.matches?.('input, textarea, select') && !target.classList.contains('xterm-helper-textarea')) return

        ev.preventDefault()
        ev.stopPropagation()
        if (ev.repeat) return
        const slot = Number(m[1])
        if (ev.shiftKey) this.saveSlot(slot)
        else this.recall(slot)
      },
      true,
    )
  }
}
