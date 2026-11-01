import assert from 'node:assert/strict'
import { Browser, sleep } from './browser.mjs'
const browser = await Browser.launch()
const wait = async (page, fn) => { for (let i = 0; i < 150; i++) { if (await page.eval(fn)) return; await sleep(100) } throw Error(await page.eval(() => document.body.innerText)) }
try {
 const page = await browser.newPage({ width: 390, height: 844, mobile: true })
 await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__sources=[];const Original=window.EventSource;window.EventSource=class extends Original{constructor(...args){super(...args);window.__sources.push(this)}}` })
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
 let paused, snapshots = 0
 await page.send('Network.enable')
 browser.on(page.sessionId, 'Network.responseReceived', event => {
   if (/\/rooms\/[^/]+$/.test(new URL(event.response.url).pathname) && event.response.status === 200) snapshots++
 })
 await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/items?cursor=*', requestStage: 'Response' }] })
 browser.on(page.sessionId, 'Fetch.requestPaused', async event => {
   if (!paused) paused = event
   else await page.send('Fetch.continueRequest', { requestId: event.requestId })
 })
 await page.eval(() => [...document.querySelectorAll('button')].find(e => e.textContent.includes('加载更早')).click())
 for (let i = 0; i < 100 && !paused; i++) await sleep(100)
 assert.ok(paused, 'Old history response must be paused')
 await page.eval(() => window.__sources.at(-1).dispatchEvent(new Event('resync.required')))
 for (let i = 0; i < 100 && snapshots === 0; i++) await sleep(100)
 assert.ok(snapshots > 0, 'A new snapshot must complete before old response is released')
 await sleep(200)
 await page.send('Fetch.continueRequest', { requestId: paused.requestId })
 await sleep(200)
 assert.equal(await page.eval(() => document.querySelectorAll('[data-item-id]').length), 30)
 await page.eval(() => [...document.querySelectorAll('button')].find(e => e.textContent.includes('加载更早')).click())
 await wait(page, () => document.querySelectorAll('[data-item-id]').length === 40)
 assert.deepEqual(await page.eval(() => [...document.querySelectorAll('[role=log] article')].map(e => Number(e.innerText.match(/游标检查 (\d+)/)[1]))), Array.from({ length: 40 }, (_, i) => i))
 assert.deepEqual(page.consoleErrors, [])
 console.log('PASS stale history response ignored after resync; new snapshot cursor still loads all 40 ordered messages')
} finally { await browser.close() }
