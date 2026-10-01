/**
 * Regenerate assets/image.png, the README screenshot, from a staged demo.
 *
 *   npm run build && npm run screenshot
 *
 * Nothing real is on screen: the canvas runs against its own tmux server
 * (TMUX_TMPDIR) with a throwaway HOME, so neither your sessions nor your
 * layout or token are touched, and every pane runs feed.mjs.
 */
import { spawn, execFileSync } from 'node:child_process'
import { constants, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const FEED = fileURLToPath(new URL('./feed.mjs', import.meta.url))
const OUT = process.argv[2] ?? join(ROOT, 'assets/image.png')
const PORT = 7796
// A socket path must fit in ~104 bytes, which rules out macOS's $TMPDIR.
const WORK = `/tmp/tcv-shot-${process.pid}`
const HOME = join(WORK, 'home')
const BIN = join(WORK, 'bin')

const env = { ...process.env, HOME, TMUX_TMPDIR: WORK, LANG: 'en_US.UTF-8', TERM: 'xterm-256color' }
delete env.TMUX
const tmux = (...args) => execFileSync('tmux', args, { env })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// tmux shows a pane's command by its executable's name, and resolves
// symlinks, so each kind gets its own copy of node (a free clone on APFS).
const commands = { vite: 'vite', vitest: 'vitest', api: 'uvicorn', worker: 'worker', deploy: 'deploy', gitlog: 'git' }
mkdirSync(BIN, { recursive: true })
for (const name of Object.values(commands)) copyFileSync(process.execPath, join(BIN, name), constants.COPYFILE_FICLONE)
const run = (kind) => `${join(BIN, commands[kind])} ${FEED} ${kind}`

const code = (dir) => {
  const path = join(HOME, 'code', dir)
  mkdirSync(path, { recursive: true })
  return path
}

/** session → [window, cwd, kind], plus the size tmux starts it at. */
const sessions = [
  ['storefront', 96, 22, [['dev', 'storefront', 'vite'], ['tests', 'storefront', 'vitest']]],
  ['api', 104, 24, [['server', 'api', 'api'], ['jobs', 'api', 'worker']]],
  ['ops', 84, 20, [['release', 'ops', 'deploy'], ['history', 'storefront', 'gitlog']]],
]

const box = (x, y, w, h, z) => ({ x, y, w, h, z })
const layout = {
  tiles: {
    'tmux:storefront/dev/0': box(0, 0, 760, 420, 2),
    'tmux:storefront/tests/0': box(790, 0, 600, 420, 3),
    'tmux:api/server/0': box(0, 550, 860, 470, 4),
    'tmux:api/jobs/0': box(890, 550, 500, 470, 5),
    'tmux:ops/release/0': box(1520, 0, 640, 380, 6),
    'tmux:ops/history/0': box(1520, 410, 640, 610, 7),
  },
  // Above 55% so tiles render live (and in color), not as text snapshots.
  viewport: { x: 92, y: 178, zoom: 0.66 },
  hidden: [],
  views: [],
}

let server
try {
  for (const [name, cols, rows, windows] of sessions) {
    const [[first, cwd, kind], ...rest] = windows
    tmux('new-session', '-d', '-s', name, '-n', first, '-c', code(cwd), '-x', String(cols), '-y', String(rows), run(kind))
    for (const [win, dir, k] of rest) tmux('new-window', '-t', `${name}:`, '-n', win, '-c', code(dir), run(k))
  }
  mkdirSync(join(HOME, '.config/terminal-canvas'), { recursive: true })
  writeFileSync(join(HOME, '.config/terminal-canvas/layout.json'), JSON.stringify(layout))

  server = spawn(process.execPath, ['--experimental-strip-types', join(ROOT, 'src/server/index.ts')], {
    cwd: ROOT,
    env: { ...env, TCV_PORT: String(PORT), TCV_NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('terminal-canvas en') && resolve())
    server.on('exit', (c) => reject(new Error(`server exited (${c})`)))
  })

  const token = readFileSync(join(HOME, '.config/terminal-canvas/token'), 'utf8').trim()
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 2, colorScheme: 'dark' })
  await page.goto(`http://127.0.0.1:${PORT}/?token=${token}`)
  await page.waitForSelector('.tile', { timeout: 8000 })
  // Wait for every pane to finish printing (see feed.mjs's DELAY; the first
  // run of a freshly copied binary can also take a while), then clear the
  // activity marks that output left everywhere: only the streaming API log
  // and the deploy prompt should ask for attention.
  const last = {
    'tmux:storefront/dev/0': 'hmr update',
    'tmux:storefront/tests/0': 'to quit',
    'tmux:api/server/0': 'HTTP/1.1',
    'tmux:api/jobs/0': '#4',
    'tmux:ops/release/0': '[y/N]',
    'tmux:ops/history/0': 'docker compose',
  }
  await page.waitForFunction(
    (want) =>
      Object.entries(want).every(([id, text]) =>
        document.querySelector(`[data-id="${id}"] .xterm-rows`)?.textContent.includes(text),
      ),
    last,
    { timeout: 30000, polling: 250 },
  )
  await sleep(1500)
  const tile = (id) => page.click(`[data-id="${id}"] .tile-body`)
  for (const id of ['tmux:storefront/dev/0', 'tmux:api/jobs/0', 'tmux:ops/history/0', 'tmux:storefront/tests/0']) {
    await tile(id)
    await sleep(250)
  }
  await page.mouse.click(1580, 940)
  await sleep(300)
  await tile('tmux:storefront/tests/0')
  await sleep(5000)
  await page.screenshot({ path: OUT })
  await browser.close()
  console.log(`[screenshot] ${OUT}`)
} finally {
  server?.kill()
  try {
    tmux('kill-server')
  } catch {
    /* never started */
  }
  rmSync(WORK, { recursive: true, force: true })
}
