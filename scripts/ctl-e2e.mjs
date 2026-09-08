/**
 * End-to-end test of the control-mode transport, against a throwaway session.
 *
 * Covers: pane-level discovery, initial paint, keystrokes, exact sizing for a
 * lone pane, honest sizing for a coupled pane, and the lifecycle rule that
 * broke before — destroying the session must take its tiles and processes.
 *
 * Run with the canvas server listening on PORT.
 */
import { execFileSync } from 'node:child_process'

const PORT = process.env.PORT ?? '7799'
const LAB = 'tcve2e'
const log = (...a) => console.log('[e2e]', ...a)

const tmux = (args) => execFileSync('tmux', args, { encoding: 'utf8' }).trim()
const tmuxTry = (args) => {
  try {
    return tmux(args)
  } catch {
    return ''
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  log(`${ok ? 'OK  ' : 'FALLO'} ${label}${detail ? ` — ${detail}` : ''}`)
}

tmuxTry(['kill-session', '-t', `=${LAB}`])
tmux(['new-session', '-d', '-s', LAB, '-n', 'solo', '-x', '100', '-y', '30'])
tmux(['new-window', '-t', `=${LAB}`, '-n', 'duo'])
tmux(['split-window', '-t', `=${LAB}:duo`, '-v'])
tmux(['send-keys', '-t', `=${LAB}:solo`, 'sleep 3600', 'Enter'])
await sleep(700)

const soloPid = tmux(['list-panes', '-t', `=${LAB}:solo`, '-F', '#{pane_pid}'])
log(`laboratorio "${LAB}": window solo (1 pane, pid ${soloPid}) + window duo (2 panes)`)

const out = new Map()
const geometry = new Map()
const exits = new Set()
let tiles = []
let ready = null

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
const send = (m) => ws.send(JSON.stringify(m))
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(String(ev.data))
  if (m.type === 'init' || m.type === 'tiles') {
    tiles = m.tiles
    ready?.()
  }
  if (m.type === 'output') out.set(m.id, (out.get(m.id) ?? '') + m.data)
  if (m.type === 'geometry') geometry.set(m.id, m)
  if (m.type === 'exit') exits.add(m.id)
  if (m.type === 'error') log('!! error del servidor:', m.message)
})

await new Promise((r) => {
  ready = r
  setTimeout(r, 6000)
})

const solo = tiles.find((t) => t.session === LAB && t.title === 'solo')
const duo0 = tiles.find((t) => t.session === LAB && t.title === 'duo.0')
const duo1 = tiles.find((t) => t.session === LAB && t.title === 'duo.1')

check(!!solo && solo.siblings === 1, 'el pane solitario se descubre sin hermanos', solo?.id)
check(!!duo0 && duo0.siblings === 2, 'los panes de una window compartida se descubren por separado', `${duo0?.id}, ${duo1?.id}`)
if (!solo || !duo0) {
  tmuxTry(['kill-session', '-t', `=${LAB}`])
  process.exit(1)
}

// --- exact sizing for a lone pane -----------------------------------------
send({ type: 'open', id: solo.id, cols: 90, rows: 25 })
await sleep(1200)
const g = geometry.get(solo.id)
check(g?.cols === 90 && g?.rows === 25, 'un pane solo recibe el tamaño exacto pedido', `pedí 90x25, dio ${g?.cols}x${g?.rows}`)
const real = tmux(['display-message', '-p', '-t', solo.paneId, '#{pane_width}x#{pane_height}'])
check(real === '90x25', 'tmux realmente aplicó ese tamaño al pane', real)
check((out.get(solo.id) ?? '').length > 0, 'llegó el repintado inicial de la pantalla', `${(out.get(solo.id) ?? '').length} bytes`)

// --- keystrokes ------------------------------------------------------------
out.set(solo.id, '')
send({ type: 'input', id: solo.id, data: '' }) // Ctrl-C, para salir del sleep
await sleep(400)
send({ type: 'input', id: solo.id, data: 'echo E2E_ñ_OK\r' })
await sleep(1200)
const echoed = out.get(solo.id) ?? ''
check(echoed.includes('E2E_ñ_OK'), 'las teclas llegan al pane (UTF-8 incluido)', JSON.stringify(echoed.slice(-60)))

// --- honest sizing for a coupled pane -------------------------------------
send({ type: 'open', id: duo0.id, cols: 80, rows: 20 })
await sleep(1200)
const gd = geometry.get(duo0.id)
const realDuo = tmux(['display-message', '-p', '-t', duo0.paneId, '#{pane_width}x#{pane_height}'])
check(!!gd, 'un pane acoplado también reporta su geometría', `${gd?.cols}x${gd?.rows}`)
check(`${gd?.cols}x${gd?.rows}` === realDuo, 'la geometría reportada es la real, no la pedida', `reportado ${gd?.cols}x${gd?.rows} vs tmux ${realDuo}`)

// --- an explicit drag must not starve a sibling ----------------------------
send({ type: 'open', id: duo1.id, cols: 80, rows: 20 })
await sleep(800)
send({ type: 'resize', id: duo0.id, cols: 100, rows: 200 })
await sleep(1500)
const sizes = tmuxTry(['list-panes', '-t', duo0.windowId, '-F', '#{pane_id} #{pane_width}x#{pane_height}'])
  .split('\n')
  .filter(Boolean)
const starved = sizes.filter((l) => {
  const h = Number(l.split('x')[1])
  return h < 3
})
check(starved.length === 0, 'un arrastre enorme no deja al hermano en 1 fila', sizes.join(' | '))

// --- no extra sessions, no extra terminal clients -------------------------
const sessions = tmuxTry(['list-sessions', '-F', '#{session_name}']).split('\n').filter(Boolean)
check(!sessions.some((s) => s.startsWith('tcv_')), 'el canvas no creó ninguna sesión de vista', sessions.join(' '))
const controlClients = tmuxTry(['list-clients', '-F', '#{client_session} #{client_control_mode}'])
  .split('\n')
  .filter((l) => l.endsWith(' 1'))
check(controlClients.length >= 1, 'usa clientes de control, no sesiones', controlClients.join(' | '))
check(
  controlClients.filter((l) => l.startsWith(LAB + ' ')).length === 1,
  'un solo cliente de control por sesión, con dos tiles abiertos',
  `${controlClients.filter((l) => l.startsWith(LAB + ' ')).length} cliente(s) para ${LAB}`,
)

// --- lifecycle: destroying the session must take everything with it -------
log(`matando la sesión base "${LAB}"`)
tmuxTry(['kill-session', '-t', `=${LAB}`])
await sleep(2500)

check(!alive(soloPid), 'el proceso del pane murió con su sesión', `pid ${soloPid}`)
check(exits.has(solo.id) && exits.has(duo0.id), 'los tiles fueron notificados', [...exits].join(' '))
check(
  !tmuxTry(['list-clients', '-F', '#{client_session}']).split('\n').includes(LAB),
  'no quedó ningún cliente colgado',
)

log(failures ? `\n${failures} comprobación(es) fallaron` : '\nTodas las comprobaciones pasaron')
ws.close()
process.exit(failures ? 1 : 0)
