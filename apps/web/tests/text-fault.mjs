import assert from 'node:assert/strict'
import { Browser, sleep } from './browser.mjs'
const browser = await Browser.launch()
const wait = async (p, fn) => { for (let i = 0; i < 100; i++) { if (await p.eval(fn)) return; await sleep(100) } throw Error(await p.eval(() => document.body.innerText)) }
try {
  const page = await browser.newPage()
  await page.goto(process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5190')
  await page.eval(() => document.querySelector('[aria-label="随机创建房间"]').click())
  await wait(page, () => !!document.querySelector('textarea'))
  let dropped = false
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/rooms/*/items', requestStage: 'Response' }] })
  browser.on(page.sessionId, 'Fetch.requestPaused', async event => {
    if (event.request.method === 'POST' && !dropped) {
      dropped = true
      await page.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'ConnectionReset' })
    } else await page.send('Fetch.continueRequest', { requestId: event.requestId })
  })
  await page.eval(() => {
    const area = document.querySelector('textarea')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, '重试不重复')
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await sleep(80)
  await page.eval(() => document.querySelector('[aria-label="发送"]').click())
  await wait(page, () => document.body.innerText.includes('发送失败'))
  await page.eval(() => document.querySelector('[aria-label="发送"]').click())
  await wait(page, () => document.querySelector('textarea').value === '')
  assert.equal(await page.eval(() => document.querySelectorAll('[role=log] article').length), 1)
  const count = await page.eval(async () => (await (await fetch(`/api/v1/rooms/${location.pathname.split('/').at(-1)}/items`)).json()).data.length)
  assert.equal(count, 1)
  console.log('PASS lost text response retries without duplicate server or UI message')
} finally { await browser.close() }
