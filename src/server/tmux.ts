/**
 * One-shot tmux commands: discovery, sizing and lifecycle.
 *
 * Pane output and keystrokes do NOT go through here — they ride the persistent
 * control-mode client (see control.ts), which avoids spawning a process per
 * keypress and gives us change notifications for free.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename } from 'node:path'
import { SCROLLBACK_LINES, type TileSpec } from '../shared/protocol.ts'

const exec = promisify(execFile)

/** Legacy prefix from the grouped-session design; only pruned now. */
export const VIEW_PREFIX = 'tcv_'
/** Sessions the canvas created for new terminals. These hold processes. */
export const SHELL_PREFIX = 'tcvsh_'
/** Unit separator: safe field delimiter for tmux -F output. */
const SEP = '\u001f'

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await exec('tmux', args, { maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

async function tmuxQuiet(args: string[]): Promise<boolean> {
  try {
    await tmux(args)
    return true
  } catch {
    return false
  }
}

export async function serverRunning(): Promise<boolean> {
  return tmuxQuiet(['has-session'])
}

/** Names of the real sessions currently on the tmux server. */
export async function liveSessions(): Promise<Set<string>> {
  try {
    const out = await tmux(['list-sessions', '-F', '#{session_name}'])
    return new Set(
      out
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith(VIEW_PREFIX)),
    )
  } catch {
    return new Set()
  }
}

/* ------------------------------- discovery ------------------------------- */

/** One tile per pane: control mode delivers output per pane, so panes are the unit. */
export async function discoverTiles(): Promise<{ tiles: TileSpec[]; warnings: string[] }> {
  const FIELDS = [
    '#{session_name}',
    '#{window_id}',
    '#{window_name}',
    '#{window_panes}',
    '#{pane_id}',
    '#{pane_index}',
    '#{pane_width}',
    '#{pane_height}',
    '#{pane_current_command}',
    '#{pane_current_path}',
  ]
  const fmt = FIELDS.join(SEP)

  let out: string
  try {
    out = await tmux(['list-panes', '-a', '-F', fmt])
  } catch {
    return { tiles: [], warnings: [] }
  }

  const tiles: TileSpec[] = []
  const seenPanes = new Set<string>()
  let malformed = 0

  for (const line of out.split('\n').filter(Boolean)) {
    const f = line.split(SEP)
    // Sin un locale UTF-8 en el entorno, tmux sustituye el separador por `_` y
    // la línea entera llega como un solo campo. Antes eso producía un tile
    // fantasma (`…/undefined/undefined`) y un cliente de control que moría
    // solo; mejor descartar la línea y decirlo.
    if (f.length !== FIELDS.length) {
      malformed += 1
      continue
    }
    const [session, windowId, windowName, windowPanes, paneId, paneIndex, cols, rows, command, path] = f

    // Legacy view sessions, and the same pane listed once per session that shows it.
    if (session.startsWith(VIEW_PREFIX)) continue
    if (seenPanes.has(paneId)) continue
    seenPanes.add(paneId)

    const siblings = Number(windowPanes)
    tiles.push({
      id: `tmux:${session}/${windowName}/${paneIndex}`,
      title: siblings > 1 ? `${windowName}.${paneIndex}` : windowName,
      subtitle: `${session} · ${basename(path || '')}`,
      paneId,
      windowId,
      session,
      cwd: path ?? '',
      command,
      paneIndex: Number(paneIndex),
      siblings,
      cols: Number(cols),
      rows: Number(rows),
    })
  }

  tiles.sort((a, b) => a.id.localeCompare(b.id))
  const warnings = await sizeWarnings(tiles)
  if (malformed) {
    warnings.unshift(
      `tmux devolvió ${malformed} línea(s) sin los separadores esperados, así que esos panes no se muestran. ` +
        'Suele ser un entorno sin locale UTF-8: revisa que LANG esté definido donde corre el servidor.',
    )
  }
  return { tiles, warnings }
}

/**
 * With `window-size manual` the canvas owns each window's size, so another
 * attached client shows the window through its own viewport instead of
 * resizing it. Worth saying out loud rather than looking like a glitch.
 */
async function sizeWarnings(tiles: TileSpec[]): Promise<string[]> {
  try {
    // The canvas' own control clients are attached too; they are not terminals
    // and never resize anything, so they must not trigger the warning.
    const out = await tmux(['list-clients', '-F', `#{client_session}${SEP}#{client_control_mode}`])
    const managed = new Set(tiles.map((t) => t.session))
    const external = out
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(SEP))
      .filter(([, control]) => control !== '1')
      .map(([session]) => session?.trim())
      .filter((s): s is string => !!s && managed.has(s))
    if (!external.length) return []
    return [
      `La sesión "${external[0]}" tiene otra terminal attachada. El canvas fija el tamaño de las windows que muestra, así que ese cliente las verá recortadas en su propio viewport.`,
    ]
  } catch {
    return []
  }
}

export async function paneGeometry(paneId: string): Promise<{ cols: number; rows: number } | null> {
  try {
    const out = await tmux(['display-message', '-p', '-t', paneId, `#{pane_width}${SEP}#{pane_height}`])
    const [cols, rows] = out.trim().split(SEP).map(Number)
    if (!cols || !rows) return null
    return { cols, rows }
  } catch {
    return null
  }
}

/** Current screen contents of a pane, escape sequences included. */
/**
 * Repaint a tile from scratch: the visible screen plus as much scrollback as
 * the client can hold. Without `-S` this only grabs the current screen,
 * which is all a browser reload ever saw — the rest of the pane's history
 * stayed in tmux until the user reattached from a native terminal.
 */
export async function capturePane(paneId: string): Promise<string> {
  try {
    const [{ stdout }, cursor] = await Promise.all([
      exec('tmux', ['capture-pane', '-p', '-e', '-S', `-${SCROLLBACK_LINES}`, '-t', paneId], {
        maxBuffer: 32 * 1024 * 1024,
      }),
      tmux(['display-message', '-p', '-t', paneId, '#{cursor_x} #{cursor_y}']),
    ])
    // The capture ends every row with a newline, the last one included, and
    // includes the screen's blank rows. Writing it as is leaves the client's
    // cursor below the bottom row: the first line scrolls off, and what the
    // pane prints next lands at the bottom instead of where tmux's cursor is.
    const [x, y] = cursor.trim().split(' ').map(Number)
    const home = Number.isInteger(x) && Number.isInteger(y) ? `\x1b[${y + 1};${x + 1}H` : ''
    return stdout.replace(/\n$/, '').replace(/\n/g, '\r\n') + home
  } catch {
    return ''
  }
}

/* ------------------------------ snapshotting ----------------------------- */

export interface PaneSnapshot {
  index: number
  cwd: string
  /** What the pane is running, as best we can tell; null for an idle shell. */
  command: string | null
}

export interface WindowSnapshot {
  name: string
  /** tmux's own layout string, which tmuxinator accepts as-is. */
  layout: string
  panes: PaneSnapshot[]
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'elvish', 'xonsh'])

/**
 * A session's windows and panes, in order, with enough to recreate them.
 *
 * tmux only knows the name of the program in the foreground, not how it was
 * launched, so the command line comes from the process table: the pane's
 * first child when its own process is a shell. That recovers `python manage.py
 * runserver` but not whatever ran before it on the same line (`av && …`).
 */
export async function describeSession(session: string): Promise<WindowSnapshot[]> {
  const FIELDS = [
    '#{window_index}',
    '#{window_name}',
    '#{window_layout}',
    '#{pane_index}',
    '#{pane_current_path}',
    '#{pane_pid}',
    '#{pane_current_command}',
    '#{pane_start_command}',
  ]
  const out = await tmux(['list-panes', '-s', '-t', `=${session}`, '-F', FIELDS.join(SEP)])
  const procs = await processTable()

  const windows = new Map<number, WindowSnapshot>()
  for (const line of out.split('\n').filter(Boolean)) {
    const f = line.split(SEP)
    if (f.length !== FIELDS.length) continue
    const [windowIndex, name, layout, paneIndex, cwd, pid, current, start] = f
    const key = Number(windowIndex)
    let win = windows.get(key)
    if (!win) windows.set(key, (win = { name, layout, panes: [] }))
    win.panes.push({ index: Number(paneIndex), cwd, command: paneCommand(Number(pid), current, start, procs) })
  }

  return [...windows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, w]) => ({ ...w, panes: w.panes.sort((a, b) => a.index - b.index) }))
}

interface Proc {
  ppid: number
  args: string
}

async function processTable(): Promise<Map<number, Proc>> {
  const table = new Map<number, Proc>()
  try {
    const { stdout } = await exec('ps', ['-A', '-o', 'pid=,ppid=,args='], { maxBuffer: 16 * 1024 * 1024 })
    for (const line of stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      if (m) table.set(Number(m[1]), { ppid: Number(m[2]), args: m[3].trim() })
    }
  } catch {
    // Without ps every pane just comes out as a shell.
  }
  return table
}

function isShell(name: string): boolean {
  return SHELLS.has(basename(name.replace(/^-/, '')))
}

function paneCommand(pid: number, current: string, start: string, procs: Map<number, Proc>): string | null {
  // Set only when the pane was created with a command of its own; tmux quotes it.
  const started = start.replace(/^"(.*)"$/, '$1').trim()
  if (started && !isShell(started.split(/\s+/)[0])) return started
  if (isShell(current)) return null

  const own = procs.get(pid)
  if (own && !isShell(own.args.split(/\s+/)[0])) return own.args
  for (const [, proc] of procs) if (proc.ppid === pid) return proc.args
  return current || null
}

/**
 * tmux's layout strings carry the window size they were taken at
 * (`3ab2,120x40,0,0[…]`), but tmuxinator applies them to a detached session's
 * default 80×24 window, so tmux shrinks every pane to fit. Growing the window
 * back to that size and applying the layout again gives each pane exactly the
 * size it was saved with — which is what its tile's box was measured from.
 */
export async function restoreWindowLayouts(session: string, layouts: { window: string; layout: string }[]): Promise<void> {
  if (!layouts.length) return
  let out: string
  try {
    out = await tmux(['list-windows', '-t', `=${session}`, '-F', `#{window_id}${SEP}#{window_name}`])
  } catch {
    return
  }
  const ids = new Map(out.split('\n').filter(Boolean).map((l) => l.split(SEP).reverse() as [string, string]))

  for (const { window, layout } of layouts) {
    const id = ids.get(window)
    const size = /^[0-9a-f]{4},(\d+)x(\d+),/.exec(layout)
    if (!id || !size) continue
    await takeWindowSize(id)
    await tmuxQuiet(['resize-window', '-t', id, '-x', size[1], '-y', size[2]])
    await tmuxQuiet(['select-layout', '-t', id, layout])
  }
}

/* --------------------------------- sizing -------------------------------- */

const manualWindows = new Set<string>()

/**
 * Hand the canvas control of a window's size. Without this tmux keeps
 * resizing the window to fit its clients, and tiles fight over it — the exact
 * problem the grouped-session design was working around.
 */
export async function takeWindowSize(windowId: string): Promise<void> {
  if (manualWindows.has(windowId)) return
  if (await tmuxQuiet(['set-option', '-w', '-t', windowId, 'window-size', 'manual'])) {
    manualWindows.add(windowId)
  }
}

/** Give a window's sizing back to tmux. */
export async function releaseWindowSize(windowId: string): Promise<void> {
  if (!manualWindows.delete(windowId)) return
  await tmuxQuiet(['set-option', '-uw', '-t', windowId, 'window-size'])
}

export async function releaseAllWindowSizes(): Promise<void> {
  await Promise.all([...manualWindows].map((id) => releaseWindowSize(id)))
}

/**
 * Size a pane to `cols`×`rows` as closely as tmux allows, and report what it
 * actually got.
 *
 * A lone pane in its window is sized exactly, by resizing the window itself.
 * Panes that share a window tile inside one rectangle, so they cannot all have
 * an arbitrary size — and `explicit` is what keeps that from turning ugly:
 *
 * - `false` (a tile opening): only ever *grow* the window. Three tiles opening
 *   on the same window would otherwise each claim the full height in turn and
 *   squeeze their siblings down to a single row.
 * - `true` (the user dragging a tile's corner): apply the request with
 *   resize-pane, which moves the divider and shrinks a neighbour — the same
 *   thing that dragging a split in tmux does, and now deliberate.
 */
export async function sizePane(
  spec: TileSpec,
  cols: number,
  rows: number,
  explicit: boolean,
): Promise<{ cols: number; rows: number }> {
  const c = Math.max(20, Math.min(1000, Math.round(cols)))
  const r = Math.max(5, Math.min(1000, Math.round(rows)))

  await takeWindowSize(spec.windowId)

  if (spec.siblings <= 1) {
    await tmuxQuiet(['resize-window', '-t', spec.windowId, '-x', String(c), '-y', String(r)])
  } else {
    // A pane can never exceed its window, so make room first — but only grow.
    const win = await windowGeometry(spec.windowId)
    if (win && (c > win.cols || r > win.rows)) {
      await tmuxQuiet([
        'resize-window',
        '-t',
        spec.windowId,
        '-x',
        String(Math.max(c, win.cols)),
        '-y',
        String(Math.max(r, win.rows)),
      ])
    }
    if (explicit) {
      await tmuxQuiet(['resize-pane', '-t', spec.paneId, '-x', String(c), '-y', String(r)])
      await rescueStarvedSiblings(spec)
    }
  }

  return (await paneGeometry(spec.paneId)) ?? { cols: c, rows: r }
}

/** Nothing readable fits in one row. */
const FLOOR_ROWS = 3
const FLOOR_COLS = 10

/**
 * A tile dragged large enough squeezes its siblings to a single row, and a pane
 * reflowed that small mangles whatever a full-screen program was drawing.
 *
 * The fix is to resize the *starved sibling* back up to the floor, not to grow
 * the window and re-apply the original request: tmux satisfies a resize-pane by
 * taking space from the neighbour, so re-applying it just steals the rescued
 * rows straight back. Rescuing the sibling instead trims the pane that
 * overreached — which is the one whose owner asked for too much.
 */
async function rescueStarvedSiblings(spec: TileSpec): Promise<void> {
  let panes: string
  try {
    panes = await tmux(['list-panes', '-t', spec.windowId, '-F', `#{pane_id}${SEP}#{pane_width}${SEP}#{pane_height}`])
  } catch {
    return
  }

  for (const line of panes.split('\n').filter(Boolean)) {
    const [paneId, w, h] = line.split(SEP)
    if (paneId === spec.paneId) continue
    if (Number(h) < FLOOR_ROWS) await tmuxQuiet(['resize-pane', '-t', paneId, '-y', String(FLOOR_ROWS)])
    if (Number(w) < FLOOR_COLS) await tmuxQuiet(['resize-pane', '-t', paneId, '-x', String(FLOOR_COLS)])
  }
}

async function windowGeometry(windowId: string): Promise<{ cols: number; rows: number } | null> {
  try {
    const out = await tmux(['display-message', '-p', '-t', windowId, `#{window_width}${SEP}#{window_height}`])
    const [cols, rows] = out.trim().split(SEP).map(Number)
    if (!cols || !rows) return null
    return { cols, rows }
  } catch {
    return null
  }
}

/* ------------------------------- lifecycle ------------------------------- */

/** Break a pane into its own window so its size stops being coupled. */
export async function decouplePane(spec: TileSpec): Promise<boolean> {
  if (spec.siblings <= 1) return false
  const name = `${spec.title.split('.')[0]}-${spec.paneIndex}`
  return tmuxQuiet(['break-pane', '-d', '-s', spec.paneId, '-n', name])
}

/** Kill a pane and its processes. */
export async function killPane(spec: TileSpec): Promise<void> {
  await tmuxQuiet(['kill-pane', '-t', spec.paneId])
}

/**
 * The name the next spawned shell will get. Split out from `spawnShell` so a
 * caller can announce the session before it exists: creating it makes tmux
 * report a layout change, and that notification can reach the browser before
 * `spawnShell` has returned.
 */
export function nextShellName(): string {
  return `${SHELL_PREFIX}${Date.now().toString(36)}`
}

/**
 * A brand new single-pane session the canvas owns. It is an ordinary tmux
 * session, so the next discovery pass turns it into a tile like any other —
 * and it survives a canvas restart.
 */
export async function spawnShell(
  name: string,
  cwd: string,
  command: string | undefined,
  cols: number,
  rows: number,
  displayName?: string,
): Promise<string> {
  const dir = cwd || process.env.HOME || '.'
  const label = displayName?.trim().slice(0, 20)
  await tmux([
    'new-session',
    '-d',
    '-s',
    name,
    '-n',
    label || (command ? command.split(/\s+/)[0].slice(0, 20) : 'canvas'),
    '-c',
    dir,
    '-x',
    String(Math.max(20, Math.round(cols))),
    '-y',
    String(Math.max(5, Math.round(rows))),
  ])
  await tmuxQuiet(['set-option', '-t', `=${name}`, 'status', 'off'])
  if (command) await tmuxQuiet(['send-keys', '-t', `=${name}`, command, 'Enter'])
  return name
}

/**
 * Clean up sessions left behind by the previous grouped-session design, where
 * every tile owned a session that kept its windows alive. Nothing creates
 * these any more; this only matters when upgrading with old ones still around.
 */
export async function pruneLegacyViews(): Promise<number> {
  let out: string
  try {
    out = await tmux(['list-sessions', '-F', `#{session_name}${SEP}#{session_attached}`])
  } catch {
    return 0
  }

  let killed = 0
  for (const line of out.split('\n').filter(Boolean)) {
    const [name, attached] = line.split(SEP)
    if (!name.startsWith(VIEW_PREFIX)) continue
    if (Number(attached) > 0) continue
    if (await tmuxQuiet(['kill-session', '-t', `=${name}`])) killed++
  }
  return killed
}
