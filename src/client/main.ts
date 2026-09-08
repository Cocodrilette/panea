import '@xterm/xterm/css/xterm.css'
import './styles.css'

import type { ClientMessage, Layout, ServerMessage, TileBox, TileSpec } from '../shared/protocol.ts'
import { measureCell, snapSize, type Cell } from './metrics.ts'
import { Tile } from './tile.ts'
import { Viewport, type Rect } from './viewport.ts'

const LOD_THRESHOLD = 0.55
const SNAPSHOT_MS = 1500
const GAP = 32

const root = document.getElementById('viewport') as HTMLDivElement
const world = document.getElementById('world') as HTMLDivElement
const statusEl = document.getElementById('status') as HTMLSpanElement
const zoomEl = document.getElementById('zoom-readout') as HTMLSpanElement
const projectsEl = document.getElementById('projects') as HTMLSelectElement
const toastsEl = document.getElementById('toasts') as HTMLDivElement

/** Shared by reference with every tile, so a correction propagates. */
const cell: Cell = measureCell()
let DEFAULT_SIZE = snapSize(780, 460, cell)

const viewport = new Viewport(root, world)
const tiles = new Map<string, Tile>()

let layout: Layout = { tiles: {}, viewport: viewport.state, hidden: [] }
let focused: Tile | null = null
let topZ = 1
let socket: WebSocket | null = null

/* ------------------------------- transport ------------------------------- */

function sendMsg(msg: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg))
}

function connect(attempt = 0): void {
  const ws = new WebSocket(`ws://${location.host}`)
  socket = ws

  ws.addEventListener('open', () => {
    statusEl.textContent = 'conectado'
    statusEl.className = 'ok'
  })

  ws.addEventListener('message', (ev) => {
    handle(JSON.parse(ev.data as string) as ServerMessage)
  })

  ws.addEventListener('close', () => {
    statusEl.textContent = 'reconectando…'
    statusEl.className = 'down'
    const delay = Math.min(5000, 300 * 2 ** attempt)
    setTimeout(() => connect(attempt + 1), delay)
  })

  ws.addEventListener('error', () => ws.close())
}

function handle(msg: ServerMessage): void {
  switch (msg.type) {
    case 'init':
      layout = msg.layout
      layoutWasFresh = !Object.keys(layout.tiles).length
      viewport.state = layout.viewport
      fillProjects(msg.projects)
      syncTiles(msg.tiles)
      if (layoutWasFresh) packTiles()
      if (layout.viewport.zoom === 1 && layout.viewport.x === 0 && layout.viewport.y === 0) fitAll()
      msg.warnings.forEach(warn)
      break

    case 'tiles':
      syncTiles(msg.tiles)
      msg.warnings.forEach(warn)
      break

    case 'output':
      tiles.get(msg.id)?.write(msg.data)
      break

    case 'geometry':
      tiles.get(msg.id)?.applyGeometry(msg.cols, msg.rows)
      saveLayout()
      schedulePack()
      break

    case 'exit':
      tiles.get(msg.id)?.markDead()
      break

    case 'error':
      toast(msg.message, 'error')
      break
  }
}

/* --------------------------------- tiles --------------------------------- */

function syncTiles(specs: TileSpec[]): void {
  const seen = new Set<string>()

  for (const spec of specs) {
    if (layout.hidden.includes(spec.id)) continue
    seen.add(spec.id)

    const existing = tiles.get(spec.id)
    if (existing) {
      existing.update(spec)
      continue
    }
    addTile(spec)
  }

  for (const [id, tile] of tiles) {
    if (seen.has(id)) continue
    tile.dispose()
    tiles.delete(id)
    if (focused === tile) focused = null
  }

  updateLod()
}

function addTile(spec: TileSpec): void {
  const box = layout.tiles[spec.id] ?? nextFreeBox()
  box.z = box.z || ++topZ
  topZ = Math.max(topZ, box.z)

  const tile = new Tile(spec, box, cell, {
    onInput: (id, data) => sendMsg({ type: 'input', id, data }),
    onResize: (id, cols, rows) => sendMsg({ type: 'resize', id, cols, rows }),
    onFocus: (t) => focus(t),
    onChange: () => saveLayout(),
    onDragStart: (t) => raise(t),
    onClose: (t) => closeTile(t),
    onKill: (t) => killTile(t),
    onDecouple: (t) => decouplePane(t),
    onZoomTo: (t) => zoomToTile(t),
    onMeasured: (real) => adoptCell(real),
    unscaled: (fn) => viewport.unscaled(fn),
  })

  world.appendChild(tile.el)
  tile.mount()
  tiles.set(spec.id, tile)
  layout.tiles[spec.id] = tile.box

  const { cols, rows } = tile.size
  sendMsg({ type: 'open', id: spec.id, cols, rows })
  saveLayout()
}

/**
 * Trust the cell size reported by a real mounted terminal over the one we
 * measured up front, and re-snap the tiles so no terminal overflows its tile.
 */
function adoptCell(real: Cell): void {
  if (Math.abs(real.w - cell.w) < 0.25 && Math.abs(real.h - cell.h) < 0.25) return
  cell.w = real.w
  cell.h = real.h
  DEFAULT_SIZE = snapSize(780, 460, cell)
  // Re-snap to the cols/rows tmux already gave us; asking for a new size
  // here would make every tile of a shared window fight its siblings.
  for (const tile of tiles.values()) {
    const { cols, rows } = tile.size
    tile.applyGeometry(cols, rows)
  }
  saveLayout()
}

function closeTile(tile: Tile): void {
  sendMsg({ type: 'close', id: tile.spec.id })
  if (!layout.hidden.includes(tile.spec.id)) layout.hidden.push(tile.spec.id)
  delete layout.tiles[tile.spec.id]
  tile.dispose()
  tiles.delete(tile.spec.id)
  if (focused === tile) focused = null
  saveLayout()
}

function killTile(tile: Tile): void {
  const ok = confirm(
    `¿Matar la window de tmux "${tile.spec.title}"?\n\nEsto termina sus procesos (${tile.spec.command || 'shell'}).`,
  )
  if (!ok) return
  sendMsg({ type: 'kill', id: tile.spec.id })
  tile.dispose()
  tiles.delete(tile.spec.id)
  delete layout.tiles[tile.spec.id]
  if (focused === tile) focused = null
  saveLayout()
}

/**
 * Breaking a pane out rearranges the user's real tmux session (a window is
 * added, indexes shift), so it is never implicit.
 */
function decouplePane(tile: Tile): void {
  const ok = confirm(
    `¿Sacar "${tile.spec.title}" a su propia window de tmux?\n\n` +
      'Su tamaño deja de estar acoplado a los otros panes de la window. El proceso sigue ' +
      'corriendo, pero cambia el layout de tu sesión de tmux.',
  )
  if (!ok) return
  sendMsg({ type: 'decouple', id: tile.spec.id })
}

function focus(tile: Tile): void {
  if (focused === tile) return
  focused?.setFocused(false)
  focused = tile
  raise(tile)
  tile.setFocused(true)
}

function blurAll(): void {
  focused?.setFocused(false)
  focused = null
}

function raise(tile: Tile): void {
  tile.box.z = ++topZ
  tile.applyBox()
  saveLayout()
}

/* -------------------------------- placement ------------------------------- */

function nextFreeBox(): TileBox {
  const taken = [...tiles.values()].map((t) => t.box)
  const cols = 3
  for (let i = 0; i < 400; i++) {
    const box: TileBox = {
      x: (i % cols) * (DEFAULT_SIZE.w + GAP),
      y: Math.floor(i / cols) * (DEFAULT_SIZE.h + GAP),
      w: DEFAULT_SIZE.w,
      h: DEFAULT_SIZE.h,
      z: 0,
    }
    if (!taken.some((b) => overlaps(b, box))) return box
  }
  return { x: 0, y: 0, w: DEFAULT_SIZE.w, h: DEFAULT_SIZE.h, z: 0 }
}

function overlaps(a: TileBox, b: TileBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/**
 * Pack the tiles into rows without touching their sizes. A tile's size belongs
 * to its tmux pane, so laying out the canvas must never resize anything —
 * asking every tile of a shared window for a new size would just make them
 * fight over the window they live in.
 */
function packTiles(): void {
  const list = [...tiles.values()].sort((a, b) => a.spec.id.localeCompare(b.spec.id))
  if (!list.length) return

  const maxRowWidth = Math.max(...list.map((t) => t.box.w)) * 3 + GAP * 2
  let x = 0
  let y = 0
  let rowHeight = 0

  for (const tile of list) {
    if (x > 0 && x + tile.box.w > maxRowWidth) {
      x = 0
      y += rowHeight + GAP
      rowHeight = 0
    }
    tile.box.x = x
    tile.box.y = y
    tile.applyBox()
    x += tile.box.w + GAP
    rowHeight = Math.max(rowHeight, tile.box.h)
  }
  saveLayout()
  fitAll()
}

/**
 * On a fresh canvas the tiles are placed before tmux has told us how big each
 * pane really is, so pack them again once the sizes have settled.
 */
let packTimer: number | undefined
let packedOnce = false
/** Only a canvas with no saved positions may be rearranged automatically. */
let layoutWasFresh = false

function schedulePack(): void {
  if (packedOnce || !layoutWasFresh) return
  clearTimeout(packTimer)
  packTimer = setTimeout(() => {
    packedOnce = true
    packTiles()
  }, 700) as unknown as number
}

function bounds(): Rect | null {
  const list = [...tiles.values()]
  if (!list.length) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const { box } of list) {
    x0 = Math.min(x0, box.x)
    y0 = Math.min(y0, box.y)
    x1 = Math.max(x1, box.x + box.w)
    y1 = Math.max(y1, box.y + box.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

function fitAll(): void {
  const b = bounds()
  if (b) viewport.fit(b)
}

function zoomToTile(tile: Tile): void {
  viewport.fit(tile.box, 60, 1)
  focus(tile)
}

/* ---------------------------------- LOD ---------------------------------- */

function updateLod(): void {
  const far = viewport.zoom < LOD_THRESHOLD
  for (const tile of tiles.values()) tile.setLod(far && tile !== focused ? 'far' : 'near')
}

setInterval(() => {
  for (const tile of tiles.values()) if (tile.isFar) tile.refreshSnapshot()
}, SNAPSHOT_MS)

/* --------------------------------- layout -------------------------------- */

let saveTimer: number | undefined
function saveLayout(): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    layout.viewport = viewport.state
    for (const [id, tile] of tiles) layout.tiles[id] = tile.box
    sendMsg({ type: 'layout', layout })
  }, 300) as unknown as number
}

viewport.onChange = () => {
  zoomEl.textContent = `${Math.round(viewport.zoom * 100)}%`
  updateLod()
  saveLayout()
}

/* --------------------------------- chrome -------------------------------- */

/** Warnings arrive with every tile update; show each one once. */
const shownWarnings = new Set<string>()

function warn(message: string): void {
  if (shownWarnings.has(message)) return
  shownWarnings.add(message)
  toast(message, 'warn')
}

function toast(message: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
  const el = document.createElement('div')
  el.className = `toast ${kind}`
  el.textContent = message
  toastsEl.appendChild(el)
  setTimeout(() => el.remove(), kind === 'error' ? 9000 : 6000)
}

function fillProjects(projects: string[]): void {
  projectsEl.textContent = ''
  const head = document.createElement('option')
  head.value = ''
  head.textContent = 'tmuxinator…'
  projectsEl.appendChild(head)
  for (const name of projects) {
    const opt = document.createElement('option')
    opt.value = name
    opt.textContent = name
    projectsEl.appendChild(opt)
  }
}

projectsEl.addEventListener('change', () => {
  const name = projectsEl.value
  projectsEl.value = ''
  if (!name) return
  toast(`arrancando ${name}…`)
  sendMsg({ type: 'start-project', name })
})

document.getElementById('toolbar')?.addEventListener('click', (ev) => {
  const act = (ev.target as HTMLElement).closest('button')?.dataset.act
  switch (act) {
    case 'fit':
      fitAll()
      break
    case 'reset':
      viewport.setZoom(1)
      break
    case 'grid':
      packTiles()
      break
    case 'new':
      sendMsg({ type: 'spawn' })
      break
    case 'discover':
      layout.hidden = []
      sendMsg({ type: 'discover' })
      break
  }
})

window.addEventListener('keydown', (ev) => {
  const mod = ev.metaKey || ev.ctrlKey
  if (mod && ev.key === '0') {
    ev.preventDefault()
    fitAll()
  } else if (mod && ev.key === '1') {
    ev.preventDefault()
    viewport.setZoom(1)
  } else if (mod && (ev.key === 'g' || ev.key === 'G')) {
    ev.preventDefault()
    packTiles()
  } else if (mod && (ev.key === 't' || ev.key === 'T')) {
    ev.preventDefault()
    sendMsg({ type: 'spawn' })
  } else if (mod && (ev.key === 'r' || ev.key === 'R')) {
    ev.preventDefault()
    sendMsg({ type: 'discover' })
  } else if (ev.key === 'Escape' && mod) {
    // Escape alone belongs to the terminal (vim); ⌘/ctrl+esc drops focus.
    ev.preventDefault()
    blurAll()
  }
})

root.addEventListener('pointerdown', (ev) => {
  if (ev.target === root || ev.target === world) blurAll()
})

window.addEventListener('resize', () => viewport.apply())
window.addEventListener('beforeunload', () => {
  layout.viewport = viewport.state
  sendMsg({ type: 'layout', layout })
})

connect()
