import assert from 'node:assert/strict'
import { Browser, sleep, enterRoom } from './browser.mjs'
const wait = async (page, fn, label) => { for (let i = 0; i < 150; i++) { if (await page.eval(fn)) return; await sleep(100) } throw Error(`${label}: ` + await page.eval(() => document.body.innerText.slice(0, 400))) }
const browser = await Browser.launch()
try {
  const page = await browser.newPage({ width: 1280, height: 800 })
  const url = process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5191'
  await page.goto(url)
  await enterRoom(page)
  await wait(page, () => !!document.querySelector('textarea'), 'room')
  // Send text, then copy via the message button.
  await page.eval(() => {
    const area = document.querySelector('textarea')
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(area, 'copy me')
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.eval(() => document.querySelector('[aria-label="发送"]')?.click())
  await wait(page, () => (document.querySelector('[role=log]')?.innerText ?? '').includes('copy me'), 'sent')
  // Grant clipboard permissions for the headless page.
  await page.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] })
  const btn = await page.eval(() => {
    const b = document.querySelector('[aria-label="复制文字"]')
    b?.scrollIntoView({ block: 'center' })
    return !!b
  })
  assert.ok(btn, 'copy button exists')
  const beforeTop = await page.eval(() => document.querySelector('[role=log]').getBoundingClientRect().top)
  await page.eval(() => document.querySelector('[aria-label="复制文字"]')?.click())
  await wait(page, () => !!document.querySelector('[aria-label="已复制"]'), 'check state')
  // No top notice for success.
  assert.ok(!(await page.eval(() => document.body.innerText.includes('图片已复制') || /已复制\n/.test(document.body.innerText))), 'no global success notice')
  // Button keeps its box: no layout shift in the action row.
  const box = await page.eval(() => {
    const b = document.querySelector('[aria-label="已复制"]')
    const r = b?.getBoundingClientRect()
    return r ? { w: r.width, h: r.height } : null
  })
  assert.ok(box && Math.abs(box.w - 36) < 2 && Math.abs(box.h - 36) < 2, `button keeps size, got ${JSON.stringify(box)}`)
  // Crossfade uses opacity only; check computed transition properties.
  const transition = await page.eval(() => getComputedStyle(document.querySelector('[aria-label="已复制"]')?.parentElement).transitionProperty)
  assert.ok(!transition.includes('all'), `no transition: all, got ${transition}`)
  // Flips back after ~2s.
  await sleep(2300)
  await wait(page, () => !!document.querySelector('[aria-label="复制文字"]'), 'back to copy')
  const afterTop = await page.eval(() => document.querySelector('[role=log]').getBoundingClientRect().top)
  assert.ok(Math.abs(afterTop - beforeTop) < 2, 'no content jump across copy states')
  assert.deepEqual(page.consoleErrors, [])
  console.log('PASS copy button flips to check in place with animation')
} finally { await browser.close() }
