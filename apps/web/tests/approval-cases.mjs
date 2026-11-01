// Rejection, applicant cancel, locked-room precedence and owner toggling approval off.
import assert from 'node:assert/strict'
import { Browser, sleep } from './browser.mjs'

const base = process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5188'
const ob = await Browser.launch(), gb = await Browser.launch(), gb2 = await Browser.launch()
const wait = async (p, fn, l) => { for (let i = 0; i < 200; i++) { if (await p.eval(fn)) return; await sleep(100) } throw Error(`Timed out: ${l}: ` + (await p.eval(() => document.body.innerText.slice(0, 160)))) }
const typeBoxes = (p, code) => p.eval((v) => {
  const inputs = [...document.querySelectorAll('[role=group][aria-label^="房间号"] input')]
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  inputs.forEach((el, i) => { setter.call(el, v[i] ?? ''); el.dispatchEvent(new Event('input', { bubbles: true })) })
}, code)
const openSettings = async (p) => {
  await p.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('管理')).click())
  await wait(p, () => (document.querySelector('[role=dialog] h2')?.textContent ?? '') === '房间设置', 'settings')
}
const click = (p, text) => p.eval((t) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t).click(), text)

try {
  const owner = await ob.newPage({ width: 390, height: 844, mobile: true })
  await owner.goto(base)
  await wait(owner, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length === 4, 'boxes')
  const code = String(Math.floor(Math.random() * 9000) + 1000)
  await typeBoxes(owner, code)
  await wait(owner, () => !!document.querySelector('[data-create-room]'), 'offer')
  await owner.eval(() => document.querySelector('[data-create-room]').click())
  await wait(owner, () => !!document.querySelector('input[type=checkbox]'), 'create panel')
  await owner.eval(() => document.querySelector('input[type=checkbox]').click())
  await click(owner, '创建')
  await wait(owner, () => !!document.querySelector('textarea'), 'owner room')

  // Guest 1 applies and is rejected.
  const g1 = await gb.newPage({ width: 390, height: 844, mobile: true })
  await g1.goto(base)
  await wait(g1, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length === 4, 'g1 boxes')
  await typeBoxes(g1, code)
  await wait(g1, () => document.body.innerText.includes('等待房主同意'), 'g1 pending')
  await openSettings(owner)
  await wait(owner, () => !!document.querySelector('[role=dialog] button.text-xs'), 'request row')
  await click(owner, '拒绝')
  await wait(owner, () => document.body.innerText.includes('已拒绝申请'), 'rejected notice')
  await wait(g1, () => document.body.innerText.includes('房主没有同意'), 'g1 rejected')
  assert.equal(await g1.eval(() => location.pathname), '/', 'rejected applicant stays out')
  console.log('PASS rejection reaches the applicant')

  // Guest 2 applies then cancels locally; the room must not be entered.
  const g2 = await gb.newPage({ width: 390, height: 844, mobile: true })
  await g2.goto(base)
  await wait(g2, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length === 4, 'g2 boxes')
  await typeBoxes(g2, code)
  await wait(g2, () => document.body.innerText.includes('等待房主同意'), 'g2 pending')
  await click(g2, '取消申请')
  await wait(g2, () => !!document.querySelector('[role=group][aria-label^="房间号"] input'), 'back to form')
  assert.equal(await g2.eval(() => location.pathname), '/', 'cancel keeps the applicant out')
  console.log('PASS applicant can cancel the wait')

  // Owner turns approval off; a new guest joins directly.
  await owner.eval(() => [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === '直接加入').click())
  await wait(owner, () => document.body.innerText.includes('已关闭入房审批'), 'approval off')
  const g3 = await gb.newPage({ width: 390, height: 844, mobile: true })
  await g3.goto(base)
  await wait(g3, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length === 4, 'g3 boxes')
  await typeBoxes(g3, code)
  await wait(g3, () => !!document.querySelector('textarea'), 'g3 direct join')
  console.log('PASS approval off lets a new guest join directly')

  // Locked room wins over approval: a new guest is refused.
  await owner.eval(() => [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === '锁定').click())
  await wait(owner, () => document.body.innerText.includes('已锁定加入'), 'locked')
  const g4 = await gb2.newPage({ width: 390, height: 844, mobile: true })
  await g4.goto(base)
  await wait(g4, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length === 4, 'g4 boxes')
  await typeBoxes(g4, code)
  await wait(g4, () => document.body.innerText.includes('这个号码暂时进不去'), 'g4 unavailable')
  assert.equal(await g4.eval(() => document.body.innerText.includes('等待房主同意')), false, 'locked room must not create a pending application')
  console.log('PASS locked room refuses before approval')

  assert.deepEqual(g3.consoleErrors, [])
  console.log('PASS approval cases: reject, cancel, toggle off, locked precedence')
} finally { await ob.close(); await gb.close(); await gb2.close() }
