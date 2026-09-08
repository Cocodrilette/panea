/**
 * terminal-canvas server: static file host + WebSocket bridge over tmux
 * control mode.
 *
 * One control-mode client per base session (not per tile) carries the output of
 * every pane in that session, so a tile is just a route: pane id → browser.
 * Nothing here owns a tmux session, which means the canvas cannot keep a
 * window — or its processes — alive behind the user's back: when a session is
 * destroyed its control client exits and the tiles die with it.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn as spawnProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { WebSocketServer, type WebSocket } from 'ws'

import type { ClientMessage, ServerMessage, TileSpec } from '../shared/protocol.ts'
import { ControlClient, toHexKeys } from './control.ts'
import {
  capturePane,
  decouplePane,
  discoverTiles,
  killPane,
  pruneLegacyViews,
  releaseAllWindowSizes,
  releaseWindowSize,
  serverRunning,
  sizePane,
  spawnShell,
} from './tmux.ts'
import { listProjects, loadLayout, saveLayout, startProject } from './store.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const DIST = join(ROOT, 'dist')
const PORT = Number(process.env.TCV_PORT ?? process.argv[2] ?? 7788)
const HOST = process.env.TCV_HOST ?? '127.0.0.1'

/** An open tile: a pane routed to the browsers watching it. */
interface Route {
  spec: TileSpec
  /** Per-pane decoder: a UTF-8 char can straddle two %output messages. */
  decoder: StringDecoder
  buffer: string
  flush: NodeJS.Immediate | null
}

const routes = new Map<string, Route>()
/** paneId → tile id, for routing %output. */
const byPane = new Map<string, string>()
/** One control client per base session, shared by all its tiles. */
const controls = new Map<string, ControlClient>()
const clients = new Set<WebSocket>()

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const http = createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0])
  const rel = path === '/' ? 'index.html' : normalize(path).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '')
  try {
    const body = await readFile(join(DIST, rel))
    res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found — ¿corriste `npm run build`?')
  }
})

const wss = new WebSocketServer({ server: http })

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(msg: ServerMessage): void {
  for (const ws of clients) send(ws, msg)
}

async function specFor(id: string): Promise<TileSpec | undefined> {
  const { tiles } = await discoverTiles()
  return tiles.find((t) => t.id === id)
}

/* ----------------------------- control clients ---------------------------- */

function controlFor(session: string): ControlClient {
  const existing = controls.get(session)
  if (existing?.alive) return existing

  const client: ControlClient = new ControlClient(session, {
    onOutput: (paneId, data) => {
      const tileId = byPane.get(paneId)
      if (!tileId) return
      const route = routes.get(tileId)
      if (!route) return

      route.buffer += route.decoder.write(data)
      if (route.flush) return
      route.flush = setImmediate(() => {
        route.flush = null
        const payload = route.buffer
        route.buffer = ''
        if (payload) broadcast({ type: 'output', id: tileId, data: payload })
      })
    },

    onLayoutChange: () => void pushTiles(),

    onExit: (reason) => {
      controls.delete(session)
      // The session is gone (or tmux is): every tile on it is over.
      for (const route of [...routes.values()]) {
        if (route.spec.session !== session) continue
        console.log(`[tcv] la sesión "${session}" terminó (${reason}): cierro el tile ${route.spec.id}`)
        dropRoute(route.spec.id)
        broadcast({ type: 'exit', id: route.spec.id })
      }
      void pushTiles()
    },
  })

  controls.set(session, client)
  return client
}

function dropRoute(id: string): void {
  const route = routes.get(id)
  if (!route) return
  byPane.delete(route.spec.paneId)
  routes.delete(id)

  // Last tile of a session? Then its control client has nothing left to carry.
  const stillUsed = [...routes.values()].some((r) => r.spec.session === route.spec.session)
  if (!stillUsed) {
    controls.get(route.spec.session)?.close()
    controls.delete(route.spec.session)
  }

  const windowStillUsed = [...routes.values()].some((r) => r.spec.windowId === route.spec.windowId)
  if (!windowStillUsed) void releaseWindowSize(route.spec.windowId)
}

/* --------------------------------- tiles --------------------------------- */

async function openTile(ws: WebSocket, id: string, cols: number, rows: number): Promise<void> {
  const spec = await specFor(id)
  if (!spec) {
    send(ws, { type: 'error', message: `tile desconocido: ${id}` })
    return
  }

  const known = routes.get(id)
  if (known) {
    // A second browser (or a reload): repaint from the current screen.
    send(ws, { type: 'output', id, data: await capturePane(spec.paneId) })
    const size = await sizePane(spec, cols, rows, false)
    send(ws, { type: 'geometry', id, ...size })
    return
  }

  controlFor(spec.session)

  routes.set(id, { spec, decoder: new StringDecoder('utf8'), buffer: '', flush: null })
  byPane.set(spec.paneId, id)

  const size = await sizePane(spec, cols, rows, false)
  // Paint what is on screen now; %output only carries what comes next.
  send(ws, { type: 'output', id, data: await capturePane(spec.paneId) })
  broadcast({ type: 'geometry', id, ...size })
}

function closeTile(id: string): void {
  dropRoute(id)
}

async function killTile(id: string): Promise<void> {
  const spec = routes.get(id)?.spec ?? (await specFor(id))
  dropRoute(id)
  if (spec) await killPane(spec)
  await pushTiles()
}

async function pushTiles(): Promise<void> {
  const { tiles, warnings } = await discoverTiles()

  // Keep every route's spec fresh: pane indexes and sibling counts shift when
  // panes are added, closed or broken out.
  for (const tile of tiles) {
    const route = routes.get(tile.id)
    if (!route) continue
    if (route.spec.paneId !== tile.paneId) {
      byPane.delete(route.spec.paneId)
      byPane.set(tile.paneId, tile.id)
    }
    route.spec = tile
  }

  broadcast({ type: 'tiles', tiles, warnings })
}

/* ------------------------------- websocket ------------------------------- */

wss.on('connection', async (ws) => {
  clients.add(ws)

  const { tiles, warnings } = await discoverTiles()
  send(ws, { type: 'init', tiles, layout: loadLayout(), projects: listProjects(), warnings })

  ws.on('message', async (raw) => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(String(raw)) as ClientMessage
    } catch {
      return
    }

    try {
      switch (msg.type) {
        case 'open':
          await openTile(ws, msg.id, msg.cols, msg.rows)
          break

        case 'input': {
          const route = routes.get(msg.id)
          if (!route) break
          // Fire and forget: a keystroke must not wait for a command reply.
          controlFor(route.spec.session).write(`send-keys -t ${route.spec.paneId} -H ${toHexKeys(msg.data)}`)
          break
        }

        case 'resize': {
          const route = routes.get(msg.id)
          if (!route) break
          // A resize message only ever comes from the user dragging a tile.
          const size = await sizePane(route.spec, msg.cols, msg.rows, true)
          if (size.cols !== route.spec.cols || size.rows !== route.spec.rows) {
            route.spec = { ...route.spec, ...size }
          }
          broadcast({ type: 'geometry', id: msg.id, ...size })
          break
        }

        case 'close':
          closeTile(msg.id)
          break

        case 'kill':
          await killTile(msg.id)
          break

        case 'layout':
          saveLayout(msg.layout)
          break

        case 'discover':
          await pushTiles()
          break

        case 'decouple': {
          const spec = routes.get(msg.id)?.spec ?? (await specFor(msg.id))
          if (!spec) break
          if (!(await decouplePane(spec))) {
            send(ws, { type: 'error', message: 'Este pane ya es el único de su window.' })
            break
          }
          // Its id changes with its new window, so the old route is stale.
          dropRoute(msg.id)
          broadcast({ type: 'exit', id: msg.id })
          await pushTiles()
          break
        }

        case 'spawn':
          await spawnShell(msg.cwd ?? process.env.HOME ?? '.', msg.command, 100, 30)
          await pushTiles()
          break

        case 'start-project':
          await startProject(msg.name)
          await pushTiles()
          break
      }
    } catch (err) {
      send(ws, { type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  })

  ws.on('close', () => clients.delete(ws))
})

/* -------------------------------- startup -------------------------------- */

if (!(await serverRunning())) {
  console.error(
    '[tcv] no hay un servidor tmux corriendo. Arranca algo (p.ej. `tmuxinator start unergy --no-attach`) y vuelve a intentar.',
  )
} else {
  const pruned = await pruneLegacyViews()
  if (pruned) console.log(`[tcv] limpié ${pruned} sesión(es) del diseño anterior`)
}

http.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`
  console.log(`[tcv] terminal-canvas en ${url}`)
  if (!process.env.TCV_NO_OPEN && process.platform === 'darwin') {
    spawnProcess('open', [url], { stdio: 'ignore', detached: true }).unref()
  }
})

let shuttingDown = false

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(0)
    shuttingDown = true
    // Hand window sizing back to tmux and detach; the sessions keep running.
    for (const client of controls.values()) client.close()
    const timeout = setTimeout(() => process.exit(0), 1500)
    void releaseAllWindowSizes().finally(() => {
      clearTimeout(timeout)
      process.exit(0)
    })
  })
}
