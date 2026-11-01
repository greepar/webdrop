import assert from 'node:assert/strict'
import { Browser, sleep } from './browser.mjs'
const browser = await Browser.launch()
const wait = async (page, fn) => {
  for (let i = 0; i < 100; i++) { if (await page.eval(fn)) return; await sleep(100) }
  throw Error('Timed out: ' + await page.eval(() => document.body.innerText))
}
try {
  const page = await browser.newPage({ width: 390, height: 844, mobile: true })
  await page.goto(process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5188')
  await page.eval(() => document.querySelector('[aria-label="随机创建房间"]').click())
  await wait(page, () => !!document.querySelector('textarea'))
  await page.eval(async () => {
    const session = (await (await fetch('/api/v1/session')).json()).data
    const room = location.pathname.split('/').at(-1)
    for (let i = 0; i < 40; i++) {
      const response = await fetch(`/api/v1/rooms/${room}/items`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ text: `历史检查 ${i}：保留阅读位置` }),
      })
      if (!response.ok) throw Error(`Seed failed ${response.status}`)
    }
  })
  const url = await page.eval(() => location.href)
  await page.goto(url)
  await wait(page, () => document.querySelectorAll('[role=log] article').length === 30)
  await page.eval(() => { document.querySelector('[role=log]').scrollTop = 200 })
  await sleep(200)
  const anchor = await page.eval(() => {
    const log = document.querySelector('[role=log]')
    const row = [...log.querySelectorAll('article')].find(el => el.getBoundingClientRect().top >= log.getBoundingClientRect().top)
    return { text: row.innerText, top: row.getBoundingClientRect().top }
  })
  await page.eval(() => [...document.querySelectorAll('button')].find(el => el.textContent.includes('加载更早')).click())
  await wait(page, () => document.querySelectorAll('[role=log] article').length === 40)
  await sleep(300)
  const after = await page.eval(text => [...document.querySelectorAll('[role=log] article')].find(el => el.innerText === text)?.getBoundingClientRect().top, anchor.text)
  assert.ok(Math.abs(after - anchor.top) < 3, `Anchor moved ${after - anchor.top}px`)
  assert.equal(await page.eval(() => document.body.innerText.includes('条新内容')), false)
  assert.deepEqual(page.consoleErrors, [])
  const beforeCode = await page.eval(() => document.querySelector('h1').lastElementChild.textContent)
  await page.eval(() => document.querySelector('[aria-label="房间设置"]').click())
  await page.eval(() => [...document.querySelectorAll('button')].find(e => e.textContent.trim() === '更换房间号').click())
  for (let i = 0; i < 100; i++) {
    if (await page.eval(code => document.querySelector('h1').lastElementChild.textContent !== code, beforeCode)) break
    await sleep(100)
  }
  assert.notEqual(await page.eval(() => document.querySelector('h1').lastElementChild.textContent), beforeCode)
  assert.equal(await page.eval(() => document.querySelectorAll('[role=log] article').length), 40)
  console.log('PASS history anchor preserved, old rows not counted as new, room metadata update retains loaded history')
} finally { await browser.close() }
