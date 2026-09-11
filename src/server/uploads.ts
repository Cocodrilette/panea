/**
 * Images dropped or pasted into a tile.
 *
 * A browser cannot hand a pane the path of a local file — it only has the
 * bytes — so the canvas lands them on disk next to its own config and gives
 * the pane an absolute path instead. That is exactly what a native terminal
 * produces when you drag a file onto it, so anything reading the prompt
 * (Claude Code, an editor, `open`) sees what it expects.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const IMAGE_DIR = join(homedir(), '.config', 'terminal-canvas', 'images')

/** Enough for a retina screenshot; past this a drop is almost surely a mistake. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** Dropped images are scratch data: keep them long enough to still be useful. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Only formats a viewer or model can actually open. Doubles as the allow-list. */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'image/svg+xml': 'svg',
}

export function isSupportedImage(mime: string): boolean {
  return mime.split(';')[0].trim().toLowerCase() in EXT_BY_MIME
}

/**
 * Write an image and return its absolute path. The name is sanitised down to
 * a shell-safe slug: the path is about to be typed into somebody's prompt.
 */
export function saveImage(data: Buffer, mime: string, originalName?: string): string {
  const type = mime.split(';')[0].trim().toLowerCase()
  const ext = EXT_BY_MIME[type]
  if (!ext) throw new Error(`tipo de imagen no soportado: ${mime}`)

  mkdirSync(IMAGE_DIR, { recursive: true })
  pruneOldImages()

  const stem = slug(originalName?.replace(/\.[^.]+$/, '')) || 'imagen'
  const file = `${stamp()}-${stem}-${randomBytes(3).toString('hex')}.${ext}`
  const path = join(IMAGE_DIR, file)
  writeFileSync(path, data)
  return path
}

function slug(name: string | undefined): string {
  return (name ?? '')
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Best effort: a full disk is the user's problem, a crashed drop is ours. */
function pruneOldImages(): void {
  try {
    const cutoff = Date.now() - MAX_AGE_MS
    for (const file of readdirSync(IMAGE_DIR)) {
      const path = join(IMAGE_DIR, file)
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path)
      } catch {
        /* raced with another prune, or not ours to delete */
      }
    }
  } catch (err) {
    console.error('[uploads] prune failed:', err)
  }
}
