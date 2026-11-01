import assert from 'node:assert/strict'
import { Browser, sleep, joinRoom } from './browser.mjs'
const a = await Browser.launch(), b = await Browser.launch()
const wait = async (p, fn) => { for (let i = 0; i < 150; i++) { if (await p.eval(fn)) return; await sleep(100) } throw Error(await p.eval(() => document.body.innerText)) }
try {
 const p = await a.newPage(), q = await b.newPage()
 const url = process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5191'
 for (const page of [p, q]) {
   await page.goto(url)
   await page.eval(() => document.querySelector('[role=group] input')?.focus())
    for (const ch of '0042') { await page.send('Input.insertText', { text: ch }); await sleep(80) }
   assert.equal(await page.eval(() => [...document.querySelectorAll('[role=group] input')].map(el => el.value).join('')), '0042')
 }
 await p.eval(() => document.querySelector('[data-create-room]')?.click())
 await wait(p, () => !!document.querySelector('textarea'))
 assert.equal(await p.eval(() => document.querySelector('h1').lastElementChild.textContent), '0042')
 await q.eval(() => document.querySelector('[data-create-room]')?.click())
 await wait(q, () => document.body.innerText.includes('这个房间号已被占用'))
 assert.equal(await q.eval(async () => (await (await fetch('/api/v1/session')).json()).data.memberships.length), 0)
 await joinRoom(q, '0042')
 await wait(q, () => !!document.querySelector('textarea'))
 assert.equal(await q.eval(() => document.querySelector('h1').lastElementChild.textContent), '0042')
 assert.equal(await q.eval(() => [...document.querySelectorAll('button')].some(e => e.textContent.trim() === '管理')), false)
 assert.deepEqual(p.consoleErrors, []); assert.deepEqual(q.consoleErrors, [])
 console.log('PASS exact 0042 creation, collision rejected without membership, independent join grants member only')
} finally { await a.close(); await b.close() }
