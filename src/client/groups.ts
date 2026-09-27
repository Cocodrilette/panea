/**
 * Session frames: a labeled rectangle behind every tile of one tmux session.
 *
 * A frame has no position of its own — it is always the padded bounding box
 * of its tiles, so there is nothing extra to persist. Moving a frame moves its
 * tiles, and the tiles' boxes are what the layout already saves.
 */
import type { TileBox } from '../shared/protocol.ts'
import type { Tile } from './tile.ts'

/** Room around the tiles, in world px. */
const PAD = 18
/** Header strip above the tiles, in world px at 100% zoom. */
const HEAD = 34
/**
 * Below 100% the header and its label grow in world units so they keep the
 * same size on screen: zoomed out is exactly when the frames are what you
 * navigate by.
 */
const MAX_LABEL_SCALE = 1 / 0.12
/**
 * Past this zoom (main.ts's LOD threshold) a grown label no longer fits in
 * the gap above its tiles and would hide under a neighbouring group's, so the
 * headers are lifted above the tiles — which by then are only snapshots.
 */
const FAR_ZOOM = 0.55

export interface GroupHandlers {
  /** Live world scale, to turn a pointer delta into world px. */
  zoom(): number
  /** A frame drag moved its tiles; persist their boxes. */
  onMoved(): void
}

interface Frame {
  el: HTMLDivElement
  label: HTMLSpanElement
  count: HTMLSpanElement
}

export class Groups {
  private readonly frames = new Map<string, Frame>()
  private readonly observer: MutationObserver
  private queued = false

  constructor(
    private readonly world: HTMLElement,
    private readonly tiles: () => Iterable<Tile>,
    private readonly handlers: GroupHandlers,
  ) {
    // Tiles don't announce their moves, but every one of them — drag,
    // resize, tmux's geometry reply, a repack — ends in a write to the tile's
    // inline style, and adding or removing one is a child of the world. So
    // the frames watch for exactly that instead of every caller remembering
    // to tell them. Only the tile elements themselves are observed: the
    // terminals inside repaint constantly and must not wake this up.
    this.observer = new MutationObserver((records) => {
      if (records.some((r) => r.type === 'childList' && r.target === this.world)) this.observeTiles()
      this.schedule()
    })
    this.observer.observe(world, { childList: true })
    this.observeTiles()
    this.setZoom(handlers.zoom())
  }

  /** Keep the label legible on screen when zoomed out. */
  setZoom(zoom: number): void {
    const s = Math.min(MAX_LABEL_SCALE, Math.max(1, 1 / zoom))
    this.world.style.setProperty('--group-scale', String(s))
    this.world.toggleAttribute('data-groups-far', zoom < FAR_ZOOM)
  }

  private observeTiles(): void {
    for (const tile of this.tiles()) this.observer.observe(tile.el, { attributes: true, attributeFilter: ['style'] })
  }

  private schedule(): void {
    if (this.queued) return
    this.queued = true
    requestAnimationFrame(() => {
      this.queued = false
      this.render()
    })
  }

  private render(): void {
    const bySession = groupBySession(this.tiles())

    for (const [session, frame] of this.frames) {
      if (bySession.has(session)) continue
      frame.el.remove()
      this.frames.delete(session)
    }

    for (const [session, list] of bySession) {
      const frame = this.frames.get(session) ?? this.create(session)
      const b = boundsOf(list.map((t) => t.box))
      const { style } = frame.el
      // left/top, not a transform like the tiles: a transform would make the
      // frame a stacking context and keep its header from rising above them.
      style.left = `${b.x - PAD}px`
      style.top = `${b.y - PAD - HEAD}px`
      style.width = `${b.w + PAD * 2}px`
      style.height = `${b.h + PAD * 2 + HEAD}px`
      frame.count.textContent = list.length === 1 ? '1 pane' : `${list.length} panes`
    }
  }

  private create(session: string): Frame {
    const el = document.createElement('div')
    el.className = 'group-frame'
    el.dataset.session = session
    el.style.setProperty('--group-hue', String(hueOf(session)))

    const head = document.createElement('div')
    head.className = 'group-head'
    head.title = `Arrastrar para mover todos los tiles de "${session}"`
    const label = document.createElement('span')
    label.className = 'group-label'
    label.textContent = session
    const count = document.createElement('span')
    count.className = 'group-count'
    head.append(label, count)
    el.append(head)

    this.wireDrag(head, session)
    // Before the tiles, so equal z-indexes still paint the frame underneath.
    this.world.prepend(el)
    const frame = { el, label, count }
    this.frames.set(session, frame)
    return frame
  }

  /** Dragging the header drags every tile of the session by the same delta. */
  private wireDrag(head: HTMLElement, session: string): void {
    head.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return
      // Neither a pan of the canvas nor a blur of the focused tile.
      ev.stopPropagation()
      head.setPointerCapture(ev.pointerId)
      head.classList.add('dragging')

      const members = [...this.tiles()].filter((t) => t.spec.session === session)
      const origin = members.map((t) => ({ tile: t, x: t.box.x, y: t.box.y }))
      const start = { x: ev.clientX, y: ev.clientY }
      const scale = this.handlers.zoom()

      const move = (e: PointerEvent) => {
        const dx = (e.clientX - start.x) / scale
        const dy = (e.clientY - start.y) / scale
        for (const o of origin) {
          o.tile.box.x = Math.round(o.x + dx)
          o.tile.box.y = Math.round(o.y + dy)
          o.tile.applyBox()
        }
      }
      const up = () => {
        head.classList.remove('dragging')
        head.removeEventListener('pointermove', move)
        head.removeEventListener('pointerup', up)
        head.removeEventListener('pointercancel', up)
        this.handlers.onMoved()
      }
      head.addEventListener('pointermove', move)
      head.addEventListener('pointerup', up)
      head.addEventListener('pointercancel', up)
    })
  }
}

/**
 * Pack tiles session by session: each session's tiles into rows of their own,
 * then the sessions side by side, wrapping into rows of sessions once a row
 * gets wide. Like the flat pack, positions only — a tile's size belongs to its
 * tmux pane. Mutates the boxes; the caller applies them.
 */
export function packBySession(tiles: Iterable<Tile>, gap: number): void {
  const groups = [...groupBySession(tiles)].sort(([a], [b]) => a.localeCompare(b))
  if (!groups.length) return

  // Pack each group at the origin first, to learn its footprint.
  const packed = groups.map(([, list]) => {
    list.sort((a, b) => a.spec.id.localeCompare(b.spec.id))
    const perRow = Math.min(3, Math.ceil(Math.sqrt(list.length)))
    const maxRowWidth = Math.max(...list.map((t) => t.box.w)) * perRow + gap * (perRow - 1)
    let x = 0
    let y = 0
    let rowHeight = 0
    for (const tile of list) {
      if (x > 0 && x + tile.box.w > maxRowWidth) {
        x = 0
        y += rowHeight + gap
        rowHeight = 0
      }
      tile.box.x = x
      tile.box.y = y
      x += tile.box.w + gap
      rowHeight = Math.max(rowHeight, tile.box.h)
    }
    return { list, ...boundsOf(list.map((t) => t.box)) }
  })

  // Between two groups sit both frames' padding and header, plus the gap.
  const gapX = PAD * 2 + gap * 2
  const gapY = PAD * 2 + HEAD + gap * 2
  // Aim for a landscape canvas — wider than the screen's 16:10, since rows of
  // uneven groups leave holes — but never narrower than the widest group.
  const area = packed.reduce((sum, g) => sum + (g.w + gapX) * (g.h + gapY), 0)
  const rowWidth = Math.max(...packed.map((g) => g.w), Math.sqrt(area * 2.4))

  let x = 0
  let y = 0
  let rowHeight = 0
  for (const g of packed) {
    if (x > 0 && x + g.w > rowWidth) {
      x = 0
      y += rowHeight + gapY
      rowHeight = 0
    }
    for (const tile of g.list) {
      tile.box.x += x
      tile.box.y += y
    }
    x += g.w + gapX
    rowHeight = Math.max(rowHeight, g.h)
  }
}

function groupBySession(tiles: Iterable<Tile>): Map<string, Tile[]> {
  const out = new Map<string, Tile[]>()
  for (const tile of tiles) {
    const list = out.get(tile.spec.session)
    if (list) list.push(tile)
    else out.set(tile.spec.session, [tile])
  }
  return out
}

function boundsOf(boxes: TileBox[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const b of boxes) {
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.w)
    y1 = Math.max(y1, b.y + b.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * A stable hue per session name, so a session keeps its tint across reloads.
 * FNV-1a, then spread by the golden angle: tmuxinator names like `api-1` and
 * `api-2` differ in one character and would otherwise land on the same hue.
 */
function hueOf(name: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0
  return Math.round((h * 137.508) % 360)
}
