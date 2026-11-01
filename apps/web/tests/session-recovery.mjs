import assert from 'node:assert/strict'
import { Browser, sleep } from './browser.mjs'
const browser = await Browser.launch()
try {
  const page = await browser.newPage()
  let allowRecovery = false
  let restored = false
  await page.send('Network.enable')
  browser.on(page.sessionId, 'Network.responseReceived', event => {
    if (new URL(event.response.url).pathname.startsWith('/api/')) console.log('HTTP', event.response.status, new URL(event.response.url).pathname)
    if (new URL(event.response.url).pathname === '/api/v1/session' && event.response.status === 200) restored = true
  })
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/v1/session', requestStage: 'Request' }] })
  browser.on(page.sessionId, 'Fetch.requestPaused', async event => {
    if (!allowRecovery) {
      await page.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 503, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'test outage' } })).toString('base64') })
    } else await page.send('Fetch.continueRequest', { requestId: event.requestId })
  })
  await page.goto(process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5188')
  for (let i = 0; i < 100; i++) {
    if (await page.eval(() => document.body.innerText.includes('重新连接'))) break
    await sleep(100)
  }
  assert.equal(await page.eval(() => document.body.innerText.includes('重新连接')), true, await page.eval(() => document.body.innerText))
  allowRecovery = true
  await page.eval(() => [...document.querySelectorAll('button')].find(el => el.textContent === '重新连接').click())
  for (let i = 0; i < 100; i++) {
    if (restored) break
    await sleep(100)
  }
  assert.equal(restored, true, 'Session must actually return 200 after retry: ' + await page.eval(() => document.body.innerText))
  assert.equal(await page.eval(() => document.body.innerText.includes('重新连接')), false)
  assert.deepEqual(page.consoleErrors, [])
  console.log('PASS session failure has retry action and recovers without refresh')
} finally { await browser.close() }
