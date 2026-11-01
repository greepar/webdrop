import assert from 'node:assert/strict'
import { Browser, sleep } from './browser.mjs'
const browser = await Browser.launch()
const waitTheme = async (p, expected) => { for (let i = 0; i < 100; i++) { if (await p.eval(() => document.documentElement.dataset.theme) === expected) return; await sleep(50) } assert.equal(await p.eval(() => document.documentElement.dataset.theme), expected) }
try {
 const p = await browser.newPage(), q = await browser.newPage(), restricted = await browser.newPage()
 const url = process.env.WEBDROP_TEST_URL
 await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
 await p.goto(url); await waitTheme(p, 'dark')
 await p.eval(() => document.querySelector('input[value=light]').click()); await waitTheme(p, 'light')
 await p.goto(url); await waitTheme(p, 'light')
 await q.goto(`${url}/missing-page`); await waitTheme(q, 'light')
 await p.eval(() => document.querySelector('input[value=dark]').click()); await waitTheme(q, 'dark')
 await p.eval(() => document.querySelector('input[value=system]').click()); await waitTheme(p, 'dark')
 await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }); await p.send('Page.bringToFront'); await waitTheme(p, 'light')
 await p.eval(() => document.querySelector('input[value=dark]').click())
 await q.goto(`${url}/s/not-found`); await waitTheme(q, 'dark')
 await restricted.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
 await restricted.send('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Blocked','SecurityError')}});document.addEventListener('DOMContentLoaded',()=>{window.__earlyTheme=document.documentElement.dataset.theme})` })
 await restricted.goto(url); await waitTheme(restricted, 'dark')
 assert.equal(await restricted.eval(() => window.__earlyTheme), 'dark')
 assert.equal(await restricted.eval(() => document.querySelector('meta[name="theme-color"]').content), '#1c1d1f')
 assert.deepEqual(restricted.consoleErrors, [])
 console.log('PASS system changes, persistent override, cross-tab/error/share themes and blocked-storage early dark theme')
} finally { await browser.close() }
