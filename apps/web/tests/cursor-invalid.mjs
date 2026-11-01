import assert from 'node:assert/strict'
import { Browser, sleep } from './browser.mjs'
const browser = await Browser.launch()
const wait = async (page, fn) => { for (let i = 0; i < 150; i++) { if (await page.eval(fn)) return; await sleep(100) } throw Error(await page.eval(() => document.body.innerText)) }
try {
 const page = await browser.newPage({ width: 390, height: 844, mobile: true })
 await page.goto(process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5194')
 await page.eval(() => document.querySelector('[aria-label="随机创建房间"]').click()); await wait(page, () => !!document.querySelector('textarea'))
 await page.eval(async () => {
   const session = (await (await fetch('/api/v1/session')).json()).data, room = location.pathname.split('/').at(-1)
   for (let i = 0; i < 40; i++) {
     const response = await fetch(`/api/v1/rooms/${room}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ text: `游标检查 ${i}` }) })
     if (!response.ok) throw Error(`Seed ${response.status}`)
   }
 })
 await wait(page, () => document.querySelectorAll('[data-item-id]').length === 40)
 assert.deepEqual(await page.eval(() => [...document.querySelectorAll('[role=log] article')].map(e => Number(e.innerText.match(/游标检查 (\d+)/)[1]))), Array.from({ length: 40 }, (_, i) => i))
 await page.goto(await page.eval(() => location.href))
 await wait(page, () => document.querySelectorAll('[data-item-id]').length === 30)
 let invalid = false, snapshots = 0
 await page.send('Network.enable')
 browser.on(page.sessionId, 'Network.responseReceived', event => {
   const url = new URL(event.response.url)
   if (url.pathname.endsWith('/items') && url.searchParams.has('cursor') && event.response.status === 400) invalid = true
   if (/\/rooms\/[^/]+$/.test(url.pathname) && event.response.status === 200) snapshots++
 })
 const removed = await page.eval(async () => {
   const session = (await (await fetch('/api/v1/session')).json()).data, room = location.pathname.split('/').at(-1)
   const id = (await (await fetch(`/api/v1/rooms/${room}/items`)).json()).page.nextCursor
   const response = await fetch(`/api/v1/rooms/${room}/items/${id}`, { method: 'DELETE', headers: { 'X-CSRF-Token': session.csrfToken } })
   if (!response.ok) throw Error(`Delete ${response.status}`)
   return id
 })
 await wait(page, () => document.querySelectorAll('[data-item-id]').length === 29)
 await page.eval(() => [...document.querySelectorAll('button')].find(e => e.textContent.includes('加载更早')).click())
 await wait(page, () => document.querySelectorAll('[data-item-id]').length === 30)
 assert.equal(invalid, true); assert.ok(snapshots > 0)
 await page.eval(() => [...document.querySelectorAll('button')].find(e => e.textContent.includes('加载更早')).click())
 await wait(page, () => document.querySelectorAll('[data-item-id]').length === 39)
 const ids = await page.eval(() => [...document.querySelectorAll('[data-item-id]')].map(e => e.dataset.itemId))
 assert.equal(new Set(ids).size, 39); assert.equal(ids.includes(removed), false)
 assert.deepEqual(await page.eval(() => [...document.querySelectorAll('[role=log] article')].map(e => Number(e.innerText.match(/游标检查 (\d+)/)[1]))), Array.from({ length: 40 }, (_, i) => i).filter(i => i !== 10))
 assert.deepEqual(page.consoleErrors, [])
 console.log('PASS deleted cursor returns 400, resync recovers pagination with 39 unique surviving messages')
} finally { await browser.close() }
