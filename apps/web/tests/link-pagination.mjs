import assert from 'node:assert/strict'
import { Browser, sleep, enterRoom } from './browser.mjs'
const browser = await Browser.launch()
const wait = async (p, fn) => { for (let i = 0; i < 150; i++) { if (await p.eval(fn)) return; await sleep(100) } throw Error(await p.eval(() => document.body.innerText)) }
try {
 const p = await browser.newPage()
 await p.goto(process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5191')
 await enterRoom(p); await wait(p, () => !!document.querySelector('textarea'))
 await p.eval(() => { const d = new DataTransfer(); d.items.add(new File(['links'], 'links.txt', { type: 'text/plain' })); const e = document.querySelector('input[type=file]'); e.files = d.files; e.dispatchEvent(new Event('change', { bubbles: true })) })
 await wait(p, () => !!document.querySelector('[aria-label="分享 links.txt"]'))
 await p.eval(async () => {
   const session = (await (await fetch('/api/v1/session')).json()).data
   const room = location.pathname.split('/').at(-1)
   const item = (await (await fetch(`/api/v1/rooms/${room}/items`)).json()).data[0]
   for (let i = 0; i < 31; i++) {
     const response = await fetch(`/api/v1/assets/${item.asset.id}/links`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() }, body: '{}' })
     if (!response.ok) throw Error(`Seed failed ${response.status}`)
   }
 })
 const pages = new Set()
 await p.send('Network.enable')
 browser.on(p.sessionId, 'Network.responseReceived', e => { if (/\/rooms\/[^/]+\/links$/.test(new URL(e.response.url).pathname)) pages.add(new URL(e.response.url).search) })
 await p.eval(() => document.querySelector('[aria-label="分享 links.txt"]').click())
 await wait(p, () => document.querySelectorAll('[role=dialog] .font-mono').length === 31)
 assert.equal(pages.size, 2)
 assert.deepEqual(p.consoleErrors, [])
 console.log('PASS 31 real links loaded across two pages into share dialog')
} finally { await browser.close() }
