// Checks that only a newly arrived tail message fades in, and that history pagination does not animate.
// Runs against a live API + frontend (isolated runner) because it needs real SSE delivery.
import assert from 'node:assert/strict'
import { Browser, sleep, enterRoom } from './browser.mjs'

const browser = await Browser.launch()
const wait = async (page, fn, label = 'condition') => {
  for (let i = 0; i < 120; i++) {
    if (await page.eval(fn)) return
    await sleep(100)
  }
  throw Error(`Timed out waiting for ${label}: ` + (await page.eval(() => document.body.innerText)))
}

try {
  const page = await browser.newPage({ width: 390, height: 844, mobile: true })
  await page.goto(process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5188')
  await enterRoom(page)
  await wait(page, () => !!document.querySelector('textarea'), 'room composer')

  // Seed 31 messages so the newest page holds 30 and one older page exists.
  await page.eval(async () => {
    const session = (await (await fetch('/api/v1/session')).json()).data
    const room = location.pathname.split('/').at(-1)
    for (let i = 0; i < 31; i++) {
      const response = await fetch(`/api/v1/rooms/${room}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ text: `动效检查 ${i}` }),
      })
      if (!response.ok) throw Error(`Seed failed ${response.status}`)
    }
  })

  const url = await page.eval(() => location.href)
  await page.goto(url)
  await wait(page, () => document.querySelectorAll('[role=log] article').length === 30, 'snapshot 30 messages')

  const initial = await page.eval(() => [...document.querySelectorAll('[role=log] article')].map(el => getComputedStyle(el.parentElement).animationName))
  assert.ok(initial.every(name => name === 'none'), `snapshot messages must not animate, got ${initial.slice(0, 3)}`)

  // Older history prepends without animating (scrolling to the top triggers the same loader as the button).
  await page.eval(() => { document.querySelector('[role=log]').scrollTop = 0 })
  await wait(page, () => document.querySelectorAll('[role=log] article').length === 31, 'older page')
  await sleep(300)
  const history = await page.eval(() => {
    const row = [...document.querySelectorAll('[role=log] article')].find(el => el.innerText.includes('动效检查 0'))
    return row ? getComputedStyle(row.parentElement).animationName : 'missing'
  })
  assert.equal(history, 'none', `history item must not animate, got ${history}`)

  // A live message arrives over SSE and fades in.
  await page.eval(async () => {
    const session = (await (await fetch('/api/v1/session')).json()).data
    const room = location.pathname.split('/').at(-1)
    const response = await fetch(`/api/v1/rooms/${room}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ text: '新消息应当淡入' }),
    })
    if (!response.ok) throw Error(`Live send failed ${response.status}`)
  })
  await wait(page, () => document.body.innerText.includes('新消息应当淡入'), 'live message')
  const live = await page.eval(() => {
    const row = [...document.querySelectorAll('[role=log] article')].find(el => el.innerText.includes('新消息应当淡入'))
    const style = getComputedStyle(row.parentElement)
    return { name: style.animationName, duration: style.animationDuration }
  })
  assert.equal(live.name, 'wd-fade', `new message should fade, got ${live.name}`)
  assert.equal(live.duration, '0.12s', `new message fade should be 120ms, got ${live.duration}`)

  assert.deepEqual(page.consoleErrors, [])
  console.log('PASS only the new tail message fades (120ms) and history stays static')
} finally {
  await browser.close()
}
