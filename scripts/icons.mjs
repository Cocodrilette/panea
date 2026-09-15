/**
 * Genera los PNG del ícono de la PWA a partir de un SVG inline, usando el
 * chromium que ya trae playwright. Se corre a mano (`npm run icons`) y los
 * PNG se versionan: el build sólo los copia a dist/.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

/**
 * @param {object} opts
 * @param {number} opts.radius  esquinas del fondo (0 = cuadrado, para maskable)
 * @param {number} opts.inset   cuánto encoger el dibujo; el safe zone de una
 *                              máscara es el 80% central, así que ahí va 0.72
 */
const svg = ({ radius, inset }) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#171a23"/>
      <stop offset="1" stop-color="#0a0b0f"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="${radius}" fill="url(#bg)"/>
  <!-- El dibujo va de (116,110) a (424,390): el translate extra lo centra. -->
  <g transform="translate(${256 * (1 - inset)} ${256 * (1 - inset)}) scale(${inset}) translate(-14 6)">
    <g opacity="0.75">
      <rect x="118" y="112" width="240" height="150" rx="20" fill="#1b1e26" stroke="#2b303c" stroke-width="4"/>
      <rect x="120" y="150" width="236" height="3" fill="#2b303c"/>
    </g>
    <rect x="154" y="196" width="268" height="192" rx="22" fill="#14161c" stroke="#39414f" stroke-width="4"/>
    <rect x="156" y="236" width="264" height="3" fill="#39414f"/>
    <g fill="#2f3644">
      <circle cx="182" cy="216" r="7"/>
      <circle cx="206" cy="216" r="7"/>
      <circle cx="230" cy="216" r="7"/>
    </g>
    <polyline points="196,276 232,306 196,336" fill="none" stroke="#6ea8fe"
      stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="256" y="316" width="96" height="20" rx="10" fill="#d7dae1"/>
  </g>
</svg>`

const TARGETS = [
  { file: 'icon-192.png', size: 192, radius: 115, inset: 1 },
  { file: 'icon-512.png', size: 512, radius: 115, inset: 1 },
  { file: 'icon-maskable-512.png', size: 512, radius: 0, inset: 0.72 },
]

mkdirSync('assets/icons', { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage()

for (const { file, size, radius, inset } of TARGETS) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<body style="margin:0">${svg({ radius, inset }).replace('width="512" height="512"', `width="${size}" height="${size}"`)}</body>`,
  )
  writeFileSync(`assets/icons/${file}`, await page.locator('svg').screenshot({ omitBackground: true }))
  console.log(`[icons] assets/icons/${file} (${size}px)`)
}

await browser.close()
