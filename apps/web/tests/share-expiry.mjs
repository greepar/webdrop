import assert from 'node:assert/strict'
import { Browser, sleep, enterRoom } from './browser.mjs'
const a = await Browser.launch(), b = await Browser.launch()
const wait = async (p, fn) => { for (let i = 0; i < 150; i++) { if (await p.eval(fn)) return; await sleep(100) } throw Error(await p.eval(() => document.body.innerText)) }
try {
 const p = await a.newPage(), publicPage = await b.newPage()
 await p.goto(process.env.WEBDROP_TEST_URL)
 await enterRoom(p); await wait(p, () => !!document.querySelector('textarea'))
 await p.eval(() => { const files = new DataTransfer(); files.items.add(new File(['expires naturally'], 'expiry.txt', { type: 'text/plain' })); const e = document.querySelector('input[type=file]'); e.files = files.files; e.dispatchEvent(new Event('change', { bubbles: true })) })
 await wait(p, () => !!document.querySelector('[aria-label="分享 expiry.txt"]'))
 const link = await p.eval(async () => {
   const session = (await (await fetch('/api/v1/session')).json()).data, room = location.pathname.split('/').at(-1)
   const item = (await (await fetch(`/api/v1/rooms/${room}/items`)).json()).data[0]
   const response = await fetch(`/api/v1/assets/${item.asset.id}/links`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ expiresAt: new Date(Date.now() + 62000).toISOString().replace(/\.\d{3}Z$/, 'Z') }) })
   if (!response.ok) throw Error(`Share ${response.status}: ${await response.text()}`)
   return (await response.json()).data
 })
 await publicPage.goto(link.shareUrl)
 await wait(publicPage, () => !!document.querySelector('a[download]'))
 assert.equal(await publicPage.eval(async url => (await fetch(url)).status, link.contentUrl), 200)
 console.log('WAIT natural expiry; no server clock or browser time acceleration')
 const deadline = Date.parse(link.expiresAt)
 while (Date.now() < deadline + 1500) await sleep(Math.min(1000, deadline + 1500 - Date.now()))
 await wait(publicPage, () => document.body.innerText.includes('链接已失效'))
 assert.equal(await publicPage.eval(async url => (await fetch(url)).status, link.contentUrl), 410)
 assert.equal(await publicPage.eval(() => !!document.querySelector('a[download]')), false)
 assert.deepEqual(publicPage.consoleErrors, [])
 console.log('PASS natural server expiry makes already-open anonymous page unavailable and raw link returns 410')
} finally { await a.close(); await b.close() }
