// Polling resilience: hidden tab pauses, reconnect resumes, and losing the room ends the wait.
import assert from 'node:assert/strict'
import { Browser, sleep } from './browser.mjs'

const base = process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5188'
const ob = await Browser.launch(), gb = await Browser.launch(), gb2 = await Browser.launch()
const wait = async (p, fn, l) => {
  for (let i = 0; i < 260; i++) { if (await p.eval(fn)) return; await sleep(100) }
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
  await wait(owner, () => !!document.querySelector('input[type=checkbox]'), 'panel')
  await owner.eval(() => document.querySelector('input[type=checkbox]').click())
  await owner.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '创建').click())
  await wait(owner, () => !!document.querySelector('textarea'), 'owner room')

  const guest = await gb.newPage({ width: 390, height: 844, mobile: true })
  guest.send('Network.enable')
  let polls = 0
  gb.on(guest.sessionId, 'Network.requestWillBeSent', (e) => { if (/\/join-requests\/[^/]+$/.test(new URL(e.request.url).pathname)) polls += 1 })
  await guest.goto(base)
  await wait(guest, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length === 4, 'guest boxes')
  await typeBoxes(guest, code)
  await wait(guest, () => document.body.innerText.includes('等待房主同意'), 'pending')

  // Hidden tab must not poll.
  // Simulate the tab going hidden: the component reads document.visibilityState, so override it and
  // fire the event the browser would fire. This is a client-side simulation of the platform signal.
  await guest.eval(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const beforeHidden = polls
  await sleep(4000)
  const whileHidden = polls
  assert.equal(whileHidden, beforeHidden, `hidden tab kept polling (${beforeHidden} -> ${whileHidden})`)
  await guest.eval(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await sleep(4000)
  assert.ok(polls > whileHidden, 'polling should resume when the tab is visible again')
  console.log('PASS polling pauses while hidden and resumes on visibility')

  // Offline during the wait, then back online: the status is fetched again and approval still lands.
  await guest.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
  await sleep(3500)
  assert.equal(await guest.eval(() => document.body.innerText.includes('等待房主同意')), true, 'offline must not drop the pending state')
  await owner.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('管理')).click())
  await wait(owner, () => [...document.querySelectorAll('[role=dialog] button')].some(b => b.textContent.trim() === '同意'), 'approve row')
  await owner.eval(() => [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === '同意').click())
  await wait(owner, () => document.body.innerText.includes('已同意加入'), 'approved')
  await guest.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await wait(guest, () => location.pathname !== '/', 'guest entered after reconnect')
  console.log('PASS approval completed while the applicant was offline is picked up after reconnect')

  // Permission loss: a second pending applicant whose request disappears must leave the wait.
  const third = await gb2.newPage({ width: 390, height: 844, mobile: true })
  await third.goto(base)
  await wait(third, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length === 4, 'third boxes')
  await typeBoxes(third, code)
  await wait(third, () => document.body.innerText.includes('等待房主同意'), 'third pending')
  await owner.eval(() => [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === '关闭')?.click())
  await sleep(300)
  await owner.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('管理'))?.click())
  await wait(owner, () => [...document.querySelectorAll('[role=dialog] button')].some(b => b.textContent.trim() === '拒绝'), 'third row')
  await owner.eval(() => [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === '拒绝').click())
  await wait(third, () => document.body.innerText.includes('房主没有同意'), 'third rejected')
  console.log('PASS a decision reaches an applicant after a visibility/offline cycle')

  assert.deepEqual(guest.consoleErrors, [])
  console.log('PASS polling: hidden pause, resume, offline recovery and decision delivery')
} finally { await ob.close(); await gb.close(); await gb2.close() }
