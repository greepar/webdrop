import assert from 'node:assert/strict'
import { Browser, sleep } from './browser.mjs'
const browser = await Browser.launch()
const wait = async (p, fn) => { for (let i = 0; i < 100; i++) { if (await p.eval(fn)) return; await sleep(100) } throw Error(await p.eval(() => document.body.innerText)) }
try {
 const p = await browser.newPage({ width: 390, height: 844, mobile: true })
 const url = process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5191'
 await browser.send('Browser.grantPermissions', { origin: url, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] })
 await p.goto(url)
 await p.eval(() => document.querySelector('[aria-label="随机创建房间"]').click()); await wait(p, () => !!document.querySelector('textarea'))
 const text = '  真实剪贴板\n保留换行  '
 await p.eval(async text => { await navigator.clipboard.writeText(text) }, text)
 await p.eval(() => [...document.querySelectorAll('button')].find(e => e.textContent.trim() === '粘贴文字').click())
 await wait(p, () => document.querySelector('textarea').value.includes('真实剪贴板'))
 assert.equal(await p.eval(() => document.querySelector('textarea').value), text)
 await p.eval(() => document.querySelector('[aria-label="发送"]').click())
 await wait(p, () => !!document.querySelector('[aria-label="复制文字"]'))
 await p.eval(async () => { await navigator.clipboard.writeText('replace me') })
 await p.eval(() => document.querySelector('[aria-label="复制文字"]').click())
 await wait(p, () => document.body.innerText.includes('已复制'))
 assert.equal(await p.eval(async () => await navigator.clipboard.readText()), text)
 const fallback = await p.eval(async () => {
   const { copyText } = await import('/src/shared/clipboard.ts')
   const write = navigator.clipboard.writeText, exec = document.execCommand
   const area = document.querySelector('textarea')
   area.value = 'selection'; area.focus(); area.setSelectionRange(1, 4)
   const count = document.querySelectorAll('textarea').length
   navigator.clipboard.writeText = async () => { throw new DOMException('Denied', 'NotAllowedError') }
   document.execCommand = () => { throw new Error('Unavailable') }
   try {
     const ok = await copyText('fallback')
     return { ok, focused: document.activeElement === area, start: area.selectionStart, end: area.selectionEnd, cleaned: document.querySelectorAll('textarea').length === count }
   } finally { navigator.clipboard.writeText = write; document.execCommand = exec }
 })
 assert.deepEqual(fallback, { ok: false, focused: true, start: 1, end: 4, cleaned: true })
 assert.deepEqual(p.consoleErrors, [])
 console.log('PASS native clipboard paste and message copy preserve exact text in granted Chrome session')
} finally { await browser.close() }
