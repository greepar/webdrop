import assert from 'node:assert/strict'
import { Browser, sleep, enterRoom } from './browser.mjs'

const browser = await Browser.launch()
const wait = async (page, predicate) => {
  for (let i = 0; i < 150; i++) {
    if (await page.eval(predicate)) return
    await sleep(100)
  }
  throw Error(await page.eval(() => document.body.innerText.slice(0, 500)))
}
try {
  const page = await browser.newPage()
  await page.goto(process.env.WEBDROP_TEST_URL)
  await enterRoom(page)
  await wait(page, () => !!document.querySelector('textarea'))
  await page.eval(() => {
    const input = document.querySelector('input[type=file]')
    const transfer = new DataTransfer()
    transfer.items.add(new File(['CORS bytes 中文'], 'cors-upload.txt', { type: 'text/plain' }))
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await wait(page, () => !!document.querySelector('[aria-label="预览 cors-upload.txt"]:not(:disabled)'))
  await page.eval(() => document.querySelector('[aria-label="预览 cors-upload.txt"]:not(:disabled)').click())
  await wait(page, () => !!document.querySelector('a[download="cors-upload.txt"]'))
  const result = await page.eval(async () => {
    const url = document.querySelector('a[download="cors-upload.txt"]').href
    const response = await fetch(url, { credentials: 'include' })
    const range = await fetch(url, { credentials: 'include', headers: { Range: 'bytes=0-3' } })
    return {
      crossOrigin: new URL(url).origin !== location.origin,
      status: response.status, text: await response.text(), rangeStatus: range.status,
      range: range.headers.get('Content-Range'), rangeText: await range.text(),
    }
  })
  assert.deepEqual(result, {
    crossOrigin: true, status: 200, text: 'CORS bytes 中文', rangeStatus: 206,
    range: `bytes 0-3/${Buffer.byteLength('CORS bytes 中文')}`, rangeText: 'CORS',
  })
  assert.deepEqual(page.consoleErrors, [])
  console.log('PASS CORS session/room/SSE/upload/private download/Range and exposed headers')
} finally { await browser.close() }
