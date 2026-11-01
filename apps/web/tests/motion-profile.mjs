import { writeFile } from 'node:fs/promises'
import { Browser, sleep, enterRoom } from './browser.mjs'
const browser = await Browser.launch()
try {
  const page = await browser.newPage({ width: 390, height: 844, mobile: true })
  await page.goto(process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5190')
  await page.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await page.eval(() => {
    window.__longTasks = []
    new PerformanceObserver(list => window.__longTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: false })
  })
  const completed = new Promise(resolve => browser.on(page.sessionId, 'Tracing.tracingComplete', resolve))
  await page.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing', transferMode: 'ReturnAsStream' })
  await enterRoom(page)
  let ready = false
  for (let i = 0; i < 200; i++) {
    if (await page.eval(() => !!document.querySelector('textarea'))) { ready = true; break }
    await sleep(100)
  }
  if (!ready) throw Error('Room unavailable: ' + await page.eval(() => document.body.innerText))
  for (let i = 0; i < 4; i++) {
    await page.eval(() => document.querySelector('[aria-label^="成员，"]').click())
    await sleep(80)
    await page.eval(() => document.querySelector('[role=dialog] [aria-label="关闭"]').click())
    await sleep(140)
  }
  await page.eval(() => {
    const area = document.querySelector('textarea')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, '性能录制消息')
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await sleep(50)
  await page.eval(() => document.querySelector('[aria-label="发送"]').click())
  await sleep(800)
  const longTasks = await page.eval(() => window.__longTasks)
  await page.send('Tracing.end')
  const { stream } = await completed
  let trace = ''
  while (true) {
    const chunk = await page.send('IO.read', { handle: stream })
    trace += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString() : chunk.data
    if (chunk.eof) break
  }
  await page.send('IO.close', { handle: stream })
  const path = process.env.WEBDROP_TRACE_PATH || '/tmp/webdrop-motion-trace.json'
  await writeFile(path, trace)
  const events = JSON.parse(trace).traceEvents
  const durations = name => events.filter(e => e.name === name && e.dur).map(e => e.dur / 1000)
  const summary = { cpuThrottle: 4, viewport: '390x844', longTasks, maxLayoutMs: Math.max(0, ...durations('Layout')), maxPaintMs: Math.max(0, ...durations('Paint')), trace: path }
  console.log(JSON.stringify(summary, null, 2))
  await writeFile(path.replace(/\.json$/, '-summary.json'), JSON.stringify(summary, null, 2))
} finally { await browser.close() }
