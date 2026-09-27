import { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SCROLLBACK_LINES, type TileBox, type TileSpec } from '../shared/protocol.ts'
import { hasFiles, imagesFrom } from './images.ts'
import {
  FONT_FAMILY,
  FONT_SIZE,
  HEAD_H,
  LINE_HEIGHT,
  colsFor,
  rowsFor,
  boxForCells,
  cellFromScreen,
  snapSize,
  type Cell,
} from './metrics.ts'
import { currentTheme, termTheme, type ThemeName } from './theme.ts'

export interface TileHandlers {
  onInput(id: string, data: string): void
  onResize(id: string, cols: number, rows: number): void
  onFocus(tile: Tile): void
  onChange(): void
  onDragStart(tile: Tile): void
  /** The title bar is being dragged; screen coordinates of the pointer. */
  onDragMove(tile: Tile, x: number, y: number): void
  onDragEnd(tile: Tile): void
  onClose(tile: Tile): void
  onKill(tile: Tile): void
  onDecouple(tile: Tile): void
  onZoomTo(tile: Tile): void
  /** Images dropped on, or pasted into, this tile. */
  onImages(tile: Tile, files: File[]): void
  /** Reports the real cell size of the first terminal that mounts. */
  onMeasured(cell: Cell): void
  /** Runs `fn` with the world transform neutralised, for correct measuring. */
  unscaled<T>(fn: () => T): T
}

export class Tile {
  readonly el: HTMLDivElement
  readonly term: Terminal
  spec: TileSpec
  box: TileBox
  focused = false
  dead = false

  private readonly body: HTMLDivElement
  private readonly snapshotEl: HTMLPreElement
  private readonly titleEl: HTMLSpanElement
  private readonly subEl: HTMLSpanElement
  private readonly badgeEl: HTMLSpanElement
  private readonly dropEl: HTMLDivElement
  private cols = 0
  private rows = 0
  private lod: 'near' | 'far' = 'near'

  constructor(
    spec: TileSpec,
    box: TileBox,
    private readonly cell: Cell,
    private readonly handlers: TileHandlers,
  ) {
    this.spec = spec
    this.box = box

    this.el = document.createElement('div')
    this.el.className = 'tile'
    this.el.dataset.id = spec.id
    this.el.dataset.lod = 'near'

    const head = document.createElement('div')
    head.className = 'tile-head'

    this.titleEl = document.createElement('span')
    this.titleEl.className = 'tile-title'
    this.subEl = document.createElement('span')
    this.subEl.className = 'tile-sub'
    this.badgeEl = document.createElement('span')
    this.badgeEl.className = 'tile-badge'
    this.badgeEl.hidden = true

    head.append(this.titleEl, this.subEl, this.badgeEl)
    head.append(
      this.button('⤢', 'Zoom a esta terminal', () => handlers.onZoomTo(this)),
      this.button('⧉', 'Sacar este pane a su propia window para desacoplar su tamaño', () => handlers.onDecouple(this), 'decouple'),
      this.button('✕', 'Quitar del canvas (los procesos siguen vivos)', () => handlers.onClose(this)),
      this.button('⌫', 'Matar la window de tmux y sus procesos', () => handlers.onKill(this), 'danger'),
    )

    this.body = document.createElement('div')
    this.body.className = 'tile-body'

    this.snapshotEl = document.createElement('pre')
    this.snapshotEl.className = 'tile-snapshot'

    this.dropEl = document.createElement('div')
    this.dropEl.className = 'tile-drop'
    this.dropEl.textContent = 'Soltar imagen para pegar su ruta'
    this.dropEl.hidden = true

    this.body.append(this.snapshotEl, this.dropEl)

    const resize = document.createElement('div')
    resize.className = 'tile-resize'

    this.el.append(head, this.body, resize)

    this.term = new Terminal({
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      lineHeight: LINE_HEIGHT,
      ...termTheme(currentTheme()),
      cursorBlink: true,
      scrollback: SCROLLBACK_LINES,
      macOptionIsMeta: true,
      allowProposedApi: true,
    })

    this.term.onData((data) => handlers.onInput(this.spec.id, data))
    // Canvas-level shortcuts must win even while a terminal has the keyboard.
    this.term.attachCustomKeyEventHandler((ev) => !(ev.metaKey || (ev.ctrlKey && ev.altKey)))
    this.term.loadAddon(new WebLinksAddon())

    this.update(spec)
    this.applyBox()
    this.wireDrag(head)
    this.wireResize(resize)
    this.wireImages()

    this.body.addEventListener('pointerdown', () => handlers.onFocus(this), true)
  }

  /** Must run after the tile element is in the DOM. */
  mount(): void {
    this.handlers.unscaled(() => {
      this.term.open(this.body)
      this.resizeTerm()
      const real = cellFromScreen(this.body, this.cols, this.rows)
      if (real) this.handlers.onMeasured(real)
    })
  }

  private button(label: string, title: string, onClick: () => void, cls?: string): HTMLButtonElement {
    const b = document.createElement('button')
    b.textContent = label
    b.title = title
    if (cls) b.classList.add(cls)
    b.addEventListener('pointerdown', (e) => e.stopPropagation())
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      onClick()
    })
    return b
  }

  update(spec: TileSpec): void {
    this.spec = spec
    this.titleEl.textContent = spec.title
    this.subEl.textContent = spec.command ? `${spec.subtitle} — ${spec.command}` : spec.subtitle
    // A pane sharing its window cannot be sized on its own: its siblings
    // tile inside the same rectangle.
    this.badgeEl.hidden = spec.siblings <= 1
    this.badgeEl.textContent = 'tamaño acoplado'
    this.badgeEl.title = `Comparte la window con ${spec.siblings - 1} pane(s): redimensionarlo mueve la división. Usa ⧉ para desacoplarlo.`
    const decouple = this.el.querySelector<HTMLButtonElement>('button.decouple')
    if (decouple) decouple.hidden = spec.siblings <= 1
  }

  applyBox(): void {
    const { x, y, w, h, z } = this.box
    this.el.style.transform = `translate(${x}px, ${y}px)`
    this.el.style.width = `${w}px`
    this.el.style.height = `${h}px`
    this.el.style.zIndex = String(z)
  }

  /** Recompute cols/rows from the current box and tell the server. */
  resizeTerm(): void {
    const cols = colsFor(this.box.w, this.cell)
    const rows = rowsFor(this.box.h, this.cell)
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    this.term.resize(cols, rows)
    this.handlers.onResize(this.spec.id, cols, rows)
  }

  /**
   * Adopt the size tmux actually gave the pane. The server is authoritative,
   * so this never echoes a resize request back — that would oscillate.
   */
  applyGeometry(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.term.resize(cols, rows)
    const { w, h } = boxForCells(cols, rows, this.cell)
    this.box.w = w
    this.box.h = h
    this.applyBox()
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols || colsFor(this.box.w, this.cell), rows: this.rows || rowsFor(this.box.h, this.cell) }
  }

  setTheme(name: ThemeName): void {
    const { theme, minimumContrastRatio } = termTheme(name)
    this.term.options.theme = theme
    this.term.options.minimumContrastRatio = minimumContrastRatio
  }

  write(data: string): void {
    this.term.write(data)
  }

  setFocused(focused: boolean): void {
    this.focused = focused
    this.el.classList.toggle('focused', focused)
    if (focused) {
      this.setLod('near')
      this.term.focus()
    } else {
      this.term.blur()
    }
  }

  markDead(): void {
    this.dead = true
    this.el.classList.add('dead')
    this.term.write('\r\n\x1b[2m[terminal-canvas] la sesión terminó\x1b[0m\r\n')
  }

  /**
   * Level of detail. Zoomed far out we stop rendering live terminals and show
   * a plain-text snapshot instead — 12 xterm instances repainting at once is
   * what would otherwise melt the frame budget.
   */
  setLod(lod: 'near' | 'far'): void {
    if (lod === this.lod) return
    this.lod = lod
    this.el.dataset.lod = lod
    if (lod === 'far') this.refreshSnapshot()
  }

  get isFar(): boolean {
    return this.lod === 'far'
  }

  refreshSnapshot(): void {
    if (this.lod !== 'far') return
    const buf = this.term.buffer.active
    const start = Math.max(0, buf.baseY + buf.cursorY - this.rows + 1)
    const lines: string[] = []
    for (let i = start; i <= buf.baseY + buf.cursorY; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '')
    }
    this.snapshotEl.textContent = lines.join('\n')
  }

  /**
   * Drag-and-drop and paste of images. A browser gives us bytes, not a path,
   * so both roads end at the same place: hand the files up, and whatever
   * comes back gets typed into the pane.
   */
  private wireImages(): void {
    // dragenter/dragleave also fire crossing the terminal's inner elements,
    // so the overlay is driven by a depth count, not by the last event seen.
    let depth = 0
    const hideDrop = () => {
      depth = 0
      this.dropEl.hidden = true
    }

    this.body.addEventListener('dragenter', (ev) => {
      if (!hasFiles(ev.dataTransfer)) return
      ev.preventDefault()
      depth++
      this.dropEl.hidden = false
    })

    this.body.addEventListener('dragover', (ev) => {
      if (!hasFiles(ev.dataTransfer)) return
      ev.preventDefault()
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'
    })

    this.body.addEventListener('dragleave', () => {
      if (--depth <= 0) hideDrop()
    })

    this.body.addEventListener('drop', (ev) => {
      if (!hasFiles(ev.dataTransfer)) return
      // Claiming the drop here is also what tells the window-level handler
      // not to fall back to the focused tile.
      ev.preventDefault()
      hideDrop()
      this.handlers.onImages(this, imagesFrom(ev.dataTransfer))
    })

    // Capturing, and on the tile rather than the textarea, so an image on the
    // clipboard never reaches xterm — which would paste its filename as text.
    this.el.addEventListener(
      'paste',
      (ev: ClipboardEvent) => {
        const files = imagesFrom(ev.clipboardData)
        if (!files.length) return
        ev.preventDefault()
        ev.stopPropagation()
        this.handlers.onImages(this, files)
      },
      true,
    )
  }

  private wireDrag(head: HTMLElement): void {
    head.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return
      ev.stopPropagation()
      head.setPointerCapture(ev.pointerId)
      head.classList.add('dragging')
      this.handlers.onDragStart(this)

      const start = { x: ev.clientX, y: ev.clientY, bx: this.box.x, by: this.box.y }
      const scale = this.currentScale()

      const move = (e: PointerEvent) => {
        this.box.x = Math.round(start.bx + (e.clientX - start.x) / scale)
        this.box.y = Math.round(start.by + (e.clientY - start.y) / scale)
        this.applyBox()
        this.handlers.onDragMove(this, e.clientX, e.clientY)
      }
      const up = () => {
        head.classList.remove('dragging')
        head.removeEventListener('pointermove', move)
        head.removeEventListener('pointerup', up)
        head.removeEventListener('pointercancel', up)
        this.handlers.onDragEnd(this)
        this.handlers.onChange()
      }
      head.addEventListener('pointermove', move)
      head.addEventListener('pointerup', up)
      head.addEventListener('pointercancel', up)
    })
  }

  private wireResize(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return
      ev.stopPropagation()
      handle.setPointerCapture(ev.pointerId)
      this.handlers.onDragStart(this)

      const start = { x: ev.clientX, y: ev.clientY, w: this.box.w, h: this.box.h }
      const scale = this.currentScale()

      const move = (e: PointerEvent) => {
        const raw = {
          w: Math.max(240, start.w + (e.clientX - start.x) / scale),
          h: Math.max(HEAD_H + 60, start.h + (e.clientY - start.y) / scale),
        }
        const snapped = snapSize(raw.w, raw.h, this.cell)
        this.box.w = snapped.w
        this.box.h = snapped.h
        this.applyBox()
        this.resizeTerm()
      }
      const up = () => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', up)
        handle.removeEventListener('pointercancel', up)
        this.resizeTerm()
        this.handlers.onChange()
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
      handle.addEventListener('pointercancel', up)
    })
  }

  /** Live scale factor of the world, read off the parent transform. */
  private currentScale(): number {
    const world = this.el.parentElement
    if (!world) return 1
    const m = new DOMMatrixReadOnly(getComputedStyle(world).transform)
    return m.a || 1
  }

  dispose(): void {
    this.term.dispose()
    this.el.remove()
  }
}
