/**
 * A tmux control-mode client (`tmux -C attach`).
 *
 * One client per base session replaces the old one-grouped-session-per-tile
 * design. It is a *client*, not a session, so it never appears in the user's
 * session list and never keeps a window alive: if the session is destroyed the
 * client simply exits, exactly like any other tmux client.
 *
 * The protocol is line oriented. Command output is delimited by %begin/%end
 * (or %error) guards, replies arrive in the order the commands were sent, and
 * everything else is an asynchronous notification.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

const LF = 0x0a
const BACKSLASH = 0x5c

export interface Reply {
  lines: Buffer[]
  error: boolean
}

export interface ControlHandlers {
  /** Raw pane output, already unescaped to bytes. */
  onOutput(paneId: string, data: Buffer): void
  /** Windows or panes appeared, vanished, were renamed or relaid out. */
  onLayoutChange(): void
  /** The client is gone: session destroyed, server exited, or we closed it. */
  onExit(reason: string): void
}

export class ControlClient {
  readonly session: string
  private readonly handlers: ControlHandlers
  private readonly proc: ChildProcessWithoutNullStreams
  private readonly pending: ((reply: Reply) => void)[] = []
  private buffer: Buffer = Buffer.alloc(0)
  private block: Buffer[] | null = null
  private blockFailed = false
  private layoutTimer: NodeJS.Timeout | null = null
  private closed = false

  // Node's type-stripping runtime rejects constructor parameter properties,
  // and the server runs straight from TypeScript sources.
  constructor(session: string, handlers: ControlHandlers) {
    this.session = session
    this.handlers = handlers
    this.proc = spawn('tmux', ['-C', 'attach-session', '-t', `=${session}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'xterm-256color' },
    }) as ChildProcessWithoutNullStreams

    this.proc.stdout.on('data', (chunk: Buffer) => this.consume(chunk))
    this.proc.on('exit', (code, signal) => {
      this.closed = true
      // Unblock anything still waiting for a reply that will never come.
      for (const resolve of this.pending.splice(0)) resolve({ lines: [], error: true })
      handlers.onExit(signal ? `signal ${signal}` : `code ${code ?? 0}`)
    })
  }

  get alive(): boolean {
    return !this.closed
  }

  /** Send a tmux command and wait for its reply block. */
  command(text: string): Promise<Reply> {
    if (this.closed) return Promise.resolve({ lines: [], error: true })
    return new Promise((resolve) => {
      this.pending.push(resolve)
      this.proc.stdin.write(text + '\n')
    })
  }

  /** Fire and forget, for high-frequency commands like keystrokes. */
  write(text: string): void {
    if (this.closed) return
    this.pending.push(() => {})
    this.proc.stdin.write(text + '\n')
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.proc.kill()
  }

  private consume(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk

    let start = 0
    for (;;) {
      const nl = this.buffer.indexOf(LF, start)
      if (nl === -1) break
      let end = nl
      if (end > start && this.buffer[end - 1] === 0x0d) end--
      this.handleLine(this.buffer.subarray(start, end))
      start = nl + 1
    }
    this.buffer = start ? this.buffer.subarray(start) : this.buffer
  }

  private handleLine(line: Buffer): void {
    if (line.length === 0) {
      if (this.block) this.block.push(Buffer.alloc(0))
      return
    }

    if (line[0] !== 0x25 /* % */) {
      // Plain text: part of the reply to the command currently in flight.
      if (this.block) this.block.push(Buffer.from(line))
      return
    }

    const space = line.indexOf(0x20)
    const kind = (space === -1 ? line : line.subarray(0, space)).toString('latin1')

    switch (kind) {
      case '%begin':
        this.block = []
        this.blockFailed = false
        return

      case '%error':
        this.blockFailed = true
      // falls through: %error closes the block like %end
      case '%end': {
        const lines = this.block ?? []
        const error = this.blockFailed
        this.block = null
        this.blockFailed = false
        this.pending.shift()?.({ lines, error })
        return
      }

      case '%output': {
        // %output %<pane> <escaped bytes>
        const rest = line.subarray(space + 1)
        const sep = rest.indexOf(0x20)
        if (sep === -1) return
        const paneId = rest.subarray(0, sep).toString('latin1')
        this.handlers.onOutput(paneId, unescapeOutput(rest.subarray(sep + 1)))
        return
      }

      case '%window-add':
      case '%window-close':
      case '%window-renamed':
      case '%window-pane-changed':
      case '%layout-change':
      case '%unlinked-window-add':
      case '%unlinked-window-close':
      case '%unlinked-window-renamed':
      case '%sessions-changed':
        this.scheduleLayoutChange()
        return

      case '%exit':
        this.handlers.onExit(line.subarray(space + 1).toString('utf8') || 'exit')
        return

      default:
        // %session-changed, %client-detached, %pane-mode-changed, %continue,
        // %pause, %subscription-changed, … nothing to do.
        return
    }
  }

  /** tmux emits a burst of notifications per change; coalesce them. */
  private scheduleLayoutChange(): void {
    if (this.layoutTimer) return
    this.layoutTimer = setTimeout(() => {
      this.layoutTimer = null
      if (!this.closed) this.handlers.onLayoutChange()
    }, 120)
  }
}

/**
 * tmux escapes control and non-printable bytes as `\ooo` octal and a literal
 * backslash as `\\`; everything else — UTF-8 included — passes through raw. So
 * this has to work on bytes: decoding to a string first would corrupt
 * multi-byte characters split across two %output lines.
 */
export function unescapeOutput(data: Buffer): Buffer {
  if (data.indexOf(BACKSLASH) === -1) return data

  const out = Buffer.allocUnsafe(data.length)
  let n = 0
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== BACKSLASH) {
      out[n++] = data[i]
      continue
    }
    const a = data[i + 1]
    if (a === BACKSLASH) {
      out[n++] = BACKSLASH
      i++
      continue
    }
    if (isOctal(a) && isOctal(data[i + 2]) && isOctal(data[i + 3])) {
      out[n++] = (a - 0x30) * 64 + (data[i + 2] - 0x30) * 8 + (data[i + 3] - 0x30)
      i += 3
      continue
    }
    out[n++] = BACKSLASH
  }
  return out.subarray(0, n)
}

function isOctal(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x30 && byte <= 0x37
}

/** Encode input bytes for `send-keys -H`, which takes space-separated hex. */
export function toHexKeys(data: string): string {
  return [...Buffer.from(data, 'utf8')].map((b) => b.toString(16).padStart(2, '0')).join(' ')
}
