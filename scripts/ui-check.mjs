import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const OUT = process.env.SP
const URL = `http://127.0.0.1:${process.env.PORT ?? 7799}/`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

// The token link signs the browser in, then redirects to the canvas.
const token = readFileSync(join(homedir(), '.config/terminal-canvas/token'), 'utf8').trim()
await page.goto(`${URL}?token=${token}`)
await page.waitForSelector('.tile', { timeout: 8000 })
await page.waitForTimeout(2500)

const report = await page.evaluate(() => {
  const tiles = [...document.querySelectorAll('.tile')]
  return {
    zoom: document.getElementById('zoom-readout').textContent,
    status: document.getElementById('status').textContent,
    tiles: tiles.map((el) => {
      const rows = el.querySelectorAll('.xterm-rows > div').length
      const screen = el.querySelector('.xterm-screen')
      const text = [...el.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent.trimEnd()).filter(Boolean)
      return {
        id: el.dataset.id,
        lod: el.dataset.lod,
        box: { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) },
        renderedRows: rows,
        screen: screen ? { w: Math.round(screen.getBoundingClientRect().width), h: Math.round(screen.getBoundingClientRect().height) } : null,
        firstLines: text.slice(0, 2),
        nonEmptyLines: text.length,
      }
    }),
  }
})
console.log(JSON.stringify(report, null, 2))
console.log('errores de consola:', errors.length ? errors : 'ninguno')

await page.screenshot({ path: `${OUT}/01-fit.png` })

// Zoom in on the first tile and focus it, then type something.
await page.click('.tile .tile-head button[title^="Zoom"]')
await page.waitForTimeout(900)
await page.screenshot({ path: `${OUT}/02-zoom.png` })

const focusedInfo = await page.evaluate(() => {
  const el = document.querySelector('.tile.focused')
  if (!el) return null
  const screen = el.querySelector('.xterm-screen').getBoundingClientRect()
  const body = el.querySelector('.tile-body').getBoundingClientRect()
  return {
    id: el.dataset.id,
    fillRatio: { w: +(screen.width / body.width).toFixed(3), h: +(screen.height / body.height).toFixed(3) },
  }
})
console.log('tile enfocado:', JSON.stringify(focusedInfo))

await page.keyboard.type('echo UI_OK_77\n')
await page.waitForTimeout(1200)
const echoed = await page.evaluate(() =>
  [...document.querySelectorAll('.tile.focused .xterm-rows > div')].map((r) => r.textContent).join('\n'),
)
console.log('eco en pantalla:', echoed.includes('UI_OK_77') ? 'OK' : 'FALLO\n' + echoed.slice(0, 400))
await page.screenshot({ path: `${OUT}/03-typed.png` })

// Scroll ownership. A wheel over a terminal belongs to its scrollback: if the
// canvas panned through the same gesture, the text you were reading would slide
// away under you.
await page.keyboard.type('seq 1 400\n')
await page.waitForTimeout(1600)

const readWorld = () => page.evaluate(() => getComputedStyle(document.getElementById('world')).transform)
const readScroll = () =>
  page.evaluate(() => Math.round(document.querySelector('.tile.focused .xterm-viewport').scrollTop))

const term = await page.locator('.tile.focused .xterm-screen').boundingBox()
await page.mouse.move(term.x + term.width / 2, term.y + term.height / 2)
const world0 = await readWorld()
const scroll0 = await readScroll()
// Enough notches to run out of scrollback, which is where the canvas used to
// grab the leftover momentum.
for (let i = 0; i < 40; i++) {
  await page.mouse.wheel(0, -400)
  await page.waitForTimeout(20)
}
await page.waitForTimeout(400)
const world1 = await readWorld()
const scroll1 = await readScroll()
console.log('scroll sobre terminal:', scroll1 < scroll0 ? `OK (${scroll0} → ${scroll1})` : `FALLO scrollTop ${scroll0} → ${scroll1}`)
console.log('canvas quieto mientras la terminal scrollea:', world1 === world0 ? 'OK' : `FALLO ${world0} → ${world1}`)

const bg = await page.evaluate(() => {
  for (let y = 60; y < innerHeight - 80; y += 20) {
    for (let x = 10; x < innerWidth - 10; x += 20) {
      const el = document.elementFromPoint(x, y)
      if (el && (el.id === 'viewport' || el.id === 'world')) return { x, y }
    }
  }
  return null
})
if (!bg) {
  console.log('scroll en el fondo: SALTADO (no se vio fondo libre)')
} else {
  await page.mouse.move(bg.x, bg.y)
  await page.mouse.wheel(0, 250)
  await page.waitForTimeout(300)
  console.log('scroll en el fondo panea:', (await readWorld()) !== world1 ? 'OK' : 'FALLO')
}

// Zoom far out to exercise the snapshot level of detail. A ctrl-wheel is
// what a trackpad pinch produces, and what the canvas treats as zoom.
await page.mouse.move(800, 500)
await page.keyboard.down('Control')
for (let i = 0; i < 14; i++) await page.mouse.wheel(0, 60)
await page.keyboard.up('Control')
await page.waitForTimeout(2400)
const lod = await page.evaluate(() => ({
  zoom: document.getElementById('zoom-readout').textContent,
  lods: [...document.querySelectorAll('.tile')].map((el) => el.dataset.lod),
  snapshotChars: [...document.querySelectorAll('.tile-snapshot')].map((el) => el.textContent.trim().length),
}))
console.log('LOD lejano:', JSON.stringify(lod))
await page.screenshot({ path: `${OUT}/04-far.png` })

await browser.close()
