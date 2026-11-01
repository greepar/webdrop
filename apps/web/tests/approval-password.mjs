// Password + approval, end to end against the real API.
// Owner: create with password + approvalRequired, then approve from the settings panel.
// Guest: wrong password is rejected, correct password yields a pending application, then auto-enters.
import assert from 'node:assert/strict'
import { Browser, sleep } from './browser.mjs'

const base = process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5188'
const ownerBrowser = await Browser.launch()
const guestBrowser = await Browser.launch()
const wait = async (page, fn, label) => {
  for (let i = 0; i < 240; i++) { if (await page.eval(fn)) return; await sleep(100) }
  throw Error(`Timed out: ${label}: ` + (await page.eval(() => document.body.innerText.slice(0, 200))))
}
const typeBoxes = (page, code) => page.eval((value) => {
  const inputs = [...document.querySelectorAll('[role=group][aria-label^="房间号"] input')]
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  inputs.forEach((input, index) => { setter.call(input, value[index] ?? ''); input.dispatchEvent(new Event('input', { bubbles: true })) })
}, code)
const setPassword = (page, selector, value) => page.eval(({ selector, value }) => {
  const el = document.querySelector(selector)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}, { selector, value })

try {
  // --- Owner creates a room with a password and approval required -------------------------------
  const owner = await ownerBrowser.newPage({ width: 390, height: 844, mobile: true })
  await owner.goto(base)
  await wait(owner, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length === 4, 'boxes')
  const code = String(Math.floor(Math.random() * 9000) + 1000)
  await typeBoxes(owner, code)
  // A non-existent code offers creation; open the panel and set both options.
  await wait(owner, () => !!document.querySelector('[data-create-room]'), 'create offer')
  await owner.eval(() => document.querySelector('[data-create-room]').click())
  await wait(owner, () => !!document.querySelector('input[type=password][autocomplete=new-password]'), 'create panel')
  await setPassword(owner, 'input[type=password][autocomplete=new-password]', 'open sesame')
  await owner.eval(() => document.querySelector('input[type=checkbox]').click())
  await owner.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '创建').click())
  await wait(owner, () => !!document.querySelector('textarea'), 'owner room')
  const roomPath = await owner.eval(() => location.pathname)
  console.log('owner created', code, roomPath)

  // Settings must reflect both flags.
  await owner.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('管理')).click())
  await wait(owner, () => (document.querySelector('[role=dialog] h2')?.textContent ?? '') === '房间设置', 'settings')
  const flags = await owner.eval(() => ({
    hasPassword: document.body.innerText.includes('已设置密码'),
    approval: [...document.querySelectorAll('[role=dialog] button[aria-pressed=true]')].map(b => b.textContent.trim()),
    requestsSection: document.body.innerText.includes('入房申请'),
  }))
  assert.equal(flags.hasPassword, true, 'settings should say the room has a password')
  assert.ok(flags.approval.includes('需要同意'), `approval toggle: ${flags.approval}`)
  assert.equal(flags.requestsSection, true, 'join request section should be visible')
  console.log('settings flags', JSON.stringify(flags))

  // --- Guest: wrong password ---------------------------------------------------------------
  const guest = await guestBrowser.newPage({ width: 390, height: 844, mobile: true })
  await guest.goto(base)
  await wait(guest, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length === 4, 'guest boxes')
  await typeBoxes(guest, code)
  await wait(guest, () => !!document.querySelector('input[type=password]'), 'password prompt')
  await setPassword(guest, 'input[type=password]', 'wrong password')
  await guest.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '加入').click())
  await wait(guest, () => document.body.innerText.includes('密码不正确'), 'wrong password message')
  assert.equal(await guest.eval(() => location.pathname), '/', 'wrong password must not enter the room')
  console.log('wrong password rejected')

  // --- Guest: correct password -> pending application -------------------------------------
  await setPassword(guest, 'input[type=password]', 'open sesame')
  await guest.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '加入').click())
  await wait(guest, () => document.body.innerText.includes('等待房主同意'), 'pending panel')
  assert.equal(await guest.eval(() => location.pathname), '/', 'pending applicant is not in the room yet')
  assert.equal(await guest.eval(() => !!document.querySelector('textarea')), false, 'pending applicant must not see the composer')
  console.log('pending application shown')

  // --- Owner approves from the settings panel ---------------------------------------------
  await wait(owner, () => document.body.innerText.includes('待处理') || document.body.innerText.includes('申请于'), 'request row')
  await owner.eval(() => [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === '同意').click())
  await wait(owner, () => document.body.innerText.includes('已同意加入'), 'approved notice')
  console.log('owner approved')

  // --- Guest polls the status and enters on its own ---------------------------------------
  await wait(guest, () => location.pathname !== '/', 'guest auto enter')
  await wait(guest, () => !!document.querySelector('textarea'), 'guest composer')
  assert.equal(await guest.eval(() => location.pathname), roomPath, 'guest should land in the same room')
  console.log('guest entered after approval:', await guest.eval(() => location.pathname))
  assert.deepEqual(guest.consoleErrors, [])
  console.log('PASS password + approval: wrong password rejected, pending shown, owner approval admits the guest automatically')
} finally { await ownerBrowser.close(); await guestBrowser.close() }
