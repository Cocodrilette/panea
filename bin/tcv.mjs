#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const child = spawn(process.execPath, ['--experimental-strip-types', join(root, 'src/server/index.ts'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: root,
})
child.on('exit', (c) => process.exit(c ?? 0))
