/** Layout persistence and tmuxinator project discovery. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Layout } from '../shared/protocol.ts'

const exec = promisify(execFile)

const CONFIG_DIR = join(homedir(), '.config', 'terminal-canvas')
const LAYOUT_FILE = join(CONFIG_DIR, 'layout.json')

const EMPTY: Layout = { tiles: {}, viewport: { x: 0, y: 0, zoom: 1 }, hidden: [] }

export function loadLayout(): Layout {
  try {
    const raw = JSON.parse(readFileSync(LAYOUT_FILE, 'utf8')) as Partial<Layout>
    return {
      tiles: raw.tiles ?? {},
      viewport: raw.viewport ?? EMPTY.viewport,
      hidden: raw.hidden ?? [],
      views: Array.isArray(raw.views) ? raw.views : [],
      groups: isRecord(raw.groups) ? raw.groups : {},
      groupOf: isRecord(raw.groupOf) ? raw.groupOf : {},
    }
  } catch {
    return structuredClone(EMPTY)
  }
}

function isRecord<T>(v: T | undefined): v is T {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

let pending: Layout | null = null
let timer: NodeJS.Timeout | null = null

/** Debounced: the client streams layout on every drag frame. */
export function saveLayout(layout: Layout): void {
  pending = layout
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    const l = pending
    pending = null
    if (!l) return
    try {
      mkdirSync(CONFIG_DIR, { recursive: true })
      writeFileSync(LAYOUT_FILE, JSON.stringify(l, null, 2))
    } catch (err) {
      console.error('[layout] save failed:', err)
    }
  }, 400)
}

export function listProjects(): string[] {
  for (const dir of [join(homedir(), '.config', 'tmuxinator'), join(homedir(), '.tmuxinator')]) {
    if (!existsSync(dir)) continue
    return readdirSync(dir)
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
      .map((f) => f.replace(/\.ya?ml$/, ''))
      .sort()
  }
  return []
}

export async function startProject(name: string): Promise<void> {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`nombre de proyecto inválido: ${name}`)
  await exec('tmuxinator', ['start', name, '--no-attach'], {
    env: { ...process.env, TERM: process.env.TERM ?? 'xterm-256color' },
  })
}
