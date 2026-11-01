// Duplicate-submit guard: double activation must produce exactly one join request and one decision.
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

try {
  const owner = await ob.newPage({ width: 390, height: 844, mobile: true })
  await owner.goto(base)
  await wait(owner, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length === 4, 'boxes')
  const code = String(Math.floor(Math.random() * 9000) + 1000)
  await typeBoxes(owner, code)
  await wait(owner, () => !!document.querySelector('[data-create-room]'), 'offer')
  await owner.eval(() => document.querySelector('[data-create-room]').click())
  await wait(owner, () => !!document.querySelector('input[type=password][autocomplete=new-password]'), 'panel')
  await owner.eval(() => {
    const el = document.querySelector('input[type=password][autocomplete=new-password]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'pw')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await owner.eval(() => document.querySelector('input[type=checkbox]').click())
  await owner.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '创建').click())
  await wait(owner, () => !!document.querySelector('textarea'), 'owner room')

  // Count join requests for the applicant.
  const guest = await gb.newPage({ width: 390, height: 844, mobile: true })
  guest.send('Network.enable')
  let joins = 0
  gb.on(guest.sessionId, 'Network.requestWillBeSent', (e) => { if (e.request.url.endsWith('/api/v1/rooms/join')) joins += 1 })
  await guest.goto(base)
  await wait(guest, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length === 4, 'guest boxes')
  await typeBoxes(guest, code)
  await wait(guest, () => !!document.querySelector('input[type=password]'), 'password prompt')
  await guest.eval(() => {
    const el = document.querySelector('input[type=password]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'pw')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // Reset the counter: the automatic join attempt (no password) already sent one request.
  joins = 0
  // Two activations in the same tick, before the first request settles.
  await guest.eval(() => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '加入')
    button.click()
    button.click()
  })
  await wait(guest, () => document.body.innerText.includes('等待房主同意'), 'pending')
  await sleep(800)
  const joinsAfterDoubleClick = joins
  assert.equal(joinsAfterDoubleClick, 1, `double-click should send one join request, sent ${joinsAfterDoubleClick}`)
  console.log('PASS double-clicking 加入 sends one join request')

  // Owner: double-click 同意, then verify the guest list has exactly one extra member.
  await owner.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('管理')).click())
  await wait(owner, () => (document.querySelector('[role=dialog] h2')?.textContent ?? '') === '房间设置', 'settings')
  await wait(owner, () => [...document.querySelectorAll('[role=dialog] button')].some(b => b.textContent.trim() === '同意'), 'approve row')
  owner.send('Network.enable')
  let decisions = 0
  ob.on(owner.sessionId, 'Network.requestWillBeSent', (e) => { if (e.request.url.endsWith('/approve')) decisions += 1 })
  await owner.eval(() => {
    const button = [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === '同意')
    button.click()
    button.click()
  })
  await wait(owner, () => document.body.innerText.includes('已同意加入'), 'approved')
  await wait(guest, () => location.pathname !== '/', 'guest entered')
  await sleep(800)
  assert.equal(decisions, 1, `double-click should send one approve request, sent ${decisions}`)
  const members = await owner.eval(async () => {
    const room = location.pathname.split('/').at(-1)
    const data = await (await fetch(`/api/v1/rooms/${room}/members`)).json()
    return data.data.length
  })
  assert.equal(members, 2, `room should have exactly 2 members, got ${members}`)
  console.log('PASS double-clicking 同意 sends one decision and adds one member')

  assert.deepEqual(guest.consoleErrors, [])
  console.log('PASS duplicate submit: one join request, one approval, one new member')
} finally { await ob.close(); await gb.close() }
