import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
// Run against a disposable API instance; the suite creates rooms and files.
for (const script of ['pow-vectors', 'session-recovery', 'live-smoke', 'reconnect-smoke', 'history-smoke', 'upload-fault', 'text-fault', 'media-smoke', 'reduced-motion', 'event-validation']) {
  const path = fileURLToPath(new URL(`./${script}.mjs`, import.meta.url))
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path], { stdio: 'inherit', env: process.env })
    child.on('error', reject)
    child.on('exit', resolve)
  })
  if (code !== 0) process.exit(code || 1)
}
