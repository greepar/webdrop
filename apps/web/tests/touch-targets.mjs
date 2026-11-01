import assert from 'node:assert/strict'
import { Browser, sleep, enterRoom } from './browser.mjs'
const browser = await Browser.launch()
try {
 const p = await browser.newPage({ width: 320, height: 740, mobile: true })
 await p.send('Emulation.setTouchEmulationEnabled', { enabled: true })
 await p.goto(process.env.WEBDROP_TEST_URL)
 assert.equal(await p.eval(() => matchMedia('(pointer: coarse)').matches), true)
 const small = await p.eval(() => [...document.querySelectorAll('button, [role="radiogroup"] label')].filter(e => e.getClientRects().length).map(e => ({ name: e.getAttribute('aria-label') || e.textContent, width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height })).filter(e => e.width < 44 || e.height < 44))
 assert.deepEqual(small, [])
 await enterRoom(p)
 for (let i = 0; i < 100; i++) { if (await p.eval(() => !!document.querySelector('textarea'))) break; await sleep(100) }
 assert.equal(await p.eval(() => !!document.querySelector('textarea')), true)
 const room = await p.eval(() => [...document.querySelectorAll('button, [role="radiogroup"] label')].filter(e => e.getClientRects().length).map(e => ({ name: e.getAttribute('aria-label') || e.textContent, rect: e.getBoundingClientRect().toJSON() })).filter(e => e.rect.width < 44 || e.rect.height < 44 || e.rect.left < 0 || e.rect.right > innerWidth))
 assert.deepEqual(room, [])
 assert.equal(await p.eval(() => document.documentElement.scrollWidth > innerWidth), false)
 console.log('PASS coarse pointer homepage and 320px room controls have 44px hit targets without clipped controls')
} finally { await browser.close() }
