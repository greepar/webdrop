// Backend integration: closed owner panel reacts to created/withdrawn SSE before the 30s fallback.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { Browser, sleep, enterRoom } from './browser.mjs'
const base = process.env.WEBDROP_TEST_URL
const browser = await Browser.launch()
try {
  const owner = await browser.newPage()
  await owner.goto(base)
  await enterRoom(owner)
  const room = await owner.eval(() => location.pathname.split('/').pop())
  const code = await owner.eval(() => document.querySelector('h1').lastElementChild.textContent.trim())
  await owner.send('Network.enable')
  let listReads = 0
  browser.on(owner.sessionId, 'Network.responseReceived', (event) => {
    if (new URL(event.response.url).pathname.endsWith(`/rooms/${room}/join-requests`) && event.response.status === 200) listReads++
  })
  assert.equal(await owner.eval(async room => {
    const session = (await (await fetch('/api/v1/session')).json()).data
    return (await fetch(`/api/v1/rooms/${room}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ approvalRequired: true }) })).status
  }, room), 200)
  for (let i = 0; i < 80 && listReads === 0; i++) await sleep(50)
  assert.ok(listReads > 0, 'approval watcher enabled by room.updated')
  assert.equal(await owner.eval(() => !!document.querySelector('[role=dialog]')), false)
  const sessionResponse = await fetch(`${base}/api/v1/sessions`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' })
  const session = (await sessionResponse.json()).data
  const headers = { Origin: base, 'Content-Type': 'application/json', Cookie: sessionResponse.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': session.csrfToken }
  const key = randomUUID()
  const challenge = (await (await fetch(`${base}/api/v1/pow/challenges`, { method: 'POST', headers, body: JSON.stringify({ action: 'room.join', code, idempotencyKey: key }) })).json()).data
  let nonce = 0
  while (BigInt(`0x${createHash('sha256').update(challenge.input + nonce).digest('hex')}`) >> BigInt(256 - challenge.difficulty)) nonce++
  const started = performance.now()
  const pending = (await (await fetch(`${base}/api/v1/rooms/join`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body: JSON.stringify({ code, proof: { challengeId: challenge.challengeId, nonce: String(nonce) } }) })).json()).data.request
  for (let i = 0; i < 60; i++) {
    if (await owner.eval(() => document.body.innerText.includes('有 1 条入房申请待处理'))) break
    await sleep(50)
  }
  assert.equal(await owner.eval(() => document.body.innerText.includes('有 1 条入房申请待处理')), true)
  assert.ok(performance.now() - started < 3000, 'SSE notification arrives before 30s fallback')
  // Reproduce a previously opened panel pinning a stale nonzero count after it closes.
  await owner.eval(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '去处理').click())
  for (let i = 0; i < 60; i++) {
    if (await owner.eval(() => [...document.querySelectorAll('[role=dialog] button')].some(button => button.textContent.trim() === '同意'))) break
    await sleep(50)
  }
  assert.equal(await owner.eval(() => [...document.querySelectorAll('[role=dialog] button')].some(button => button.textContent.trim() === '同意')), true)
  await owner.eval(() => document.querySelector('[role=dialog] button[aria-label="关闭"]').click())
  const withdrawn = await fetch(`${base}/api/v1/rooms/${room}/join-requests/${pending.id}`, { method: 'DELETE', headers })
  assert.equal(withdrawn.status, 204)
  for (let i = 0; i < 60; i++) {
    if (!await owner.eval(() => document.body.innerText.includes('有 1 条入房申请待处理') || !!document.querySelector('[aria-label*="有 1 条入房申请"]'))) break
    await sleep(50)
  }
  assert.equal(await owner.eval(() => document.body.innerText.includes('有 1 条入房申请待处理')), false)
  assert.equal(await owner.eval(() => !!document.querySelector('[aria-label*="有 1 条入房申请"]')), false)
  assert.deepEqual(owner.consoleErrors, [])
  console.log('PASS owner closed-panel SSE badge/toast created and cleared on withdrawal without fallback polling')
} finally { await browser.close() }
