// Confirmation steps must replace the current dialog body, never stack a second modal on top.
import assert from 'node:assert/strict'
import { Browser, sleep, enterRoom } from './browser.mjs'

const base = process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5188'
const browser = await Browser.launch()
const wait = async (page, fn, label) => {
  for (let i = 0; i < 200; i++) { if (await page.eval(fn)) return; await sleep(100) }
  throw Error(`Timed out: ${label}`)
}
const dialogs = (page) => page.eval(() => document.querySelectorAll('[role=dialog]').length)
const title = (page) => page.eval(() => document.querySelector('[role=dialog] h2')?.textContent ?? '')

try {
  const page = await browser.newPage({ width: 1440, height: 900 })
  await page.goto(base)
  await wait(page, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length > 0, 'entry')
  await enterRoom(page)
  await wait(page, () => !!document.querySelector('textarea'), 'room')

  // Settings -> close room confirmation.
  await page.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('管理')).click())
  await wait(page, () => document.querySelectorAll('[role=dialog]').length === 1, 'settings dialog')
  assert.equal(await title(page), '房间设置')
  await page.eval(() => [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === '关闭房间').click())
  await wait(page, () => (document.querySelector('[role=dialog] h2')?.textContent ?? '') === '关闭房间？', 'close confirm')
  assert.equal(await dialogs(page), 1, 'close confirmation stacked a second dialog')
  for (let i = 0; i < 30; i++) {
    if (await page.eval(() => document.activeElement?.textContent?.trim() === '取消')) break
    await sleep(50)
  }
  const forward = await page.eval(() => {
    const body = document.querySelector('[role=dialog] .anim-swap')
    const title = document.querySelector('[role=dialog] h2 .anim-title')
    return {
      dir: body?.getAttribute('data-dir'),
      name: body ? getComputedStyle(body).animationName : 'none',
      duration: body ? getComputedStyle(body).animationDuration : '',
      titleName: title ? getComputedStyle(title).animationName : 'none',
      focused: document.activeElement?.textContent?.trim() ?? '',
    }
  })
  assert.equal(forward.dir, 'forward', 'confirmation should animate forward')
  assert.equal(forward.name, 'wd-swap-forward', `forward swap animation: ${forward.name}`)
  assert.equal(forward.duration, '0.2s', `swap duration: ${forward.duration}`)
  assert.equal(forward.titleName, 'wd-fade', 'title should fade on change')
  assert.equal(forward.focused, '取消', `focus should move to the safe action, got ${forward.focused}`)
  assert.ok(await page.eval(() => document.body.innerText.includes('加入方式') === false), 'settings body still visible under the confirmation')
  await sleep(350)
  await page.screenshot({ path: '/tmp/opencode/dialog-confirm-close.png' })

  // Cancel returns to the settings body in the same dialog.
  await page.eval(() => [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === '取消').click())
  await wait(page, () => (document.querySelector('[role=dialog] h2')?.textContent ?? '') === '房间设置', 'back to settings')
  assert.equal(await dialogs(page), 1, 'cancel left an extra dialog')
  const back = await page.eval(() => {
    const body = document.querySelector('[role=dialog] .anim-swap')
    return { dir: body?.getAttribute('data-dir'), name: body ? getComputedStyle(body).animationName : 'none' }
  })
  assert.equal(back.dir, 'back', 'cancel should animate back')
  assert.equal(back.name, 'wd-swap-back', `back swap animation: ${back.name}`)

  // Kick confirmation inside the members panel.
  await page.eval(() => [...document.querySelectorAll('[role=dialog] button')].find(b => b.getAttribute('aria-label') === '关闭')?.click())
  await sleep(250)
  await page.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('成员')).click())
  await wait(page, () => (document.querySelector('[role=dialog] h2')?.textContent ?? '') === '成员', 'members dialog')
  const kickable = await page.eval(() => !!document.querySelector('[role=dialog] button.text-danger'))
  if (kickable) {
    await page.eval(() => document.querySelector('[role=dialog] button.text-danger').click())
    await wait(page, () => (document.querySelector('[role=dialog] h2')?.textContent ?? '').includes('移出'), 'kick confirm')
    assert.equal(await dialogs(page), 1, 'kick confirmation stacked a second dialog')
    await page.eval(() => [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === '取消').click())
    await wait(page, () => (document.querySelector('[role=dialog] h2')?.textContent ?? '') === '成员', 'back to members')
  }
  // Reduced motion keeps the step change legible but drops the horizontal travel.
  const reduced = await browser.newPage({ width: 1440, height: 900 })
  await reduced.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await reduced.goto(base)
  await wait(reduced, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length > 0, 'reduced entry')
  await enterRoom(reduced)
  await wait(reduced, () => !!document.querySelector('textarea'), 'reduced room')
  await reduced.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('管理')).click())
  await wait(reduced, () => (document.querySelector('[role=dialog] h2')?.textContent ?? '') === '房间设置', 'reduced settings')
  await reduced.eval(() => [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === '关闭房间').click())
  await wait(reduced, () => (document.querySelector('[role=dialog] h2')?.textContent ?? '') === '关闭房间？', 'reduced confirm')
  const swapped = await reduced.eval(() => {
    const body = document.querySelector('[role=dialog] .anim-swap')
    return { name: getComputedStyle(body).animationName, transform: getComputedStyle(body).transform }
  })
  assert.equal(swapped.name, 'wd-fade', `reduced swap should fade only, got ${swapped.name}`)
  assert.equal(swapped.transform, 'none', `reduced swap should not translate, got ${swapped.transform}`)
  assert.deepEqual(page.consoleErrors, [])
  console.log('PASS confirmations replace the open dialog instead of stacking a second modal; swap animates forward/back and reduces to a fade')
} finally { await browser.close() }
