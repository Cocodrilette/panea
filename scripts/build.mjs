import * as esbuild from 'esbuild'
import { mkdirSync, copyFileSync, cpSync } from 'node:fs'

const watch = process.argv.includes('--watch')
mkdirSync('dist', { recursive: true })
// Estáticos que no pasan por el bundler: el HTML, y el manifest y el service
// worker de la PWA (sw.js se sirve tal cual desde la raíz para tener scope /).
for (const file of ['index.html', 'manifest.webmanifest', 'sw.js']) {
  copyFileSync(`src/client/${file}`, `dist/${file}`)
}
cpSync('assets/icons', 'dist/icons', { recursive: true })

const ctx = await esbuild.context({
  entryPoints: ['src/client/main.ts'],
  bundle: true,
  outfile: 'dist/main.js',
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  minify: !watch,
  loader: { '.css': 'css' },
})

if (watch) {
  await ctx.watch()
  console.log('[build] watching…')
} else {
  await ctx.rebuild()
  await ctx.dispose()
  console.log('[build] dist/main.js')
}
