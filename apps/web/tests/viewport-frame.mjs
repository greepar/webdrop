import assert from 'node:assert/strict'
import { Browser, sleep } from './browser.mjs'
const browser = await Browser.launch()
try {
 const page = await browser.newPage({ width: 390, height: 844, mobile: true })
 await page.goto(process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5191')
 await page.eval(async () => {
   const { default: React } = await import('/node_modules/.vite/deps/react.js')
   const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js')
   const { useViewportFrame } = await import('/src/shared/browser/use-viewport-frame.ts')
   const viewport = new EventTarget(); Object.assign(viewport, { height: 740, offsetTop: 0, scale: 1 })
   Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
   const host = document.createElement('div'); document.body.append(host)
   function Harness() { return React.createElement('div', { id: 'viewport-frame', style: useViewportFrame() }, 'frame') }
   window.__viewportRoot = createRoot(host); window.__viewportRoot.render(React.createElement(Harness))
 })
 await sleep(100)
 assert.equal(await page.eval(() => document.querySelector('#viewport-frame').style.height), '740px')
 await page.eval(() => { Object.assign(visualViewport, { height: 360, offsetTop: 80 }); visualViewport.dispatchEvent(new Event('resize')) })
 await sleep(100)
 assert.deepEqual(await page.eval(() => { const e = document.querySelector('#viewport-frame'); return { height: e.style.height, top: e.style.top } }), { height: '360px', top: '80px' })
 await page.eval(() => { visualViewport.scale = 2; visualViewport.dispatchEvent(new Event('resize')) })
 await sleep(100)
 assert.equal(await page.eval(() => document.querySelector('#viewport-frame').style.position), '')
 await page.eval(() => { window.__viewportRoot.unmount(); visualViewport.dispatchEvent(new Event('resize')) })
 await sleep(100)
 assert.deepEqual(page.consoleErrors, [])
 console.log('PASS visual viewport shrink/offset applied, pinch zoom keeps normal sizing, unmount cleans listeners')
} finally { await browser.close() }
