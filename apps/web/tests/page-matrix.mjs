// Visual matrix for pages the room-only layout check does not cover: entry, share and 404.
// Runs against a live API + frontend so the share page reads real metadata.
import assert from 'node:assert/strict'
import { Browser, sleep } from './browser.mjs'

const base = process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5188'
const viewports = [
  { name: '320', width: 320, height: 640, mobile: true },
  { name: '390', width: 390, height: 844, mobile: true },
  { name: '768', width: 768, height: 1024, mobile: false },
  { name: '1440', width: 1440, height: 900, mobile: false },
  { name: '844x390', width: 844, height: 390, mobile: true },
]
const browser = await Browser.launch()
const out = process.env.WEBDROP_SCREENSHOTS || '/tmp/webdrop-pages'
const { mkdir } = await import('node:fs/promises')
await mkdir(out, { recursive: true })
const wait = async (page, fn, label) => {
  for (let i = 0; i < 200; i++) { if (await page.eval(fn)) return; await sleep(150) }
  throw Error(`Timed out: ${label}`)
}

async function open(browser, theme, vp) {
  const page = await browser.newPage({ width: vp.width, height: vp.height, mobile: vp.mobile })
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
  return page
}

// Each page keeps an SSE subscription; leaving them open exhausts the server's per-device limit and
// makes later rooms look like they cannot reconnect.
const close = async (page) => { try { await page.send('Target.closeTarget', { targetId: page.targetId }) } catch {} }

function checkOverflow(page, label) {
  return page.eval(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  })).then(({ doc, body }) => {
    assert.ok(doc <= 0 && body <= 0, `${label} overflows: doc=${doc} body=${body}`)
  })
}

try {
  // Create one room and one share link, so the share page has real data for every viewport.
  const setup = await open(browser, 'light', viewports[0])
  await setup.goto(base)
  await wait(setup, () => !document.querySelector('[aria-label="随机创建房间"]').disabled, 'entry ready')
  await setup.eval(() => document.querySelector('[aria-label="随机创建房间"]').click())
  await wait(setup, () => !!document.querySelector('textarea'), 'room')
  await setup.eval(async () => {
    const session = (await (await fetch('/api/v1/session')).json()).data
    const room = location.pathname.split('/').at(-1)
    const r = await fetch(`/api/v1/rooms/${room}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ text: '视觉矩阵：一段足够长的消息文字，用来检查在窄屏与宽屏下的换行、行距和气泡宽度是否合理。' }),
    })
    if (!r.ok) throw Error('seed ' + r.status)
  })
  const doc = await setup.send('DOM.getDocument', { depth: -1 })
  const input = await setup.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
  await setup.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: ['/tmp/opencode/sample.txt'] })
  await wait(setup, () => !document.querySelector('[aria-label="上传队列"]'), 'upload')
  await setup.eval(() => document.querySelector('button[aria-label^="分享 "]').click())
  await wait(setup, () => !!document.querySelector('[role=dialog]'), 'share sheet')
  await setup.eval(() => [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.includes('创建分享链接')).click())
  await wait(setup, () => !!document.querySelector('[role=dialog] p.font-mono'), 'link')
  const sharePath = (await setup.eval(() => document.querySelector('[role=dialog] p.font-mono').textContent)).replace(/^https?:\/\/[^/]+/, '')
  const roomPath = await setup.eval(() => location.pathname)

  const failures = []
  for (const theme of ['light', 'dark']) {
    for (const vp of viewports) {
      const label = `${theme} ${vp.name}`
      // One page per viewport: each room view holds an SSE subscription, and the server allows 3 per device.
      const page = await open(browser, theme, vp)
      try {
        await page.goto(base)
        await wait(page, () => !!document.querySelector('h1'), `entry ${label}`)
        await checkOverflow(page, `entry ${label}`)
        assert.equal(await page.eval(() => document.querySelector('h1').textContent), 'WebDrop', `entry brand ${label}`)
        const inputBox = await page.eval(() => {
          const el = document.querySelector('#root input[type=text]')
          const r = el.getBoundingClientRect()
          return { h: r.height, fontSize: getComputedStyle(el).fontSize, right: r.right, viewport: innerWidth }
        })
        assert.ok(inputBox.right <= inputBox.viewport + 0.5, `entry input clipped ${label}`)
        assert.ok(parseFloat(inputBox.fontSize) >= 16, `entry input font ${label}=${inputBox.fontSize}`)
        assert.ok(inputBox.h >= 44, `entry input height ${label}=${inputBox.h}`)
        await page.screenshot({ path: `${out}/entry-${theme}-${vp.name}.png` })

        await page.goto(base + sharePath)
        await wait(page, () => !!document.querySelector('h1'), `share ${label}`)
        await checkOverflow(page, `share ${label}`)
        assert.equal(await page.eval(() => document.querySelector('h1').textContent), 'sample.txt', `share title ${label}`)
        assert.ok(await page.eval(() => !!document.querySelector('a[download]')), `share download ${label}`)
        await page.screenshot({ path: `${out}/share-${theme}-${vp.name}.png` })

        await page.goto(base + '/no-such-page')
        await wait(page, () => !!document.querySelector('h1'), `404 ${label}`)
        await checkOverflow(page, `404 ${label}`)
        assert.equal(await page.eval(() => document.querySelector('h1').textContent), '找不到这个页面', `404 title ${label}`)
        await page.screenshot({ path: `${out}/404-${theme}-${vp.name}.png` })

        await page.goto(base + roomPath)
        await wait(page, () => !!document.querySelector('textarea'), `room ${label}`)
        await checkOverflow(page, `room ${label}`)
        assert.equal(await page.eval(() => document.body.innerText.includes('连接中断')), false, `room ${label} reported a broken stream`)
        await page.screenshot({ path: `${out}/room-${theme}-${vp.name}.png` })
        console.log(`PASS ${label}`)
      } catch (error) { failures.push(`${label}: ${error.message}`) }
      await close(page)
      await sleep(250)
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'))
  console.log(`PASS entry, share, 404 and room at ${viewports.length} viewports x 2 themes, no overflow, screenshots in ${out}`)
} finally {
  await browser.close()
}
