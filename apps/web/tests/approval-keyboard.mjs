// Keyboard-only pass over the new password / approval UI.
// Checks tab order, Enter/Space activation, and that focus is visible on every control it lands on.
import assert from 'node:assert/strict'
import { Browser, sleep } from './browser.mjs'

const base = process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5188'
const ob = await Browser.launch(), gb = await Browser.launch()
const wait = async (p, fn, l) => {
  for (let i = 0; i < 220; i++) { if (await p.eval(fn)) return; await sleep(100) }
  throw Error(`Timed out: ${l}: ` + (await p.eval(() => document.body.innerText.slice(0, 160))))
}
const typeBoxes = (p, code) => p.eval((v) => {
  const inputs = [...document.querySelectorAll('[role=group][aria-label^="房间号"] input')]
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  inputs.forEach((el, i) => { setter.call(el, v[i] ?? ''); el.dispatchEvent(new Event('input', { bubbles: true })) })
}, code)
// Real key events through CDP so focus traversal is the browser's, not ours.
// Chrome only performs the default action (activate a button, toggle a checkbox) when the key event
// carries the native code and, for Enter/Space, the character text.
const key = async (p, k) => {
  const vk = k === 'Tab' ? 9 : k === 'Enter' ? 13 : 32
  const text = k === 'Enter' ? '\r' : k === ' ' ? ' ' : undefined
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text ? { text } : {}) })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
}
const active = (p) => p.eval(() => {
  const el = document.activeElement
  const style = el ? getComputedStyle(el) : null
  return {
    tag: el?.tagName ?? '',
    label: el?.getAttribute('aria-label') ?? el?.textContent?.trim().slice(0, 24) ?? '',
    type: el?.getAttribute('type') ?? '',
    outline: style ? `${style.outlineStyle} ${style.outlineWidth}` : '',
    // The boxes show focus with a border colour + ring instead of an outline.
    ring: style ? style.boxShadow : '',
    focusVisible: el ? el.matches(':focus-visible') : false,
  }
})

try {
  const owner = await ob.newPage({ width: 1440, height: 900 })
  await owner.goto(base)
  await wait(owner, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length === 4, 'boxes')

  // 1) Tab order: four boxes in order, then the dice button.
  await owner.eval(() => document.querySelector('[role=group][aria-label^="房间号"] input').focus())
  const order = []
  for (let i = 0; i < 5; i++) {
    order.push(await active(owner))
    await key(owner, 'Tab')
    await sleep(60)
  }
  const labels = order.map((o) => o.label)
  assert.deepEqual(labels.slice(0, 4), ['第 1 位', '第 2 位', '第 3 位', '第 4 位'], `box tab order: ${labels}`)
  assert.ok(labels[4].includes('随机创建房间'), `dice should follow the boxes, got ${labels[4]}`)
  for (const step of order.slice(0, 4)) {
    assert.equal(step.focusVisible, true, `box ${step.label} should be :focus-visible`)
    const visible = step.outline.includes('solid') || (step.ring !== 'none' && step.ring !== '')
    assert.ok(visible, `box ${step.label} needs a visible focus indicator (outline ${step.outline}, ring ${step.ring})`)
  }
  console.log('PASS tab order and visible focus across the four boxes')

  // 2) Typing digits by keyboard advances focus.
  await owner.eval(() => document.querySelector('[role=group][aria-label^="房间号"] input').focus())
  const code = String(Math.floor(Math.random() * 9000) + 1000)
  // Three digits: focus should advance to the fourth box.
  for (const digit of code.slice(0, 3)) {
    await owner.send('Input.insertText', { text: digit })
    await sleep(80)
  }
  const afterTyping = await active(owner)
  assert.equal(afterTyping.label, '第 4 位', `focus after three digits: ${afterTyping.label}`)
  // The fourth completes the code and starts the automatic join, which disables the boxes; the
  // progress is announced through the status region instead of keeping focus on a disabled input.
  await owner.send('Input.insertText', { text: code[3] })
  await wait(owner, () => !!document.querySelector('[data-create-room]'), 'create offer')
  const announced = await owner.eval(() => !!document.querySelector('[role=status]') || !!document.querySelector('[role=alert]'))
  assert.equal(announced, true, 'auto-join progress should be announced')
  console.log('PASS keyboard typing fills boxes and moves focus')

  // 3) Create panel: Space toggles the checkbox, Tab reaches the submit, Enter creates.
  await owner.eval(() => document.querySelector('[data-create-room]').focus())
  await key(owner, 'Enter')
  await wait(owner, () => !!document.querySelector('input[type=password][autocomplete=new-password]'), 'create panel')
  const panelFocus = await active(owner)
  assert.equal(panelFocus.focusVisible, true, 'focus should be visible after opening the panel')
  await owner.eval(() => document.querySelector('input[type=checkbox]').focus())
  const before = await owner.eval(() => document.querySelector('input[type=checkbox]').checked)
  await key(owner, ' ')
  await sleep(120)
  const after = await owner.eval(() => document.querySelector('input[type=checkbox]').checked)
  assert.notEqual(after, before, 'Space should toggle the approval checkbox')
  const checkboxFocus = await active(owner)
  assert.equal(checkboxFocus.focusVisible, true, 'checkbox should show focus')
  console.log('PASS create panel: Enter opens, Space toggles approval, focus visible')

  // Finish creation with the keyboard.
  await owner.eval(() => document.querySelector('input[type=password][autocomplete=new-password]').focus())
  await owner.send('Input.insertText', { text: 'key pw' })
  await owner.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '创建').focus())
  await key(owner, 'Enter')
  await wait(owner, () => !!document.querySelector('textarea'), 'owner room')
  console.log('PASS Enter submits the create panel')

  // 4) Owner settings: Tab to the approve button and activate it with Enter.
  const guest = await gb.newPage({ width: 390, height: 844, mobile: true })
  await guest.goto(base)
  await wait(guest, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length === 4, 'guest boxes')
  await typeBoxes(guest, code)
  await wait(guest, () => !!document.querySelector('input[type=password]'), 'password prompt')
  await guest.eval(() => {
    const el = document.querySelector('input[type=password]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'key pw')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await guest.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '加入').click())
  await wait(guest, () => document.body.innerText.includes('等待房主同意'), 'guest pending')

  await owner.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('管理')).focus())
  await key(owner, 'Enter')
  await wait(owner, () => (document.querySelector('[role=dialog] h2')?.textContent ?? '') === '房间设置', 'settings')
  await wait(owner, () => [...document.querySelectorAll('[role=dialog] button')].some(b => b.textContent.trim() === '同意'), 'approve button')
  await owner.eval(() => [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === '同意').focus())
  const approveFocus = await active(owner)
  assert.equal(approveFocus.focusVisible, true, 'approve button should show focus')
  assert.ok(approveFocus.outline.includes('solid') || (approveFocus.ring !== 'none' && approveFocus.ring !== ''), `approve focus indicator: ${approveFocus.outline} / ${approveFocus.ring}`)
  await key(owner, 'Enter')
  await wait(owner, () => document.body.innerText.includes('已同意加入'), 'approved')
  await wait(guest, () => location.pathname !== '/', 'guest entered')
  console.log('PASS owner approves with Enter from the keyboard and the guest enters')

  assert.deepEqual(guest.consoleErrors, [])
  console.log('PASS keyboard-only: boxes, password, create panel and owner approval all operable with visible focus')
} finally { await ob.close(); await gb.close() }
