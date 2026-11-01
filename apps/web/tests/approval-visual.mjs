// Visual + accessibility pass for the new states: password prompt, pending wait, owner settings.
import assert from 'node:assert/strict'
import { Browser, sleep } from './browser.mjs'

const base = process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5188'
const ob = await Browser.launch(), gb = await Browser.launch()
const wait = async (p, fn, l) => { for (let i = 0; i < 200; i++) { if (await p.eval(fn)) return; await sleep(100) } throw Error(`Timed out: ${l}`) }
const typeBoxes = (p, code) => p.eval((v) => {
  const inputs = [...document.querySelectorAll('[role=group][aria-label^="房间号"] input')]
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  inputs.forEach((el, i) => { setter.call(el, v[i] ?? ''); el.dispatchEvent(new Event('input', { bubbles: true })) })
}, code)
const shot = async (p, path) => p.screenshot({ path })

try {
  const owner = await ob.newPage({ width: 390, height: 844, mobile: true })
  await owner.goto(base)
  await wait(owner, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length === 4, 'boxes')
  const code = String(Math.floor(Math.random() * 9000) + 1000)
  await typeBoxes(owner, code)
  await wait(owner, () => !!document.querySelector('[data-create-room]'), 'offer')
  await owner.eval(() => document.querySelector('[data-create-room]').click())
  await wait(owner, () => !!document.querySelector('input[type=password][autocomplete=new-password]'), 'panel')
  await shot(owner, '/tmp/opencode/approval-create-light-390.png')
  await owner.eval(() => {
    const el = document.querySelector('input[type=password][autocomplete=new-password]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'pw')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await owner.eval(() => document.querySelector('input[type=checkbox]').click())
  await owner.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '创建').click())
  await wait(owner, () => !!document.querySelector('textarea'), 'owner room')
  await owner.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('管理')).click())
  await wait(owner, () => (document.querySelector('[role=dialog] h2')?.textContent ?? '') === '房间设置', 'settings')
  await sleep(450)
  await shot(owner, '/tmp/opencode/approval-settings-light-390.png')
  const a11y = await owner.eval(() => {
    const dialog = document.querySelector('[role=dialog]')
    const labelled = dialog?.getAttribute('aria-labelledby')
    const title = labelled ? document.getElementById(labelled)?.textContent : ''
    const focusables = [...dialog.querySelectorAll('button, input')].filter(el => el.getClientRects().length)
    const sizes = focusables.map(el => Math.round(el.getBoundingClientRect().height))
    return { title, focusables: focusables.length, minHeight: Math.min(...sizes), hasPasswordLabel: !!document.querySelector('label[for="room-password"]') }
  })
  assert.equal(a11y.title, '房间设置', 'dialog must be labelled')
  assert.ok(a11y.minHeight >= 36, `controls too small: ${a11y.minHeight}`)
  assert.equal(a11y.hasPasswordLabel, true, 'password field needs a label')
  console.log('settings a11y', JSON.stringify(a11y))

  // Dark desktop settings screenshot.
  const dark = await ob.newPage({ width: 1440, height: 900 })
  await dark.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await dark.goto(base + (await owner.eval(() => location.pathname)))
  await wait(dark, () => !!document.querySelector('textarea'), 'dark room')
  await dark.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('管理')).click())
  await wait(dark, () => (document.querySelector('[role=dialog] h2')?.textContent ?? '') === '房间设置', 'dark settings')
  const overflow = await dark.eval(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  assert.ok(overflow <= 0, `dark settings overflows by ${overflow}`)
  await sleep(450)
  await shot(dark, '/tmp/opencode/approval-settings-dark-1440.png')

  // Guest pending state, dark mobile + reduced motion.
  const guest = await gb.newPage({ width: 390, height: 844, mobile: true })
  await guest.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] })
  await guest.goto(base)
  await wait(guest, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length === 4, 'guest boxes')
  await typeBoxes(guest, code)
  await wait(guest, () => !!document.querySelector('input[type=password]'), 'password prompt')
  await shot(guest, '/tmp/opencode/approval-password-dark-390.png')
  await guest.eval(() => {
    const el = document.querySelector('input[type=password]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'pw')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await guest.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '加入').click())
  await wait(guest, () => document.body.innerText.includes('等待房主同意'), 'pending')
  const pending = await guest.eval(() => {
    const card = document.querySelector('section')
    const anim = card ? getComputedStyle(card).animationName : 'none'
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      animation: anim,
      hasLiveRegion: !!document.querySelector('[aria-live]'),
      text: card?.innerText.replace(/\n+/g, ' | ') ?? '',
    }
  })
  assert.ok(pending.overflow <= 0, `pending overflows by ${pending.overflow}`)
  assert.equal(pending.animation, 'wd-fade', `reduced motion should fade only, got ${pending.animation}`)
  assert.equal(pending.hasLiveRegion, true, 'pending state needs a live region')
  assert.ok(pending.text.includes('等待房主同意'))
  await shot(guest, '/tmp/opencode/approval-pending-dark-390.png')
  console.log('pending', JSON.stringify(pending))
  assert.deepEqual(guest.consoleErrors, [])
  console.log('PASS password prompt, pending wait and owner settings: labelled, sized, no overflow, reduced motion fades only')
} finally { await ob.close(); await gb.close() }
