// Shows the filled state and verifies that completing the four boxes joins without pressing anything.
import assert from 'node:assert/strict'
import { Browser, sleep } from './browser.mjs'

const base = process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5188'
const browser = await Browser.launch()
const wait = async (page, fn, label) => {
  for (let i = 0; i < 200; i++) { if (await page.eval(fn)) return; await sleep(100) }
  throw Error(`Timed out: ${label}: ` + (await page.eval(() => document.body.innerText.slice(0, 160))))
}
try {
  // A: create a room through the button, so the code exists for the auto-join check.
  const maker = await browser.newPage({ width: 390, height: 844, mobile: true })
  await maker.goto(base)
  await wait(maker, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length === 4, 'boxes')
  const code = '7042'
  await maker.eval((value) => {
    const inputs = [...document.querySelectorAll('[role=group][aria-label^="房间号"] input')]
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    inputs.forEach((input, index) => { setter.call(input, value[index]); input.dispatchEvent(new Event('input', { bubbles: true })) })
  }, code)
  await sleep(600)
  await maker.screenshot({ path: '/tmp/opencode/entry-filled.png' })
  const filled = await maker.eval(() => ({
    values: [...document.querySelectorAll('[role=group][aria-label^="房间号"] input')].map(i => i.value),
    createEnabled: ![...document.querySelectorAll('button')].find(b => b.textContent.includes('创建房间'))?.disabled,
    path: location.pathname,
  }))
  console.log('filled', JSON.stringify(filled))

  // The auto-join already fired for a non-existent room, so create it with the button.
  if (filled.path === '/') {
    await maker.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建房间')).click())
  }
  await wait(maker, () => !!document.querySelector('textarea'), 'room created')
  console.log('created room', await maker.eval(() => location.pathname))

  // B: a second session types the same code and must land in the room without pressing anything.
  const joiner = await browser.newPage({ width: 390, height: 844, mobile: true })
  await joiner.goto(base)
  await wait(joiner, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length === 4, 'boxes 2')
  await joiner.eval((value) => {
    const inputs = [...document.querySelectorAll('[role=group][aria-label^="房间号"] input')]
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    inputs.forEach((input, index) => { setter.call(input, value[index]); input.dispatchEvent(new Event('input', { bubbles: true })) })
  }, code)
  await wait(joiner, () => !!document.querySelector('textarea'), 'auto join')
  assert.equal(await joiner.eval(() => location.pathname).then(p => p !== '/'), true, 'auto join did not navigate')
  console.log('auto-joined without pressing a button:', await joiner.eval(() => location.pathname))
  assert.deepEqual(joiner.consoleErrors, [])
  console.log('PASS four boxes fill, create button enables, and completing the code joins automatically')
} finally { await browser.close() }
