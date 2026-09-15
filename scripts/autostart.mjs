/**
 * Instala (o quita) un LaunchAgent que mantiene el servidor vivo, para que la
 * PWA siempre encuentre algo en 127.0.0.1:7788 sin tener una terminal dedicada
 * a `npm run canvas`.
 *
 *   node scripts/autostart.mjs            instala y arranca
 *   node scripts/autostart.mjs --off      para y desinstala
 *   node scripts/autostart.mjs --status   qué dice launchd
 *
 * Congela la ruta del node actual: si cambias de versión con nvm hay que
 * volver a correrlo.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LABEL = 'com.github.cocodrilette.terminal-canvas'
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PLIST = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`)
const LOG = join(homedir(), 'Library/Logs', 'terminal-canvas.log')
const TARGET = `gui/${process.getuid()}/${LABEL}`

/** launchctl devuelve error por cosas normales (ya descargado, p.ej.). */
function launchctl(args, { fatal = true } = {}) {
  try {
    return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    if (fatal) throw err
    return err.stdout ?? ''
  }
}

/** ¿Sigue registrado el servicio? */
function loaded() {
  try {
    execFileSync('launchctl', ['print', TARGET], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * `bootout` vuelve antes de que launchd termine de descargar el servicio, y un
 * `bootstrap` inmediato se estrella con "Bootstrap failed: 5: Input/output
 * error". Esperamos a que desaparezca de verdad.
 */
function bootoutAndWait() {
  launchctl(['bootout', TARGET], { fatal: false })
  const deadline = Date.now() + 10_000
  while (loaded() && Date.now() < deadline) execFileSync('sleep', ['0.2'])
  if (loaded()) throw new Error(`launchd no soltó ${LABEL}; prueba \`launchctl bootout ${TARGET}\` a mano`)
}

if (process.argv.includes('--status')) {
  if (!existsSync(PLIST)) {
    console.log('[tcv] sin LaunchAgent instalado')
    process.exit(0)
  }
  console.log(launchctl(['print', TARGET], { fatal: false }) || `[tcv] ${LABEL} no está cargado`)
  process.exit(0)
}

if (process.argv.includes('--off')) {
  bootoutAndWait()
  rmSync(PLIST, { force: true })
  console.log(`[tcv] LaunchAgent desinstalado (${PLIST})`)
  process.exit(0)
}

if (!existsSync(join(ROOT, 'dist/main.js'))) {
  console.error('[tcv] falta dist/main.js — corre `npm run build` antes de instalar el agente')
  process.exit(1)
}

// launchd arranca con un entorno pelado. Sin PATH el servidor no encuentra
// tmux; y sin locale UTF-8 tmux reemplaza por '_' el separador de campos de
// sus formatos -F, con lo que la discovery entera se vuelve basura y el canvas
// queda vacío. Los shells que nazcan en el canvas heredan ambos.
const LANG = process.env.LANG ?? 'en_US.UTF-8'
const PATHS = [dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>--experimental-strip-types</string>
    <string>${join(ROOT, 'src/server/index.ts')}</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT.replace(/\/$/, '')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${PATHS.join(':')}</string>
    <key>LANG</key><string>${LANG}</string>
    <key>TCV_NO_OPEN</key><string>1</string>
    <key>TCV_WAIT_PORT</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`

mkdirSync(dirname(PLIST), { recursive: true })
writeFileSync(PLIST, plist)
bootoutAndWait()
launchctl(['bootstrap', `gui/${process.getuid()}`, PLIST])
console.log(`[tcv] LaunchAgent instalado: ${PLIST}`)
console.log(`[tcv] logs en ${LOG} — quitar con \`npm run autostart:off\``)
