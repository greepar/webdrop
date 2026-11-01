import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { Browser, sleep } from './browser.mjs'
const browser = await Browser.launch()
const output = process.env.WEBDROP_SCREENSHOTS || '/tmp/webdrop-layout'
await mkdir(output, { recursive: true })
try {
  const page = await browser.newPage({ width: 390, height: 844, mobile: true })
  await page.goto(process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5173')
  await page.eval(() => document.querySelector('[aria-label="随机创建房间"]').click())
  for (let i = 0; i < 100; i++) { if (await page.eval(() => !!document.querySelector('textarea'))) break; await sleep(100) }
  assert.equal(await page.eval(() => !!document.querySelector('textarea')), true)
  await page.eval(() => {
    const files = new DataTransfer()
    files.items.add(new File(['layout'], '这是一个很长很长的文件名字-用于确认窄屏卡片不会横向溢出.txt', { type: 'text/plain' }))
    const input = document.querySelector('input[type=file]'); input.files = files.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await sleep(1500)
  for (const [width, height] of [[320, 740], [390, 844], [844, 390], [768, 1024], [1440, 900]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: width < 900, deviceScaleFactor: 1 })
    for (const theme of ['light', 'dark']) {
      await page.eval(theme => document.querySelector(`input[value=${theme}]`).click(), theme)
      await sleep(250)
      const overflow = await page.eval(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth, log: document.querySelector('[role=log]').scrollWidth, logWidth: document.querySelector('[role=log]').clientWidth }))
      const clipped = await page.eval(() => [...document.querySelectorAll('header button, header label, header h1')].filter(el => el.getClientRects().length).filter(el => { const rect = el.getBoundingClientRect(); return rect.left < 0 || rect.right > innerWidth || rect.width === 0 }).map(el => el.getAttribute('aria-label') || el.textContent))
      assert.deepEqual(clipped, [], `Clipped header at ${width} ${theme}`)
      await page.screenshot({ path: `${output}/room-${width}-${theme}.png` })
      assert.ok(overflow.page <= overflow.viewport && overflow.log <= overflow.logWidth, JSON.stringify({ width, theme, ...overflow }))
    }
  }
  console.log('PASS room layout at five viewports and both themes with long filename')
} finally { await browser.close() }
