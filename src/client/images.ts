/**
 * Images dropped or pasted onto a tile.
 *
 * The browser only ever hands us bytes — never a usable local path — so the
 * bytes go to the server, which writes them next to its config and answers
 * with a path. Typing that path into the pane is what a native terminal does
 * when you drag a file onto it, and it is what Claude Code and friends read.
 */

/** A drag carrying files, as opposed to text or a tile being moved. */
export function hasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes('Files')
}

export function imagesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return []
  return Array.from(dt.files).filter((f) => f.type.startsWith('image/'))
}

/** Uploads one image and returns the absolute path it landed on. */
export async function uploadImage(file: File): Promise<string> {
  const res = await fetch('/upload', {
    method: 'POST',
    headers: {
      'content-type': file.type,
      // Header values must stay ASCII; the server decodes it back.
      'x-filename': encodeURIComponent(file.name || ''),
    },
    body: file,
  })

  const body = (await res.json().catch(() => null)) as { path?: string; error?: string } | null
  if (!res.ok || !body?.path) throw new Error(body?.error ?? `the server answered ${res.status}`)
  return body.path
}

/**
 * Quote a path for a shell prompt, and only when it needs it: an unquoted
 * path is what a prompt like Claude Code's reads most reliably.
 */
export function quotePath(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`
}
