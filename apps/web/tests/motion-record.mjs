// Records frame pacing and dialog geometry during real interactions, then prints a summary.
// Uses requestAnimationFrame timestamps (frame gaps) and PerformanceObserver('longtask'), which is the
// closest headless equivalent to the DevTools Performance panel. Results describe this host only.
import assert from 'node:assert/strict'
import { Browser, sleep, enterRoom } from './browser.mjs'

const base = process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5188'
const browser = await Browser.launch()
const wait = async (page, fn, label) => {
  for (let i = 0; i < 300; i++) { if (await page.eval(fn)) return; await sleep(100) }
  throw Error(`Timed out: ${label}`)
}
const startRecorder = (page) => page.eval(() => {
  const state = window.__rec = { frames: [], longTasks: [], samples: [], phase: 'idle' }
  let last = performance.now()
  const loop = (now) => {
    state.frames.push(now - last)
    last = now
    const panel = document.querySelector('[role=dialog]')
    if (panel) {
      const r = panel.getBoundingClientRect()
      state.samples.push({ t: Math.round(now), phase: state.phase, top: Math.round(r.top), h: Math.round(r.height), scrollY: window.scrollY })
    }
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) state.longTasks.push(Math.round(entry.duration))
    }).observe({ entryTypes: ['longtask'] })
  } catch {}
  return true
})
const mark = (page, phase) => page.eval((value) => { window.__rec.phase = value }, phase)
const summary = (page) => page.eval(() => {
  const { frames, longTasks, samples } = window.__rec
  const gaps = frames.slice(1)
  const over25 = gaps.filter(g => g > 25).length
  const over50 = gaps.filter(g => g > 50).length
  const max = gaps.length ? Math.max(...gaps) : 0
  const tops = samples.filter(s => s.phase === 'open' || s.phase === 'close').map(s => s.top)
  const scrolls = [...new Set(samples.map(s => s.scrollY))]
  return {
    frames: gaps.length,
    over25,
    over50,
    max: Math.round(max * 10) / 10,
    longTasks,
    dialogTopRange: tops.length ? [Math.min(...tops), Math.max(...tops)] : null,
    backgroundScrollValues: scrolls,
  }
})

try {
  const page = await browser.newPage({ width: 390, height: 844, mobile: true })
  await page.goto(base)
  await wait(page, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length > 0, 'entry')
  await enterRoom(page)
  await wait(page, () => !!document.querySelector('textarea'), 'room')

  await startRecorder(page)

  // A: dialog open and close (members panel), sampled every frame.
  await mark(page, 'open')
  await page.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('成员'))?.click())
  await sleep(400)
  await mark(page, 'close')
  await page.eval(() => document.querySelector('[role=dialog] button[aria-label="关闭"]')?.click())
  await sleep(400)
  await mark(page, 'idle')
  const a = await summary(page)

  // B: upload a 2 MB file while sending messages and toggling the dialog.
  await page.eval(async () => {
    const bytes = new Uint8Array(2_000_000)
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 251
    const file = new File([bytes], 'record.bin', { type: 'application/octet-stream' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const input = document.querySelector('input[type=file]')
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.eval(async () => {
    const session = (await (await fetch('/api/v1/session')).json()).data
    const room = location.pathname.split('/').at(-1)
    for (let i = 0; i < 8; i++) {
      await fetch(`/api/v1/rooms/${room}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ text: `录制期间的消息 ${i}` }),
      })
      await new Promise(r => setTimeout(r, 120))
    }
  })
  await mark(page, 'open')
  await page.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('成员'))?.click())
  await sleep(350)
  await mark(page, 'close')
  await page.eval(() => document.querySelector('[role=dialog] button[aria-label="关闭"]')?.click())
  await sleep(400)
  await wait(page, () => !document.querySelector('[aria-label="上传队列"]'), 'upload done')
  const b = await summary(page)

  // C: PoW solve + room load, recorded from the entry page.
  const entry = await browser.newPage({ width: 390, height: 844, mobile: true })
  await entry.goto(base)
  await wait(entry, () => !entry.eval ? false : true, 'noop').catch(() => {})
  await wait(entry, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length > 0, 'entry 2')
  await startRecorder(entry)
  await enterRoom(entry)
  await wait(entry, () => !!document.querySelector('textarea'), 'pow room')
  await sleep(300)
  const c = await summary(entry)

  for (const [name, result] of [['A dialog open/close', a], ['B upload+messages+dialog', b], ['C PoW + room load', c]]) {
    assert.equal(result.over50, 0, `${name}: frames over 50ms`)
    assert.ok(result.over25 <= 1, `${name}: ${result.over25} frames over 25ms`)
    assert.deepEqual(result.longTasks, [], `${name}: long tasks`)
    if (result.dialogTopRange) {
      const span = result.dialogTopRange[1] - result.dialogTopRange[0]
      assert.ok(span <= 12, `${name}: dialog moved ${span}px (expected only the 8px entrance/exit)`)
      assert.deepEqual(result.backgroundScrollValues, [0], `${name}: background scrolled while dialog was open`)
    }
  }
  // D: desktop dialog, checking that locking body scroll does not shift the page sideways.
  const desk = await browser.newPage({ width: 1440, height: 900, mobile: false })
  await desk.goto(base)
  await wait(desk, () => document.querySelectorAll('[role=group][aria-label^="房间号"] input').length > 0, 'desktop entry')
  const before = await desk.eval(() => document.documentElement.clientWidth)
  await enterRoom(desk)
  await wait(desk, () => !!document.querySelector('textarea'), 'desktop room')
  await desk.eval(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('成员'))?.click())
  await sleep(400)
  const during = await desk.eval(() => ({ width: document.documentElement.clientWidth, scrollX: window.scrollX }))
  assert.equal(during.width, before, `desktop page width changed when the dialog locked scroll (${before} -> ${during.width})`)
  assert.equal(during.scrollX, 0, 'desktop page shifted horizontally')
  console.log('D desktop scroll lock: width stable at', during.width)

  console.log('A dialog open/close:', JSON.stringify(a))
  console.log('B upload+messages+dialog:', JSON.stringify(b))
  console.log('C PoW + room load:', JSON.stringify(c))
  console.log('errors:', page.consoleErrors.length ? page.consoleErrors.join(' | ') : 'none')
  console.log('PASS frame pacing and dialog geometry across dialog, upload, messages and PoW')
} finally { await browser.close() }
