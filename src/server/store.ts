/** Layout persistence: the canvas' own state, in ~/.config/terminal-canvas. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Layout } from '../shared/protocol.ts'

const CONFIG_DIR = join(homedir(), '.config', 'terminal-canvas')
const LAYOUT_FILE = join(CONFIG_DIR, 'layout.json')

const EMPTY: Layout = { tiles: {}, viewport: { x: 0, y: 0, zoom: 1 }, hidden: [] }

/**
 * The newest layout any browser sent, ahead of the debounced write. A reload
 * reconnects well inside that window, and reading the file then handed the
 * page the layout from before its last edits — which it promptly saved back,
 * undoing a rename or a move made just before reloading.
 */
let current: Layout | null = null

export function loadLayout(): Layout {
  if (current) return structuredClone(current)
  try {
    return normalizeLayout(JSON.parse(readFileSync(LAYOUT_FILE, 'utf8')) as Partial<Layout>)
  } catch {
    return structuredClone(EMPTY)
  }
}

/** Fill in whatever an older (or hand-written) layout left out. */
function normalizeLayout(raw: Partial<Layout>): Layout {
  return {
    tiles: isRecord(raw.tiles) ? raw.tiles : {},
    viewport: raw.viewport ?? { ...EMPTY.viewport },
    hidden: Array.isArray(raw.hidden) ? raw.hidden : [],
    views: Array.isArray(raw.views) ? raw.views : [],
    groups: isRecord(raw.groups) ? raw.groups : {},
    groupOf: isRecord(raw.groupOf) ? raw.groupOf : {},
  }
}

function isRecord<T>(v: T | undefined): v is T {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

let timer: NodeJS.Timeout | null = null

/** Debounced: the client streams layout on every drag frame. */
export function saveLayout(layout: Layout): void {
  current = layout
  if (timer) return
  timer = setTimeout(flushLayout, 400)
}

/** Write the pending layout now, e.g. on the way out. */
export function flushLayout(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (!current) return
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(LAYOUT_FILE, JSON.stringify(current, null, 2))
  } catch (err) {
    console.error('[layout] save failed:', err)
  }
}
