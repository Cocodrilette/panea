import * as esbuild from 'esbuild'
import { mkdirSync, copyFileSync } from 'node:fs'

const watch = process.argv.includes('--watch')
mkdirSync('dist', { recursive: true })
copyFileSync('src/client/index.html', 'dist/index.html')

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
