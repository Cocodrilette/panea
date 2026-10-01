/**
 * Who may drive the terminals.
 *
 * The WebSocket types into real shells, so reaching it is reaching the
 * machine. Three checks stand between it and everything else:
 *
 * - Host: the request must name this server (127.0.0.1, localhost, …). A page
 *   that rebinds its own DNS name to 127.0.0.1 still sends its own name here.
 * - Origin: browsers let any page open a WebSocket to any address — CORS does
 *   not apply — so the handshake must come from the canvas itself.
 * - Token: a secret kept in ~/.config/terminal-canvas/token (0600). The link
 *   the server opens carries it once; from then on it rides in an HttpOnly,
 *   SameSite=Strict cookie. It keeps out other users of the machine and, with
 *   TCV_HOST, the rest of the network.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const TOKEN_FILE = join(homedir(), '.config', 'terminal-canvas', 'token')
/** Refreshed on every visit, so only a canvas left unopened for a year expires. */
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60

/** Read the install's token, minting one on first run. */
function loadToken(): string {
  try {
    const token = readFileSync(TOKEN_FILE, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(token)) {
      chmodSync(TOKEN_FILE, 0o600)
      return token
    }
  } catch {
    /* first run */
  }
  const token = randomBytes(32).toString('hex')
  mkdirSync(dirname(TOKEN_FILE), { recursive: true })
  writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 })
  return token
}

function sameSecret(given: string | undefined | null, token: string): boolean {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function cookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
  }
  return out
}

export interface Guard {
  /** The address to open: it signs the browser in. */
  loginUrl: string
  /** Is this request addressed to us (Host) and, if it says, sent by us (Origin)? */
  sameSite(req: IncomingMessage): boolean
  /** Does it carry the session cookie? */
  signedIn(req: IncomingMessage): boolean
  /** A `?token=` link: set the cookie and redirect to the clean URL. Returns true if handled. */
  acceptLogin(req: IncomingMessage, res: ServerResponse): boolean
  /** Keep the cookie of a signed-in browser from expiring. */
  refresh(res: ServerResponse): void
}

export function createGuard(host: string, port: number): Guard {
  const token = loadToken()
  // Cookies ignore ports: two canvases on one machine must not share a name.
  const cookieName = `tcv_${port}`
  const setCookie = `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`

  const names = new Set(['127.0.0.1', 'localhost', '[::1]'])
  if (host !== '0.0.0.0' && host !== '::') names.add(host.includes(':') ? `[${host}]` : host)
  const hosts = new Set([...names].map((n) => `${n}:${port}`))
  if (port === 80) for (const n of names) hosts.add(n)
  const origins = new Set([...hosts].map((h) => `http://${h}`))

  // A wildcard bind is reachable on loopback too, and that is where this machine's browser is.
  const loginHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host
  const loginUrl = `http://${loginHost}:${port}/?token=${token}`

  return {
    loginUrl,

    sameSite(req) {
      if (!hosts.has(String(req.headers.host ?? '').toLowerCase())) return false
      const origin = req.headers.origin
      return origin === undefined || origins.has(origin.toLowerCase())
    },

    signedIn(req) {
      return sameSecret(cookies(req).get(cookieName), token)
    },

    acceptLogin(req, res) {
      const url = new URL(req.url ?? '/', 'http://x')
      if (!url.searchParams.has('token')) return false
      if (!sameSecret(url.searchParams.get('token'), token)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('token inválido')
        return true
      }
      url.searchParams.delete('token')
      res.writeHead(302, { 'set-cookie': setCookie, location: url.pathname + url.search, 'cache-control': 'no-store' })
      res.end()
      return true
    },

    refresh(res) {
      res.setHeader('set-cookie', setCookie)
    },
  }
}

/** True for addresses only this machine can reach. */
export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host)
}

export const LOCKED_PAGE = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>terminal-canvas</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#0c0d11;color:#d7dae0;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:30rem;padding:1.5rem}code{background:#1c1e25;padding:.1em .35em;border-radius:4px}</style></head>
<body><main><h1>terminal-canvas</h1>
<p>Este navegador todavía no tiene acceso. Abre el enlace con <code>?token=…</code> que imprime el servidor,
o vuelve a correr <code>npm run canvas</code>: abre la instancia que ya corre con el enlace correcto.</p>
<p>El token vive en <code>${TOKEN_FILE.replace(homedir(), '~')}</code>.</p></main></body></html>`
