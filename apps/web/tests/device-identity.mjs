import assert from 'node:assert/strict'
import { Browser, sleep } from './browser.mjs'
const browser = await Browser.launch()
const wait = async (page, fn) => {
  for (let i = 0; i < 100; i++) { if (await page.eval(fn)) return; await sleep(100) }
  throw Error(await page.eval(() => document.body.innerText))
}
try {
  const page = await browser.newPage()
  await page.goto(process.env.WEBDROP_TEST_URL)
  await wait(page, () => !!document.querySelector('[aria-label="当前设备"] button'))
  const initial = await page.eval(() => document.querySelector('[aria-label="当前设备"] span').textContent)
  assert.ok(initial && initial !== '本机')
  await page.eval(() => document.querySelector('[aria-label="当前设备"] button').click())
  await page.eval(() => {
    const input = document.querySelector('input[aria-label="设备名"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '我的笔记本')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.eval(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '保存').click())
  await wait(page, () => document.querySelector('[aria-label="当前设备"] span')?.textContent === '我的笔记本')
  await page.goto(process.env.WEBDROP_TEST_URL)
  await wait(page, () => document.querySelector('[aria-label="当前设备"] span')?.textContent === '我的笔记本')
  assert.deepEqual(page.consoleErrors, [])
  console.log('PASS device identity displays session name, updates after rename and survives reload')
} finally { await browser.close() }
