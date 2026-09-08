/**
 * node-pty ships a prebuilt `spawn-helper` that must be executable. npm drops
 * the exec bit when the package's install script is blocked (the default under
 * `allowScripts`), and every PTY spawn then dies with "posix_spawnp failed".
 */
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const base = 'node_modules/node-pty/prebuilds'
if (!existsSync(base)) process.exit(0)

for (const dir of readdirSync(base)) {
  const helper = join(base, dir, 'spawn-helper')
  if (!existsSync(helper)) continue
  const mode = statSync(helper).mode
  if (mode & 0o111) continue
  chmodSync(helper, 0o755)
  console.log(`[fix-node-pty] chmod +x ${helper}`)
}
