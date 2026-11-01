// Minimal CDP harness for local Chromium; no test runner or browser download required.
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export class Browser {
  static async launch() {
    const b = new Browser()
    b.profile = await mkdtemp(join(tmpdir(), 'webdrop-test-'))
    b.child = spawn(process.env.CHROME_PATH || '/usr/bin/google-chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${b.profile}`, '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
    const endpoint = await new Promise((resolve, reject) => {
      let output = ''
      const timeout = setTimeout(() => reject(Error('Chrome launch timeout')), 15000)
      b.child.on('error', reject)
      b.child.stderr.on('data', (chunk) => {
        output += chunk
        const match = output.match(/DevTools listening on (ws:\/\/\S+)/)
        if (match) { clearTimeout(timeout); resolve(match[1]) }
      })
    })
    b.socket = new WebSocket(endpoint)
    b.pending = new Map(); b.listeners = new Map(); b.id = 0
    await new Promise((resolve, reject) => { b.socket.onopen = resolve; b.socket.onerror = reject })
    b.socket.onmessage = ({ data }) => {
      const message = JSON.parse(data)
      if (message.id) {
        const pending = b.pending.get(message.id)
        if (!pending) return
        b.pending.delete(message.id); clearTimeout(pending.timer)
        if (message.error) pending.reject(Error(`${pending.method}: ${message.error.message}`)); else pending.resolve(message.result)
      } else for (const listener of b.listeners.get(`${message.sessionId}:${message.method}`) || []) listener(message.params)
    }
    return b
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`CDP timeout: ${method}`)) }, 20000)
      this.pending.set(id, { resolve, reject, timer, method })
      this.socket.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }
  on(sessionId, method, listener) {
    const key = `${sessionId}:${method}`
    if (!this.listeners.has(key)) this.listeners.set(key, new Set())
    this.listeners.get(key).add(listener)
    return () => this.listeners.get(key).delete(listener)
  }
  async newPage({ width = 1440, height = 900, mobile = false } = {}) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    const send = (method, params) => this.send(method, params, sessionId)
    await send('Page.enable'); await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width, height, mobile, deviceScaleFactor: 1 })
    const errors = []
    this.on(sessionId, 'Runtime.exceptionThrown', e => errors.push(e.exceptionDetails.text))
    return {
      sessionId, targetId, send, consoleErrors: errors,
      goto: async (url) => { await send('Page.navigate', { url }); await sleep(1500) },
      eval: async (fn, arg) => {
        const result = await send('Runtime.evaluate', { expression: `(${fn})(${arg === undefined ? '' : JSON.stringify(arg)})`, awaitPromise: true, returnByValue: true })
        if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
        return result.result.value
      },
      screenshot: async ({ path, format = 'png' }) => { const result = await send('Page.captureScreenshot', { format }); await writeFile(path, Buffer.from(result.data, 'base64')) },
    }
  }
  async close() {
    this.socket?.close(); this.child?.kill()
    for (const pending of this.pending?.values() || []) { clearTimeout(pending.timer); pending.reject(Error('Browser closed')) }
    await sleep(200)
    await rm(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

// Types a random room code into the four boxes and lets the page auto-join; if the room does not
// exist yet, falls back to the create button. Returns the code used.
export async function enterRoom(page, code = String(Math.floor(Math.random() * 9000) + 1000)) {
  await page.eval((value) => {
    const inputs = [...document.querySelectorAll('[role=group][aria-label^="房间号"] input')]
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    inputs.forEach((input, index) => {
      setter.call(input, value[index] ?? '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }, code)
  // Wait for the auto-join attempt to settle: either the room opens, or the create offer appears.
  for (let i = 0; i < 200; i++) {
    const state = await page.eval(() => ({
      room: !!document.querySelector('textarea'),
      offer: !!document.querySelector('[data-create-room]'),
    }))
    if (state.room) return code
    if (state.offer) break
    await sleep(100)
  }
  await page.eval(() => document.querySelector('[data-create-room]')?.click())
  for (let i = 0; i < 200; i++) {
    if (await page.eval(() => !!document.querySelector('textarea'))) return code
    await sleep(100)
  }
  throw Error('enterRoom failed: ' + (await page.eval(() => document.body.innerText.slice(0, 200))))
}
