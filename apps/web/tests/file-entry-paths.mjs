import assert from 'node:assert/strict'
import { Browser, sleep, enterRoom } from './browser.mjs'
const browser = await Browser.launch()
const wait = async (p, fn) => { for (let i = 0; i < 100; i++) { if (await p.eval(fn)) return; await sleep(100) } throw Error(await p.eval(() => document.body.innerText)) }
try {
 const p = await browser.newPage({ width: 390, height: 844, mobile: true })
 await p.goto(process.env.WEBDROP_TEST_URL)
 await enterRoom(p); await wait(p, () => !!document.querySelector('textarea'))
 await p.eval(() => {
   const files = new DataTransfer(); files.items.add(new File(['drop bytes'], 'drop.txt', { type: 'text/plain' })); files.items.add(new File([], 'empty.txt', { type: 'text/plain' }))
   window.__dropFiles = files
   document.querySelector('[role=log]').dispatchEvent(new DragEvent('dragenter', { dataTransfer: files, bubbles: true, cancelable: true }))
 })
 await wait(p, () => document.body.innerText.includes('松开即可上传文件'))
 await p.eval(() => document.querySelector('[role=log]').dispatchEvent(new DragEvent('drop', { dataTransfer: window.__dropFiles, bubbles: true, cancelable: true })))
 await wait(p, () => !!document.querySelector('[role=log] [aria-label="预览 drop.txt"]'))
 assert.equal(await p.eval(() => document.body.innerText.includes('松开即可上传文件')), false)
 assert.equal(await p.eval(() => document.body.innerText.includes('已跳过空文件')), true)
 await p.eval(() => {
   const files = new DataTransfer(); files.items.add(new File(['paste bytes'], 'paste.txt', { type: 'text/plain' }))
   document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: files, bubbles: true, cancelable: true }))
 })
 await wait(p, () => !!document.querySelector('[role=log] [aria-label="预览 paste.txt"]') && !document.querySelector('[aria-label="上传队列"]'))
 await p.eval(async () => {
   const cap = (await (await fetch('/api/v1/capabilities')).json()).data
   const file = new File(['metadata-only limit check'], 'oversized.txt', { type: 'text/plain' })
   Object.defineProperty(file, 'size', { value: cap.maxFileBytes + 1 })
   const files = new DataTransfer(); files.items.add(file)
   const input = document.querySelector('input[type=file]'); input.files = files.files
   input.dispatchEvent(new Event('change', { bubbles: true }))
 })
 await wait(p, () => document.body.innerText.includes('超过'))
 assert.equal(await p.eval(() => !!document.querySelector('[aria-label="预览 oversized.txt"]')), false)
 const names = await p.eval(async () => (await (await fetch(`/api/v1/rooms/${location.pathname.split('/').at(-1)}/items`)).json()).data.map(item => item.asset.filename).sort())
 assert.deepEqual(names, ['drop.txt', 'paste.txt'])
 let held = false
 await p.send('Fetch.enable', { patterns: [{ urlPattern: '*/uploads/*/content', requestStage: 'Request' }] })
 browser.on(p.sessionId, 'Fetch.requestPaused', () => { held = true })
 await p.eval(() => {
   const files = new DataTransfer(); files.items.add(new File(['remove queue'], 'remove.txt', { type: 'text/plain' }))
   const input = document.querySelector('input[type=file]'); input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }))
 })
 for (let i = 0; i < 100 && !held; i++) await sleep(50)
 assert.equal(held, true)
 await p.eval(() => [...document.querySelectorAll('[aria-label="上传队列"] button')].find(e => e.textContent.trim() === '取消').click())
 await wait(p, () => document.querySelector('[aria-label="上传队列"]')?.innerText.includes('已取消'))
 await p.eval(() => [...document.querySelectorAll('[aria-label="上传队列"] button')].find(e => e.textContent.trim() === '移除').click())
 await wait(p, () => !document.querySelector('[aria-label="上传队列"]'))
 await p.send('Fetch.disable')
 assert.equal(await p.eval(() => !!document.querySelector('[role=log] [aria-label="预览 remove.txt"]')), false)
 assert.deepEqual(p.consoleErrors, [])
 console.log('PASS drag cue/drop and file-paste handlers reach real upload; empty and synthetic oversized metadata rejected before upload')
} finally { await browser.close() }
