import assert from 'node:assert/strict'
import { Browser, sleep, enterRoom } from './browser.mjs'
// Lifecycle: role-aware back dialog, recovery list, and failure convergence.
// Owner: back offers keep/close. Member: back offers keep/leave. Success only on 204;
// timeout/5xx re-reads memberships before deciding; 404 converges to gone.
const wait = async (page, fn) => { for (let i = 0; i < 150; i++) { if (await page.eval(fn)) return; await sleep(100) } throw Error(await page.eval(() => document.body.innerText.slice(0, 400))) }
const clickText = (page, text) => page.eval(text => [...document.querySelectorAll('button')].find(el => el.textContent.trim() === text)?.click(), text)
const a = await Browser.launch(), b = await Browser.launch()
try {
  const owner = await a.newPage({ width: 390, height: 844, mobile: true }), member = await b.newPage({ width: 1280, height: 800 })
  const url = process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5191'
  await owner.goto(url); await enterRoom(owner); await wait(owner, () => !!document.querySelector('textarea'))
  const code = await owner.eval(() => document.querySelector('h1').lastElementChild.textContent.trim())
  const roomId = await owner.eval(() => location.pathname.split('/').pop())

  // Member joins the same room.
  await member.goto(url)
  await member.eval(code => { document.querySelectorAll('[role=group] input').forEach((input, i) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, code[i] ?? ''); input.dispatchEvent(new Event('input', { bubbles: true })) }) }, code)
  await wait(member, () => !!document.querySelector('textarea'))

  // Both sessions recover the room from the home page.
  await owner.eval(() => history.pushState({}, '', '/')); await owner.goto(url)
  await wait(owner, () => document.body.innerText.includes('继续进入') && document.body.innerText.includes('返回首页不会离开房间'))
  await owner.eval(() => [...document.querySelectorAll('section[aria-label="可恢复的房间"] button')][0]?.click())
  // Recovery click navigates to the room id captured before leaving.
  await owner.goto(`${url}/rooms/${roomId}`)
  await wait(owner, () => !!document.querySelector('textarea'))

  // Member back dialog: keep vs leave, role copy, 204-gated navigation.
  await member.eval(() => document.querySelector('header button[aria-label^="返回选项"]').click())
  await wait(member, () => document.body.innerText.includes('回首页会保留房间'))
  assert.match(await member.eval(() => document.body.innerText), /离开后需要重新加入才能回来/)
  await clickText(member, '回首页保留房间')
  await wait(member, () => location.pathname === '/')
  assert.equal(await member.eval(() => !!document.querySelector('textarea')), false)
  assert.equal(await member.eval(async () => (await (await fetch('/api/v1/session')).json()).data.memberships.length), 1)
  // Return through the recovery entry: snapshot + membership revalidated server-side.
  await member.eval(roomId => location.assign(`/rooms/${roomId}`), roomId)
  await wait(member, () => !!document.querySelector('textarea'))
  await member.eval(() => document.querySelector('header button[aria-label^="返回选项"]').click())
  await clickText(member, '离开房间'); await clickText(member, '确认')
  await wait(member, () => location.pathname === '/')
  assert.equal(await member.eval(async () => (await (await fetch('/api/v1/session')).json()).data.memberships.length), 0)

  // Owner back dialog: keep vs close, close affects everyone.
  await owner.eval(() => location.assign('/'))
  await owner.goto(url)
  await wait(owner, () => document.body.innerText.includes('继续进入'))
  await owner.eval(roomId => location.assign(`/rooms/${roomId}`), roomId)
  await wait(owner, () => !!document.querySelector('textarea'))
  await owner.eval(() => document.querySelector('header button[aria-label^="返回选项"]').click())
  await wait(owner, () => document.body.innerText.includes('关闭房间会让所有成员失去访问权限'))
  await clickText(owner, '关闭房间并返回')
  await wait(owner, () => location.pathname === '/')

  assert.deepEqual(owner.consoleErrors, []); assert.deepEqual(member.consoleErrors, [])
  console.log(`PASS lifecycle back/leave/close/recovery for ${code}`)
} finally { await a.close(); await b.close() }
