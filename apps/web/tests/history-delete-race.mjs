import assert from 'node:assert/strict'
import { Browser, sleep, enterRoom } from './browser.mjs'
const browser = await Browser.launch()
const wait = async (page, fn) => { for (let i = 0; i < 150; i++) { if (await page.eval(fn)) return; await sleep(100) } throw Error(await page.eval(() => document.body.innerText)) }
try {
 const page = await browser.newPage({ width: 390, height: 844, mobile: true })
 await page.goto(process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5194')
 await enterRoom(page); await wait(page, () => !!document.querySelector('textarea'))
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
 let paused
 await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/items?cursor=*', requestStage: 'Response' }] })
 browser.on(page.sessionId, 'Fetch.requestPaused', event => { paused = event })
 await page.eval(() => [...document.querySelectorAll('button')].find(e => e.textContent.includes('加载更早')).click())
 for(let i=0;i<100&&!paused;i++) await sleep(100)
 assert.ok(paused, 'History response must be paused')
 const response = await page.send('Fetch.getResponseBody', { requestId: paused.requestId })
 const data = JSON.parse(response.base64Encoded ? Buffer.from(response.body, 'base64').toString() : response.body).data
 const removed = data.at(-1).id
 await page.eval(async id => {
   const session = (await (await fetch('/api/v1/session')).json()).data, room = location.pathname.split('/').at(-1)
   const response = await fetch(`/api/v1/rooms/${room}/items/${id}`, { method: 'DELETE', headers: { 'X-CSRF-Token': session.csrfToken } })
   if(!response.ok) throw Error(`Delete ${response.status}`)
 }, removed)
 await sleep(250)
 await page.send('Fetch.continueRequest', { requestId: paused.requestId })
 await wait(page, () => document.querySelectorAll('[data-item-id]').length === 39)
 const ids = await page.eval(() => [...document.querySelectorAll('[data-item-id]')].map(e => e.dataset.itemId))
 assert.equal(ids.includes(removed),false)
 assert.equal(new Set(ids).size,39)
 assert.deepEqual(await page.eval(() => [...document.querySelectorAll('[role=log] article')].map(e => Number(e.innerText.match(/游标检查 (\d+)/)[1]))),Array.from({length:39},(_,i)=>i+1))
 assert.deepEqual(page.consoleErrors, [])
 console.log('PASS deleted event wins over delayed history response, preserving 39 unique ordered messages')
} finally { await browser.close() }
