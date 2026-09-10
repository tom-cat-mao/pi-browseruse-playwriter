import fs from 'node:fs'
import path from 'node:path'

const cwd = process.argv[2] ?? process.cwd()
fs.writeFileSync(path.join(cwd, 'silent-worker-started.txt'), String(process.pid))
setTimeout(() => {
  fs.writeFileSync(path.join(cwd, 'silent-worker-late.txt'), String(process.pid))
}, 600)
setInterval(() => {
  // Keep the child alive until the pool's startup/deadline cancellation kills it.
}, 1_000)
