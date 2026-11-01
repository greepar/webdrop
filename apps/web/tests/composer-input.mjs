import assert from 'node:assert/strict'
import { Browser, sleep } from './browser.mjs'
const browser = await Browser.launch()
try {
  const page = await browser.newPage()
  await page.goto(process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5191')
  await page.eval(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js')
    const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js')
    const { Composer } = await import('/src/features/room/Composer.tsx')
    const host = document.createElement('div'); host.id = 'composer-test'; document.body.append(host)
    window.__sent = []; window.__resolve = null
    createRoot(host).render(React.createElement(Composer, { disabled: false, onPickFiles() {}, onSend: text => { window.__sent.push(text); return new Promise(resolve => { window.__resolve = resolve }) } }))
  })
  await sleep(100)
  const fill = async text => {
    await page.eval(text => {
      const area = document.querySelector('#composer-test textarea')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, text)
      area.dispatchEvent(new Event('input', { bubbles: true }))
    }, text)
    await sleep(50)
  }
  await fill('  缩进文字\n下一行\n')
  await page.eval(() => {
    const area = document.querySelector('#composer-test textarea')
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
  })
  assert.deepEqual(await page.eval(() => window.__sent), [])
  await page.eval(() => {
    const form = document.querySelector('#composer-test form')
    form.requestSubmit(); form.requestSubmit()
  })
  assert.deepEqual(await page.eval(() => window.__sent), ['  缩进文字\n下一行\n'])
  await fill('等待时写的新草稿')
  await page.eval(() => window.__resolve(true))
  await sleep(100)
  assert.equal(await page.eval(() => document.querySelector('#composer-test textarea').value), '等待时写的新草稿')
  await page.eval(() => document.querySelector('#composer-test form').requestSubmit())
  await page.eval(() => window.__resolve(false))
  await sleep(100)
  assert.equal(await page.eval(() => document.querySelector('#composer-test textarea').value), '等待时写的新草稿')
  await fill('前后')
  await page.eval(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => ' 中间\n' } })
    document.querySelector('#composer-test textarea').setSelectionRange(1, 1)
    ;[...document.querySelectorAll('#composer-test button')].find(e => e.textContent.trim() === '粘贴文字').click()
  })
  await sleep(100)
  assert.equal(await page.eval(() => document.querySelector('#composer-test textarea').value), '前 中间\n后')
  await page.eval(() => {
    navigator.clipboard.readText = async () => { throw new DOMException('Denied', 'NotAllowedError') }
    ;[...document.querySelectorAll('#composer-test button')].find(e => e.textContent.trim() === '粘贴文字').click()
  })
  await sleep(100)
  assert.equal(await page.eval(() => document.querySelector('#composer-test').innerText.includes('手动粘贴')), true)
  assert.equal(await page.eval(() => document.querySelector('#composer-test textarea').value), '前 中间\n后')
  assert.deepEqual(page.consoleErrors, [])
  console.log('PASS whitespace preserved, IME/Shift Enter do not send, duplicate submit blocked, new and failed drafts retained; active paste inserts at cursor and denied permission preserves text')
} finally { await browser.close() }
