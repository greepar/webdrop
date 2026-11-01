import assert from 'node:assert/strict'
import { Browser, sleep } from './browser.mjs'
const browser = await Browser.launch()
try {
 const page = await browser.newPage()
 await page.goto(process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5191')
 let mode = 'solve'
 await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/pow/challenges', requestStage: 'Request' }] })
 browser.on(page.sessionId, 'Fetch.requestPaused', event => page.send('Fetch.fulfillRequest', {
   requestId: event.requestId, responseCode: mode === 'cooldown' ? 429 : 200,
   responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Retry-After', value: '60' }],
   body: Buffer.from(JSON.stringify(mode === 'cooldown' ? { error: { code: 'RATE_LIMITED', message: 'test' } } : { data: { challengeId: 'test', version: 1, algorithm: 'sha256-leading-zero-bits', input: 'test', difficulty: 256, expiresAt: new Date(Date.now() + (mode === 'expired' ? -1000 : 60000)).toISOString() } })).toString('base64'),
 }))
 await page.eval(async () => {
   const { default: React } = await import('/node_modules/.vite/deps/react.js')
   const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js')
   const { usePow } = await import('/src/shared/pow/use-pow.ts')
   window.Worker = class { constructor() { window.__worker = this } postMessage() {} terminate() { this.terminated = true } }
   function Harness() { const pow = usePow(); React.useEffect(() => { window.__pow = pow }, [pow]); return null }
   const host = document.createElement('div'); document.body.append(host); window.__powRoot = createRoot(host); window.__powRoot.render(React.createElement(Harness))
 })
 await sleep(100)
 await page.eval(() => { window.__settled = false; window.__pow.obtainProof({ action: 'room.create', idempotencyKey: 'lifecycle-test' }).then(value => { window.__settled = true; window.__proof = value }) })
 for (let i = 0; i < 100; i++) { if (await page.eval(() => window.__pow.status.phase === 'solving')) break; await sleep(50) }
 assert.equal(await page.eval(() => window.__pow.status.phase), 'solving')
 await page.eval(() => window.__pow.cancel())
 assert.deepEqual(await page.eval(() => ({ settled: window.__settled, proof: window.__proof, terminated: window.__worker.terminated })), { settled: true, proof: null, terminated: true })
 mode = 'cooldown'
 await page.eval(() => window.__pow.obtainProof({ action: 'room.create', idempotencyKey: 'cooldown-test' }))
 await sleep(50)
 assert.equal(await page.eval(() => window.__pow.status.phase), 'cooldown')
 await page.eval(() => { window.__realNow = Date.now; Date.now = () => window.__realNow() + 61000; window.dispatchEvent(new Event('focus')) })
 await sleep(50)
 assert.equal(await page.eval(() => window.__pow.status.phase), 'idle')
 await page.eval(() => { Date.now = window.__realNow })
 mode = 'expired'
 assert.equal(await page.eval(async () => await window.__pow.obtainProof({ action: 'room.create', idempotencyKey: 'expired-test' })), null)
 await sleep(50)
 assert.equal(await page.eval(() => window.__pow.status.message), '验证已过期，请重试')
 assert.equal(await page.eval(() => window.__worker.terminated), true)
 mode = 'solve'
 await page.eval(() => { window.__settled = false; window.__pow.obtainProof({ action: 'room.create', idempotencyKey: 'unmount-test' }).then(value => { window.__settled = true; window.__proof = value }) })
 for (let i = 0; i < 100; i++) { if (await page.eval(() => window.__pow.status.phase === 'solving')) break; await sleep(50) }
 await page.eval(() => window.__powRoot.unmount())
 assert.deepEqual(await page.eval(() => ({ settled: window.__settled, proof: window.__proof, terminated: window.__worker.terminated })), { settled: true, proof: null, terminated: true })
 console.log('PASS cancel/unmount settle promises and terminate Worker; cooldown deadline and expired challenge handled')
} finally { await browser.close() }
