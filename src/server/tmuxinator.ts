/**
 * tmuxinator projects as the canvas' save format.
 *
 * A project's .yml says what to run; the canvas adds where it goes, under a
 * `canvas:` key tmuxinator ignores (see CanvasBlock). Saving a session that
 * already has a project only rewrites that key, so the hand-written commands
 * and comments are left alone. A session without one gets a project generated
 * from what tmux shows, with commands read off the process table — close, but
 * worth a look before the next start.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import YAML, { isMap, isScalar, type Document } from 'yaml'

import type { CanvasBlock, GroupDef, Layout, ProjectFile } from '../shared/protocol.ts'
import { describeSession, type WindowSnapshot } from './tmux.ts'

const exec = promisify(execFile)

const DIRS = [join(homedir(), '.config', 'tmuxinator'), join(homedir(), '.tmuxinator')]
const NAME = /^[\w.-]+$/
/**
 * An empty pane reads as a bare `-`, the way people write it by hand, and no
 * line is folded: a long command split in two is still valid YAML, but it is
 * not the file the user wrote.
 */
const STRINGIFY = { nullStr: '', lineWidth: 0 }
/** A layout string tmux produced, which (unlike `tiled`) records sizes. */
const EXACT_LAYOUT = /^[0-9a-f]{4},\d+x\d+,/

/** Where tmuxinator looks first; new projects go wherever the existing ones are. */
function projectDir(): string {
  return DIRS.find((d) => existsSync(d)) ?? DIRS[0]
}

function projectPath(name: string): string | null {
  for (const ext of ['.yml', '.yaml']) {
    const path = join(projectDir(), name + ext)
    if (existsSync(path)) return path
  }
  return null
}

function checkName(name: string): string {
  if (!NAME.test(name)) throw new Error(`invalid project name: ${name}`)
  return name
}

export function listProjects(): string[] {
  const dir = projectDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => f.replace(/\.ya?ml$/, ''))
    .sort()
}

export async function startProject(name: string): Promise<void> {
  await exec('tmuxinator', ['start', checkName(name), '--no-attach'], {
    env: { ...process.env, TERM: process.env.TERM ?? 'xterm-256color' },
  })
}

/* ---------------------------------- read ---------------------------------- */

/**
 * The session a project starts and the arrangement it carries, if any.
 * tmuxinator names the session after `name:`, which need not match the file.
 */
export interface ProjectInfo {
  session: string
  canvas: CanvasBlock | null
  /** Windows with an exact tmux layout string, the only kind that records a size. */
  layouts: { window: string; layout: string }[]
}

export function readProject(name: string): ProjectInfo | null {
  const path = projectPath(checkName(name))
  if (!path) return null
  return parseProject(readFileSync(path, 'utf8'), name)
}

function parseProject(text: string, fallback: string): ProjectInfo {
  const data = YAML.parse(text) as Record<string, unknown> | null
  if (!data || typeof data !== 'object' || !Array.isArray(data.windows)) {
    throw new Error(`"${fallback}" doesn't look like a tmuxinator project (it has no windows: list)`)
  }
  const session = typeof data.name === 'string' && data.name ? data.name : fallback
  const canvas = cleanCanvas(data.canvas)
  // The canvas' own copy wins: it is there because the window's is not exact.
  const byWindow = exactLayouts(data.windows)
  for (const [window, layout] of Object.entries(canvas?.layouts ?? {})) byWindow.set(window, layout)
  return { session, canvas, layouts: [...byWindow].map(([window, layout]) => ({ window, layout })) }
}

/** The windows whose own `layout:` records sizes. */
function exactLayouts(windows: unknown[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const entry of windows) {
    if (!isObject(entry)) continue
    for (const [window, body] of Object.entries(entry)) {
      if (isObject(body) && typeof body.layout === 'string' && EXACT_LAYOUT.test(body.layout)) out.set(window, body.layout)
    }
  }
  return out
}

/** A `canvas:` block as written by hand or by an older version: keep only what makes sense. */
function cleanCanvas(raw: unknown): CanvasBlock | null {
  if (!isObject(raw)) return null
  const tiles: CanvasBlock['tiles'] = {}
  if (isObject(raw.tiles)) {
    for (const [key, box] of Object.entries(raw.tiles)) {
      if (!isObject(box)) continue
      const [x, y, w, h] = [box.x, box.y, box.w, box.h].map(Number)
      if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) tiles[key] = { x, y, w, h }
    }
  }
  const out: CanvasBlock = { tiles }
  if (Array.isArray(raw.hidden)) out.hidden = raw.hidden.filter((k): k is string => typeof k === 'string')
  if (isObject(raw.groups)) {
    out.groups = {}
    for (const [gid, def] of Object.entries(raw.groups)) {
      if (!isObject(def)) continue
      const g: GroupDef = {}
      if (typeof def.name === 'string') g.name = def.name
      if (Number.isFinite(Number(def.hue)) && def.hue !== null) g.hue = Number(def.hue)
      out.groups[gid] = g
    }
  }
  if (isObject(raw.groupOf)) {
    out.groupOf = {}
    for (const [key, gid] of Object.entries(raw.groupOf)) {
      // `groupOf: { web/0: }` parses as null: no group, same as ''.
      if (typeof gid === 'string' || gid === null) out.groupOf[key] = gid ?? ''
    }
  }
  if (isObject(raw.layouts)) {
    out.layouts = {}
    for (const [window, layout] of Object.entries(raw.layouts)) {
      if (typeof layout === 'string' && EXACT_LAYOUT.test(layout)) out.layouts[window] = layout
    }
  }
  return out
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/* --------------------------------- export --------------------------------- */

export interface ExportResult {
  files: (ProjectFile & { path: string })[]
  /** Projects that exist and would be regenerated wholesale. */
  conflicts: string[]
  warnings: string[]
}

/**
 * Build the .yml for each project in `sessions` (session → project name).
 * Nothing touches the disk here; `writeProjects` does that.
 */
export async function buildProjects(
  sessions: Record<string, string>,
  layout: Layout,
  overwrite: string[] = [],
): Promise<ExportResult> {
  const byProject = new Map<string, string[]>()
  for (const [session, project] of Object.entries(sessions)) {
    checkName(project)
    byProject.set(project, [...(byProject.get(project) ?? []), session])
  }
  const projectOf = (session: string) => sessions[session]

  const result: ExportResult = { files: [], conflicts: [], warnings: [] }

  for (const [project, members] of byProject) {
    const snapshots = await Promise.all(members.map(async (s) => ({ session: s, windows: await describeSession(s) })))
    const existing = projectPath(project)

    // The one case where the file stays the user's: it is this very session's
    // project, so its windows are the ones on screen and only `canvas:` moves.
    if (existing && members.length === 1 && members[0] === project && !overwrite.includes(project)) {
      const text = readFileSync(existing, 'utf8')
      const doc = YAML.parseDocument(text)
      if (doc.errors.length) {
        result.warnings.push(`${project}: couldn't read its .yml (${doc.errors[0].message.split('\n')[0]}), so it was left untouched.`)
        continue
      }
      const windows = snapshots[0].windows
      const canvas = canvasFor(
        layout,
        [{ session: project, windows, rename: new Map(windows.map((w) => [w.name, w.name])) }],
        project,
        projectOf,
      )
      const js = doc.toJS() as { windows?: unknown } | null
      const declared = Array.isArray(js?.windows) ? js.windows : []
      const exact = exactLayouts(declared)
      const layouts: Record<string, string> = {}
      for (const w of windows) if (w.panes.length > 1 && !exact.has(w.name)) layouts[w.name] = w.layout
      if (Object.keys(layouts).length) canvas.layouts = layouts
      const missing = windows.map((w) => w.name).filter((w) => !declaredWindows(declared).has(w))
      if (missing.length) {
        result.warnings.push(
          `${project}: ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not in the .yml, so those tiles won't come back on their own when it starts.`,
        )
      }
      setCanvas(doc, canvas)
      result.files.push({ name: project, path: existing, text: doc.toString(STRINGIFY) })
      continue
    }

    if (existing && !overwrite.includes(project)) {
      result.conflicts.push(project)
      continue
    }

    const { windows, renames } = mergeWindows(snapshots)
    const canvas = canvasFor(
      layout,
      snapshots.map((s, i) => ({ ...s, rename: renames[i] })),
      project,
      projectOf,
    )
    const doc = generate(project, windows)
    setCanvas(doc, canvas)
    result.files.push({ name: project, path: existing ?? join(projectDir(), `${project}.yml`), text: doc.toString(STRINGIFY) })
  }

  return result
}

export function writeProjects(files: { path: string; text: string }[]): void {
  mkdirSync(projectDir(), { recursive: true })
  for (const f of files) writeFileSync(f.path, f.text)
}

/** Window names the project's `windows:` list declares. */
function declaredWindows(list: unknown[]): Set<string> {
  const names = new Set<string>()
  for (const w of list) {
    if (isObject(w)) for (const k of Object.keys(w)) names.add(k)
    else if (typeof w === 'string') names.add(w)
  }
  return names
}

/**
 * Several sessions saved as one project become one session's windows. Window
 * names must stay unique, since they are half of every tile's id.
 */
function mergeWindows(snapshots: { session: string; windows: WindowSnapshot[] }[]): {
  windows: WindowSnapshot[]
  renames: Map<string, string>[]
} {
  const taken = new Set<string>()
  const windows: WindowSnapshot[] = []
  const renames = snapshots.map((s) => {
    const rename = new Map<string, string>()
    for (const w of s.windows) {
      let name = w.name || 'window'
      for (let n = 2; taken.has(name); n++) name = `${w.name}-${n}`
      taken.add(name)
      rename.set(w.name, name)
      windows.push({ ...w, name })
    }
    return rename
  })
  return { windows, renames }
}

const HOME = homedir()

function tilde(path: string): string {
  return path === HOME ? '~' : path.startsWith(HOME + '/') ? '~' + path.slice(HOME.length) : path
}

function shellQuote(path: string): string {
  // `~` must stay outside the quotes to expand.
  const [head, rest] = path.startsWith('~/') ? ['~/', path.slice(2)] : ['', path]
  return /^[\w@%+=:,./~-]*$/.test(rest) ? head + rest : `${head}'${rest.replace(/'/g, `'\\''`)}'`
}

/** A fresh project from what tmux shows right now. */
function generate(project: string, windows: WindowSnapshot[]): Document {
  const root = windows[0]?.panes[0]?.cwd ?? HOME

  const list = windows.map((w) => {
    const winRoot = w.panes[0]?.cwd ?? root
    const panes = w.panes.map((p) => {
      const cmds: string[] = []
      if (p.cwd && p.cwd !== winRoot) cmds.push(`cd ${shellQuote(tilde(p.cwd))}`)
      if (p.command) cmds.push(p.command)
      return cmds.length === 0 ? null : cmds.length === 1 ? cmds[0] : cmds
    })
    const body: Record<string, unknown> = {}
    if (winRoot !== root) body.root = tilde(winRoot)
    if (w.panes.length > 1) body.layout = w.layout
    body.panes = panes
    return { [w.name]: body }
  })

  const doc = new YAML.Document({ name: project, root: tilde(root), windows: list })
  doc.commentBefore =
    ` Generated by terminal-canvas on ${new Date().toISOString().slice(0, 10)}.\n` +
    ' Commands come from the processes running in each pane: review them before starting it.'
  return doc
}

/** Put the block in `doc`, replacing any previous one, one tile per line. */
function setCanvas(doc: Document, canvas: CanvasBlock): void {
  const node = doc.createNode(canvas)
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? pair.key.value : null
      if (key === 'hidden' && pair.value && 'flow' in pair.value) pair.value.flow = true
      if ((key === 'tiles' || key === 'groups') && isMap(pair.value)) {
        for (const entry of pair.value.items) if (isMap(entry.value)) entry.value.flow = true
      }
    }
  }
  doc.delete('canvas')
  const key = doc.createNode('canvas')
  key.commentBefore = ' terminal-canvas: where each pane goes on the canvas (tmuxinator ignores this key).'
  key.spaceBefore = true
  if (isMap(doc.contents)) doc.contents.items.push(doc.createPair(key, node))
}

/**
 * The slice of `layout` that belongs to these sessions, rekeyed relative to
 * the project. A tile's group is written only when it is not the default, and
 * a session's own group follows the tile to the project it now belongs to.
 */
function canvasFor(
  layout: Layout,
  members: { session: string; windows: WindowSnapshot[]; rename: Map<string, string> }[],
  project: string,
  projectOf: (session: string) => string | undefined,
): CanvasBlock {
  const canvas: CanvasBlock = { tiles: {} }
  const hidden: string[] = []
  const groups: Record<string, GroupDef> = {}
  const groupOf: Record<string, string> = {}

  const mapGroup = (gid: string): string => {
    if (!gid.startsWith('s:')) return gid
    const target = projectOf(gid.slice(2))
    return target ? `s:${target}` : gid
  }

  for (const { session, windows, rename } of members) {
    const prefix = `tmux:${session}/`
    // Only panes that exist: the layout still remembers ones long gone.
    const live = new Set(windows.flatMap((w) => w.panes.map((p) => `${w.name}/${p.index}`)))
    const rekey = (id: string): string | null => {
      if (!id.startsWith(prefix)) return null
      const rest = id.slice(prefix.length)
      if (!live.has(rest)) return null
      const cut = rest.lastIndexOf('/')
      const win = rename.get(rest.slice(0, cut))
      return win === undefined ? null : `${win}/${rest.slice(cut + 1)}`
    }

    for (const [id, box] of Object.entries(layout.tiles)) {
      const key = rekey(id)
      if (!key) continue
      canvas.tiles[key] = { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) }
      const gid = layout.groupOf?.[id]
      if (gid === undefined) continue
      const mapped = mapGroup(gid)
      if (mapped === `s:${project}`) continue
      groupOf[key] = mapped
      const def = layout.groups?.[gid]
      if (def && mapped.startsWith('g:')) groups[mapped] = def
    }
    for (const id of layout.hidden) {
      const key = rekey(id)
      if (key) hidden.push(key)
    }
    const own = layout.groups?.[`s:${session}`]
    if (own && !groups[`s:${project}`]) groups[`s:${project}`] = own
  }

  if (hidden.length) canvas.hidden = hidden
  if (Object.keys(groups).length) canvas.groups = groups
  if (Object.keys(groupOf).length) canvas.groupOf = groupOf
  return canvas
}

/* --------------------------------- import --------------------------------- */

export interface ImportResult {
  /** Project names, as tmuxinator will know them. */
  installed: string[]
  conflicts: string[]
}

/**
 * Validate and install uploaded projects. A file that would replace a
 * different one of the same name is held back until the user agrees.
 */
export function importProjects(files: ProjectFile[], overwrite: string[] = []): ImportResult {
  const result: ImportResult = { installed: [], conflicts: [] }
  const ready: { path: string; text: string; name: string }[] = []

  for (const file of files) {
    const fallback = file.name.replace(/\.ya?ml$/i, '')
    const { session } = parseProject(file.text, fallback)
    // tmuxinator finds a project by its file name, and it has to start the
    // session this file describes.
    const name = checkName(NAME.test(session) ? session : fallback)
    const existing = projectPath(name)
    if (existing && readFileSync(existing, 'utf8') !== file.text && !overwrite.includes(name)) {
      result.conflicts.push(name)
      continue
    }
    ready.push({ path: existing ?? join(projectDir(), `${name}.yml`), text: file.text, name })
  }

  // All or nothing: a half-applied import is harder to reason about than a question.
  if (result.conflicts.length) return result
  writeProjects(ready)
  result.installed = ready.map((r) => r.name)
  return result
}
