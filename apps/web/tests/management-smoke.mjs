import assert from 'node:assert/strict'
import { Browser, sleep, enterRoom, joinRoom } from './browser.mjs'
const a = await Browser.launch(), b = await Browser.launch(), c = await Browser.launch()
const wait = async (page, fn) => { for (let i = 0; i < 150; i++) { if (await page.eval(fn)) return; await sleep(100) } throw Error(await page.eval(() => document.body.innerText.slice(0, 400))) }
const clickText = (page, text) => page.eval(text => [...document.querySelectorAll('button')].find(el => el.textContent.trim() === text)?.click(), text)
const openSettings = (page) => page.eval(() => document.querySelector('[aria-label="房间设置"]')?.click() ?? document.querySelector('[aria-label="房间设置，管理"]')?.click() ?? document.querySelector('button[aria-label="管理"]')?.click())
try {
  const p = await a.newPage({ width: 390, height: 844, mobile: true }), q = await b.newPage(), outsider = await c.newPage()
  const url = process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5191'
  await p.goto(url); await enterRoom(p); await wait(p, () => !!document.querySelector('textarea'))
  const code = await p.eval(() => document.querySelector('h1').lastElementChild.textContent.trim())
  await q.goto(url)
  await joinRoom(q, code)
  // Join rules now live behind switches: lock via the "允许新成员加入" switch.
  await p.eval(() => document.querySelector('[aria-label="房间设置"]')?.click() ?? [...document.querySelectorAll('button')].find(el => el.textContent.trim() === '管理')?.click())
  await wait(p, () => document.body.innerText.includes('入房规则'))
  await p.eval(() => document.querySelector('[role=switch][aria-label="允许新成员加入"]')?.click())
  await wait(p, () => document.querySelector('[role=switch][aria-label="允许新成员加入"]')?.getAttribute('aria-checked') === 'false')
  assert.equal(await q.eval(() => !!document.querySelector('textarea')), true)
  await outsider.goto(url)
  await outsider.eval(code => { document.querySelectorAll('[role=group] input').forEach((input, i) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, code[i] ?? ''); input.dispatchEvent(new Event('input', { bubbles: true })) }) }, code)
  await sleep(500)
  assert.equal(await outsider.eval(() => !!document.querySelector('[data-create-room]')), true)
  assert.equal(await outsider.eval(async () => (await (await fetch('/api/v1/session')).json()).data.memberships.length), 0)
  await clickText(p, '更换房间号')
  for (let i = 0; i < 100; i++) { if (await q.eval(code => document.querySelector('h1').lastElementChild.textContent.trim() !== code, code)) break; await sleep(100) }
  const newCode = await q.eval(() => document.querySelector('h1').lastElementChild.textContent.trim())
  assert.notEqual(newCode, code)
  assert.equal(await p.eval(() => document.querySelector('h1').lastElementChild.textContent.trim()), newCode)
  await p.eval(() => document.querySelector('[role=switch][aria-label="允许新成员加入"]')?.click())
  await wait(p, () => document.querySelector('[role=switch][aria-label="允许新成员加入"]')?.getAttribute('aria-checked') === 'true')
  await outsider.goto(url)
  await joinRoom(outsider, newCode)
  // Member leaves via the back dialog (role-aware), not the old members-panel button.
  await q.eval(() => document.querySelector('header button[aria-label^="返回选项"]')?.click())
  await wait(q, () => document.body.innerText.includes('回首页会保留房间'))
  await clickText(q, '离开房间'); await clickText(q, '确认')
  await wait(q, () => location.pathname === '/')
  assert.equal(await q.eval(async () => (await (await fetch('/api/v1/session')).json()).data.memberships.length), 0)
  await wait(outsider, () => [...document.querySelectorAll('button')].some(e => e.textContent.trim() === '成员 2'))
  await openSettings(p)
  await clickText(p, '关闭房间'); await clickText(p, '确认')
  await wait(outsider, () => document.body.innerText.includes('房间不可用'))
  assert.equal(await q.eval(() => !!document.querySelector('textarea')), false)
  assert.deepEqual(p.consoleErrors, []); assert.deepEqual(q.consoleErrors, []); assert.deepEqual(outsider.consoleErrors, [])
  console.log('PASS locked outsider rejected without membership, unlock admits, member leave syncs, rotation and close work')
} finally { await a.close(); await b.close(); await c.close() }
