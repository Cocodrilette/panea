import '@xterm/xterm/css/xterm.css'
import './styles.css'

import { Activity } from './activity.ts'
import type { ClientMessage, Layout, ServerMessage, TileBox, TileSpec } from '../shared/protocol.ts'
import { fitTarget, flyTo, revealTarget } from './camera.ts'
import { highlight, rank, type Field } from './fuzzy.ts'
import { Groups, packByGroup } from './groups.ts'
import { hasFiles, imagesFrom, quotePath, uploadImage } from './images.ts'
import { arrowChord, nearestInDirection, type Direction } from './spatial.ts'
import { measureCell, snapSize, type Cell } from './metrics.ts'
import { Tile } from './tile.ts'
import { Viewport, type Rect } from './viewport.ts'
import { Views } from './views.ts'

const LOD_THRESHOLD = 0.55
const SNAPSHOT_MS = 1500
const GAP = 32

const root = document.getElementById('viewport') as HTMLDivElement
const world = document.getElementById('world') as HTMLDivElement
const statusEl = document.getElementById('status') as HTMLSpanElement
const zoomEl = document.getElementById('zoom-readout') as HTMLButtonElement
const projectsEl = document.getElementById('projects') as HTMLSelectElement
const toastsEl = document.getElementById('toasts') as HTMLDivElement
const sessionPanelEl = document.getElementById('session-picker-panel') as HTMLDivElement
const sessionSearchEl = document.getElementById('session-search') as HTMLInputElement
const sessionListEl = document.getElementById('session-list') as HTMLUListElement

/** Shared by reference with every tile, so a correction propagates. */
const cell: Cell = measureCell()
let DEFAULT_SIZE = snapSize(780, 460, cell)

const viewport = new Viewport(root, world)
const tiles = new Map<string, Tile>()
const groups = new Groups(root, world, () => tiles.values(), {
  zoom: () => viewport.zoom,
  toWorld: (x, y) => viewport.screenToWorld(x, y),
  layout: () => layout,
  save: () => saveLayout(),
})

let layout: Layout = { tiles: {}, viewport: viewport.state, hidden: [] }
const views = new Views(viewport, { layout: () => layout, save: () => saveLayout(), toast: (m, k) => void toast(m, k) })
let focused: Tile | null = null
let topZ = 1
let socket: WebSocket | null = null

const activity = new Activity({ jump: (t) => zoomToTile(t), toast: (m) => toast(m) })

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
      views.render()
      groups.refresh()
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
      activity.output(msg.id)
      break

    case 'geometry':
      tiles.get(msg.id)?.applyGeometry(msg.cols, msg.rows)
      activity.resized(msg.id)
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
  if (!sessionPanelEl.hidden) renderSessionList()
}

function addTile(spec: TileSpec): void {
  const box = layout.tiles[spec.id] ?? nextFreeBox()
  box.z = box.z || ++topZ
  topZ = Math.max(topZ, box.z)

  const tile = new Tile(spec, box, cell, {
    onInput: (id, data) => sendMsg({ type: 'input', id, data }),
    onResize: (id, cols, rows) => {
      activity.resized(id)
      sendMsg({ type: 'resize', id, cols, rows })
    },
    onFocus: (t) => focus(t),
    onChange: () => saveLayout(),
    onDragStart: (t) => raise(t),
    onDragMove: (t, x, y) => groups.tileDragMove(t, x, y),
    onDragEnd: (t) => groups.tileDragEnd(t),
    onClose: (t) => closeTile(t),
    onKill: (t) => killTile(t),
    onDecouple: (t) => decouplePane(t),
    onZoomTo: (t) => zoomToTile(t),
    onImages: (t, files) => void pasteImages(t, files),
    onMeasured: (real) => adoptCell(real),
    unscaled: (fn) => viewport.unscaled(fn),
  })

  world.appendChild(tile.el)
  tile.mount()
  tiles.set(spec.id, tile)
  activity.track(tile)
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
  activity.seen(tile)
}

function blurAll(): void {
  focused?.setFocused(false)
  focused = null
  activity.seen(null)
}

function raise(tile: Tile): void {
  tile.box.z = ++topZ
  tile.applyBox()
  saveLayout()
}

/* --------------------------------- images -------------------------------- */

/**
 * Turn images dropped on (or pasted into) a tile into what a native terminal
 * would have produced: their paths, typed at the prompt. No Enter — the user
 * still has a message to write around them.
 */
async function pasteImages(tile: Tile, files: File[]): Promise<void> {
  if (!files.length) {
    toast('solo se pueden soltar imágenes', 'warn')
    return
  }

  focus(tile)
  const pending = toast(files.length === 1 ? 'subiendo imagen…' : `subiendo ${files.length} imágenes…`, 'info', 0)

  const paths: string[] = []
  for (const file of files) {
    try {
      paths.push(await uploadImage(file))
    } catch (err) {
      toast(`no pude subir "${file.name || 'imagen'}": ${err instanceof Error ? err.message : err}`, 'error')
    }
  }

  pending.remove()
  if (!paths.length) return

  // A trailing space so the next thing typed does not glue itself to the path.
  sendMsg({ type: 'input', id: tile.spec.id, data: `${paths.map(quotePath).join(' ')} ` })
  toast(paths.length === 1 ? 'ruta pegada en la terminal' : `${paths.length} rutas pegadas en la terminal`)
}

// A file dropped anywhere else would otherwise make the browser navigate to
// it, losing the canvas. Dropped on the background it goes to the focused
// terminal, which is the only one that could have wanted it.
window.addEventListener('dragover', (ev) => {
  if (hasFiles(ev.dataTransfer)) ev.preventDefault()
})

window.addEventListener('drop', (ev) => {
  if (!hasFiles(ev.dataTransfer)) return
  // A tile that took the drop itself already called preventDefault, and this
  // has to be read before we call it ourselves.
  const claimed = ev.defaultPrevented
  ev.preventDefault()
  if (claimed) return
  if (!focused) {
    toast('arrastra la imagen sobre una terminal', 'warn')
    return
  }
  void pasteImages(focused, imagesFrom(ev.dataTransfer))
})

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
 * Pack the tiles, group by group (see packByGroup), without touching their sizes. A tile's size belongs
 * to its tmux pane, so laying out the canvas must never resize anything —
 * asking every tile of a shared window for a new size would just make them
 * fight over the window they live in.
 */
function packTiles(): void {
  if (!tiles.size) return
  packByGroup(tiles.values(), GAP, groups)
  for (const tile of tiles.values()) tile.applyBox()
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
  flyTo(viewport, fitTarget(viewport, tile.box, 60, 1))
  focus(tile)
}

/**
 * ⌘⌥/ctrl+⌥ + arrow: hand the keyboard to the nearest tile that way — from
 * the focused tile, or from the middle of the window when none is — and pan
 * just enough to show it, keeping the zoom.
 */
function moveFocus(dir: Direction): void {
  const c = viewport.screenToWorld(window.innerWidth / 2, window.innerHeight / 2)
  const from = focused?.box ?? { x: c.x, y: c.y, w: 0, h: 0 }
  const others = [...tiles.values()].filter((t) => t !== focused)
  const next = nearestInDirection(from, others, (t) => t.box, dir)
  if (!next) return
  flyTo(viewport, revealTarget(viewport, next.box))
  focus(next)
}

/* ---------------------------------- LOD ---------------------------------- */

function updateLod(): void {
  const far = viewport.zoom < LOD_THRESHOLD
  for (const tile of tiles.values()) tile.setLod(far && tile !== focused ? 'far' : 'near')
}

/* --------------------------------- popovers -------------------------------- */

/**
 * A trigger button + floating panel, toggled by click, dismissed by an
 * outside click or Escape. `panel.hidden` is the single source of truth for
 * open/closed — CSS must only ever key off that attribute (see .popover-panel).
 */
function createPopover(hostId: string, triggerId: string, panelId: string, onOpen?: () => void) {
  const host = document.getElementById(hostId) as HTMLDivElement
  const trigger = document.getElementById(triggerId) as HTMLButtonElement
  const panel = document.getElementById(panelId) as HTMLDivElement

  function open(): void {
    panel.hidden = false
    trigger.classList.add('active')
    onOpen?.()
  }
  function close(): void {
    panel.hidden = true
    trigger.classList.remove('active')
  }

  trigger.addEventListener('click', (ev) => {
    ev.stopPropagation()
    if (panel.hidden) open()
    else close()
  })
  document.addEventListener('pointerdown', (ev) => {
    if (!panel.hidden && !host.contains(ev.target as Node)) close()
  })
  host.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation()
      close()
    }
  })

  return { open, close }
}

const sessionPopover = createPopover('session-picker', 'session-picker-btn', 'session-picker-panel', () => {
  sessionQuery = ''
  sessionSel = 0
  sessionSearchEl.value = ''
  renderSessionList()
  sessionSearchEl.focus()
})
createPopover('more-menu', 'more-btn', 'more-panel')
createPopover('help-menu', 'help-btn', 'help-panel')

/* ------------------------------ session picker ---------------------------- */

let sessionQuery = ''
/** Index of the highlighted row; arrows move it, Enter picks it. */
let sessionSel = 0
let sessionRows: Tile[] = []

/** What the picker searches; the indexes are the ones the rows highlight. */
function jumpFields(tile: Tile): Field[] {
  const { title, subtitle, session, command, cwd } = tile.spec
  return [
    { text: title, weight: 1 },
    { text: subtitle, weight: 0.9 },
    { text: command, weight: 0.8 },
    { text: cwd, weight: 0.6 },
    { text: session, weight: 0.9 },
  ]
}

function renderSessionList(): void {
  const all = [...tiles.values()]
  const ranked = sessionQuery.trim()
    ? rank(all, sessionQuery, jumpFields)
    : all
        .sort((a, b) => a.spec.title.localeCompare(b.spec.title))
        .map((item) => ({ item, hits: new Map<number, number[]>() }))
  sessionRows = ranked.map((r) => r.item)
  sessionSel = Math.min(sessionSel, Math.max(0, sessionRows.length - 1))

  sessionListEl.textContent = ''
  if (!ranked.length) {
    const empty = document.createElement('li')
    empty.className = 'session-empty'
    empty.textContent = 'sin resultados'
    sessionListEl.appendChild(empty)
    return
  }

  ranked.forEach(({ item: tile, hits }, i) => {
    const { title, subtitle, command, cwd } = tile.spec
    const li = document.createElement('li')
    li.classList.toggle('selected', i === sessionSel)
    const head = document.createElement('span')
    head.className = 'session-item-title'
    head.append(highlight(title, hits.get(0)))
    const sub = document.createElement('span')
    sub.className = 'session-item-sub'
    sub.append(highlight(subtitle, hits.get(1)))
    if (command) sub.append(' — ', highlight(command, hits.get(2)))
    li.append(head, sub)
    // The session already shows in the subtitle; the cwd only earns a line
    // when it is what the query hit.
    if (hits.has(3)) {
      const dir = document.createElement('span')
      dir.className = 'session-item-sub'
      dir.append(highlight(cwd, hits.get(3)))
      li.append(dir)
    }
    // Keep the keyboard in the search box until the pick hands it over.
    li.addEventListener('pointerdown', (ev) => ev.preventDefault())
    li.addEventListener('click', () => pickSession(i))
    sessionListEl.appendChild(li)
  })
}

function pickSession(i: number): void {
  const tile = sessionRows[i]
  if (!tile) return
  sessionPopover.close()
  zoomToTile(tile)
}

function moveSessionSel(delta: number): void {
  if (!sessionRows.length) return
  sessionSel = (sessionSel + delta + sessionRows.length) % sessionRows.length
  const items = sessionListEl.children
  for (let i = 0; i < items.length; i++) items[i].classList.toggle('selected', i === sessionSel)
  items[sessionSel]?.scrollIntoView({ block: 'nearest' })
}

sessionSearchEl.addEventListener('input', () => {
  sessionQuery = sessionSearchEl.value
  sessionSel = 0
  renderSessionList()
})

sessionSearchEl.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown' || (ev.ctrlKey && ev.key === 'n')) {
    ev.preventDefault()
    moveSessionSel(1)
  } else if (ev.key === 'ArrowUp' || (ev.ctrlKey && ev.key === 'p')) {
    ev.preventDefault()
    moveSessionSel(-1)
  } else if (ev.key === 'Enter') {
    // Without this, the keypress that follows lands on the terminal that was
    // just focused and runs whatever sits at its prompt.
    ev.preventDefault()
    pickSession(sessionSel)
  }
})

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
  groups.setZoom(viewport.zoom)
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

/** `ms` of 0 keeps the toast up until the caller removes it. */
function toast(message: string, kind: 'info' | 'warn' | 'error' = 'info', ms?: number): HTMLDivElement {
  const el = document.createElement('div')
  el.className = `toast ${kind}`
  el.textContent = message
  toastsEl.appendChild(el)
  const life = ms ?? (kind === 'error' ? 9000 : 6000)
  if (life > 0) setTimeout(() => el.remove(), life)
  return el
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

/** So a fresh terminal has a name in the session picker instead of the generic "canvas". */
function spawnNamed(): void {
  const name = prompt('Nombre para la terminal (opcional):')
  if (name === null) return
  sendMsg({ type: 'spawn', name: name.trim() || undefined })
}

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
      spawnNamed()
      break
    case 'discover':
      layout.hidden = []
      sendMsg({ type: 'discover' })
      break
  }
})

window.addEventListener('keydown', (ev) => {
  const mod = ev.metaKey || ev.ctrlKey
  const dir = arrowChord(ev)
  if (dir) {
    ev.preventDefault()
    moveFocus(dir)
  } else if (mod && ev.key === '0') {
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
    spawnNamed()
  } else if (mod && (ev.key === 'r' || ev.key === 'R')) {
    ev.preventDefault()
    sendMsg({ type: 'discover' })
  } else if (mod && (ev.key === 'k' || ev.key === 'K')) {
    ev.preventDefault()
    if (sessionPanelEl.hidden) sessionPopover.open()
    else sessionPopover.close()
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

// El service worker es lo que hace que Chrome ofrezca "Instalar app"; si el
// registro falla (servido desde un host que no es loopback, p.ej.) la app
// sigue funcionando igual, sólo no se instala.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('[tcv] service worker:', err))
}

connect()
