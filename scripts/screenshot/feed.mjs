/**
 * Fictional terminal output for the README screenshot (see run.mjs), one kind
 * per pane: `feed.mjs <kind>`. Output waits for DELAY ms, until the canvas has
 * sized the pane, so it is laid out at the tile's final size.
 */
const kind = process.argv[2]
const e = (c) => (s) => `\x1b[${c}m${s}\x1b[0m`
const dim = e('2'), bold = e('1'), green = e('32'), red = e('31'), yellow = e('33'), mag = e('35'), cyan = e('36'), gray = e('90')
const out = (s = '') => process.stdout.write(s + '\n')
const pick = (a) => a[Math.floor(Math.random() * a.length)]
let t = 10 * 3600 + 42 * 60 + 7
const clock = () => { t += 1 + Math.floor(Math.random() * 3); const p = (n) => String(n).padStart(2, '0'); return `${p(Math.floor(t / 3600))}:${p(Math.floor(t / 60) % 60)}:${p(t % 60)}` }
const every = (ms, f) => setInterval(f, ms)
const hold = () => setInterval(() => {}, 1 << 30)

// Only the prompts keep a cursor; on a log it is just a stray block.
if (!['deploy', 'gitlog'].includes(kind)) process.stdout.write('\x1b[?25l')
setTimeout(main, Number(process.env.DELAY ?? 7000))
function main() {
if (kind === 'vite') {
  out(); out(`  ${green(bold('VITE'))} ${green('v6.0.3')}  ${dim('ready in')} ${bold('412')} ${dim('ms')}`); out()
  out(`  ${green('➜')}  ${bold('Local')}:   ${cyan('http://localhost:5173/')}`)
  out(`  ${green('➜')}  ${dim('Network')}: ${dim('use')} ${bold('--host')} ${dim('to expose')}`)
  out(`  ${green('➜')}  ${dim('press')} ${bold('h + enter')} ${dim('to show help')}`); out()
  const files = ['src/components/Cart.tsx', 'src/components/ProductCard.tsx', 'src/routes/checkout.tsx', 'src/styles/theme.css', 'src/hooks/useInventory.ts']
  for (let i = 0; i < 16; i++) out(`${dim(clock())} ${cyan(bold('[vite]'))} ${green('hmr update')} ${dim('/' + pick(files))}`)
  hold()
}

if (kind === 'vitest') {
  out(); out(` ${bold(cyan('DEV'))}  ${cyan('v2.1.8')} ${gray('~/code/storefront')}`); out()
  const tests = [['src/lib/money.test.ts', 12, 4], ['src/lib/cart.test.ts', 18, 9], ['src/hooks/useInventory.test.ts', 7, 31], ['src/routes/checkout.test.tsx', 23, 118], ['src/components/Cart.test.tsx', 15, 64], ['src/components/ProductCard.test.tsx', 9, 41], ['src/api/client.test.ts', 11, 22]]
  for (const [f, n, ms] of tests) out(` ${green('✓')} ${f} ${gray(`(${n} tests)`)} ${yellow(ms + 'ms')}`)
  out(); out(` ${dim('Test Files')}  ${green(bold('7 passed'))} ${gray('(7)')}`)
  out(` ${dim('     Tests')}  ${green(bold('95 passed'))} ${gray('(95)')}`)
  out(` ${dim('  Start at')}  10:41:58`); out(` ${dim('  Duration')}  1.84s`); out()
  out(` ${bold(green('PASS'))}  ${green('Waiting for file changes...')}`)
  out(`       ${dim('press')} ${bold('h')} ${dim('to show help,')} ${bold('q')} ${dim('to quit')}`)
  hold()
}

if (kind === 'api') {
  out(`${green('INFO')}:     Uvicorn running on ${bold('http://127.0.0.1:8000')} (Press CTRL+C to quit)`)
  out(`${green('INFO')}:     Started reloader process [48211] using ${cyan(bold('WatchFiles'))}`)
  out(`${green('INFO')}:     Application startup complete.`)
  const reqs = [['GET', '/v1/products?page=2', 200], ['GET', '/v1/products/sku-1182', 200], ['POST', '/v1/cart/items', 201], ['GET', '/v1/cart', 200], ['PATCH', '/v1/cart/items/7', 200], ['POST', '/v1/checkout', 202], ['GET', '/v1/inventory/sku-0931', 404], ['GET', '/v1/health', 200], ['DELETE', '/v1/cart/items/3', 204]]
  const line = () => { const [m, p, s] = pick(reqs); const sc = s >= 400 ? yellow(String(s)) : green(String(s)); out(`${green('INFO')}:     127.0.0.1:${50000 + Math.floor(Math.random() * 9000)} - "${bold(m + ' ' + p)} HTTP/1.1" ${sc}`) }
  for (let i = 0; i < 18; i++) line()
  every(700, line)
}

if (kind === 'worker') {
  out(`${dim('[worker]')} ${bold('queue')} ${cyan('default')}, ${cyan('emails')}, ${cyan('webhooks')} ${dim('· concurrency 8')}`)
  const jobs = [['emails', 'order-confirmation', 'sent'], ['webhooks', 'payment.succeeded', 'handled'], ['default', 'resize-product-images', 'done'], ['emails', 'shipping-update', 'sent'], ['default', 'sync-inventory', 'done'], ['webhooks', 'carrier.status_changed', 'handled']]
  const line = () => { const [q, j, v] = pick(jobs); const ok = Math.random() > 0.08; out(`${dim(clock())} ${mag(q.padEnd(8))} ${ok ? green('✔') : red('✖')} ${j} ${gray('#' + (4800 + Math.floor(Math.random() * 99)))} ${ok ? dim(v + ` in ${40 + Math.floor(Math.random() * 300)}ms`) : red('retry 1/5 in 30s')}`) }
  for (let i = 0; i < 16; i++) line()
  hold()
}

if (kind === 'deploy') {
  out(`${bold('deploy')} ${cyan('storefront@1.8.0')} ${dim('→')} ${bold('production')}`); out()
  for (const s of ['lint & typecheck', 'unit tests (95)', 'build client bundle', 'build api image', 'push image registry.internal/storefront:1.8.0', 'database migrations: 2 pending']) out(`  ${green('✓')} ${s}`)
  out(); out(`  ${dim('Changes since 1.7.4:')}`)
  for (const c of ['feat: saved carts across devices', 'fix: rounding in multi-currency totals', 'perf: lazy-load product gallery']) out(`    ${gray('•')} ${c}`)
  out(); process.stdout.write(`${cyan('?')} ${bold('Ship storefront@1.8.0 to production?')} ${dim('[y/N]')} `)
  process.stdin.resume()
}

if (kind === 'gitlog') {
  const commits = [['*', 'a41f9c2', 'HEAD -> main, origin/main', 'feat: saved carts across devices', '2 hours'], ['*', '9e03b7d', '', 'fix: rounding in multi-currency totals', '5 hours'], ['*', 'c18d2e0', '', 'Merge pull request #212 from lazy-gallery', '1 day'], ['|\\', '', '', '', ''], ['| *', '57ab1f4', '', 'perf: lazy-load product gallery', '1 day'], ['|/', '', '', '', ''], ['*', '3fd0c91', 'tag: v1.7.4', 'chore: release 1.7.4', '3 days'], ['*', 'e6a2b58', '', 'feat: inventory webhooks from carriers', '4 days'], ['*', '0b9c7aa', '', 'test: checkout happy path end to end', '5 days'], ['*', '7d41e2c', '', 'refactor: split cart store into slices', '6 days'], ['*', 'b2f8a03', '', 'fix: keep coupon after login', '1 week'], ['*', '4c6e9d1', 'tag: v1.7.3', 'chore: release 1.7.3', '1 week'], ['*', 'f90a3b7', '', 'feat: product search with typo tolerance', '2 weeks'], ['*', '18be5c2', '', 'docs: local setup with docker compose', '2 weeks']]
  out(`${cyan('~/code/storefront')} ${mag('❯')} git log --graph --oneline`)
  for (const [g, h, r, m, w] of commits) out(h ? `${red(g)} ${yellow(h)}${r ? ' ' + yellow('(') + cyan(bold(r)) + yellow(')') : ''} ${m} ${green('(' + w + ' ago)')}` : red(g))
  out(`${cyan('~/code/storefront')} ${mag('❯')} `)
  process.stdin.resume()
}

}
