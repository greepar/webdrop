import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Browser, sleep, enterRoom } from './browser.mjs'
const browser = await Browser.launch()
const wait = async (page, fn) => {
  for (let i = 0; i < 100; i++) { if (await page.eval(fn)) return; await sleep(100) }
  throw Error('Timed out: ' + await page.eval(() => document.body.innerText))
}
try {
  const page = await browser.newPage({ width: 390, height: 844, mobile: true })
  await page.goto(process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5190')
  await enterRoom(page)
  await wait(page, () => !!document.querySelector('textarea'))
  const video = (await readFile(new URL('./fixtures/preview.mp4', import.meta.url))).toString('base64')
  await page.eval(video => {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64
    canvas.getContext('2d').fillRect(0, 0, 64, 64)
    const png = atob(canvas.toDataURL('image/png').split(',')[1])
    const files = new DataTransfer()
    files.items.add(new File([Uint8Array.from(png, c => c.charCodeAt(0))], 'preview.png', { type: 'image/png' }))
    files.items.add(new File([Uint8Array.from(atob(video), c => c.charCodeAt(0))], 'preview.mp4', { type: 'video/mp4' }))
    const input = document.querySelector('input[type=file]'); input.files = files.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, video)
  await wait(page, () => !!document.querySelector('[aria-label="预览 preview.mp4"]') && !document.querySelector('[aria-label="上传队列"]'))
  await page.eval(() => document.querySelector('[aria-label="预览 preview.png"]').click())
  await wait(page, () => document.querySelector('[role=dialog] img')?.naturalWidth === 64)
  await page.eval(() => document.querySelector('[role=dialog] [aria-label="关闭"]').click())
  await wait(page, () => !document.querySelector('[role=dialog]'))
  await page.eval(() => document.querySelector('[aria-label="预览 preview.mp4"]').click())
  await wait(page, () => document.querySelector('video')?.videoWidth === 64)
  await page.eval(async () => { const video = document.querySelector('video'); video.muted = true; await video.play() })
  await wait(page, () => document.querySelector('video')?.currentTime > 0.1)
  await page.eval(() => document.querySelector('[role=dialog] [aria-label="关闭"]').click())
  await wait(page, () => !document.querySelector('[role=dialog]'))
  await page.send('Network.enable')
  await page.send('Network.setCacheDisabled', { cacheDisabled: true })
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/assets/*/content', requestStage: 'Request' }] })
  browser.on(page.sessionId, 'Fetch.requestPaused', event => page.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 410, body: '' }))
  await page.eval(() => document.querySelector('[aria-label="预览 preview.png"]').click())
  await wait(page, () => document.querySelector('[role=dialog]')?.innerText.includes('无法预览'))
  assert.equal(await page.eval(() => !!document.querySelector('[role=dialog] a[download]')), true)
  assert.equal(await page.eval(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.deepEqual(page.consoleErrors, [])
  console.log('PASS actual PNG decode, MP4 playback progress, expired preview fallback with download action')
} finally { await browser.close() }
