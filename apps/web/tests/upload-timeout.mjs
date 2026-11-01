import assert from 'node:assert/strict'
import { Browser, sleep } from './browser.mjs'
const browser = await Browser.launch()
const wait = async (p, fn) => { for (let i = 0; i < 150; i++) { if (await p.eval(fn)) return; await sleep(100) } throw Error(await p.eval(() => document.body.innerText)) }
try {
 const p = await browser.newPage()
 await p.goto(process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5194')
 await p.eval(() => document.querySelector('[aria-label="随机创建房间"]').click()); await wait(p, () => !!document.querySelector('textarea'))
 await p.eval(() => {
   const descriptor = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'timeout')
   window.__restoreTimeout = () => Object.defineProperty(XMLHttpRequest.prototype, 'timeout', descriptor)
   Object.defineProperty(XMLHttpRequest.prototype, 'timeout', { ...descriptor, set(value) { window.__configuredTimeout = value; descriptor.set.call(this, Math.min(value, 400)) } })
 })
 let held = false
 await p.send('Fetch.enable', { patterns: [{ urlPattern: '*/uploads/*/content', requestStage: 'Request' }] })
 browser.on(p.sessionId, 'Fetch.requestPaused', () => { held = true })
 await p.eval(() => { const d = new DataTransfer(); d.items.add(new File(['timeout recovery bytes'], 'timeout.txt', { type: 'text/plain' })); const e = document.querySelector('input[type=file]'); e.files = d.files; e.dispatchEvent(new Event('change', { bubbles: true })) })
 await wait(p, () => document.querySelector('[aria-label="上传队列"]')?.innerText.includes('上传超时'))
 assert.equal(held, true)
 assert.equal(await p.eval(() => window.__configuredTimeout), 120000)
 await p.eval(() => { window.__restoreTimeout() })
 await p.send('Fetch.disable')
 await p.eval(() => [...document.querySelectorAll('[aria-label="上传队列"] button')].find(e => e.textContent.trim() === '重试').click())
 await wait(p, () => !document.querySelector('[aria-label="上传队列"]'))
 assert.equal(await p.eval(() => document.querySelectorAll('[role=log] article').length), 1)
 await p.eval(() => document.querySelector('[aria-label="预览 timeout.txt"]').click())
 assert.equal(await p.eval(async () => (await (await fetch(document.querySelector('a[download]').href)).text())), 'timeout recovery bytes')
 assert.deepEqual(p.consoleErrors, [])
 console.log('PASS native XHR timeout (deadline accelerated to 400ms), retry and exact download; configured default is 120s')
} finally { await browser.close() }
