import assert from 'node:assert/strict'
import { Browser, sleep } from './browser.mjs'
const browser = await Browser.launch()
try {
 const page = await browser.newPage({ width: 390, height: 844, mobile: true })
 await page.goto(process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5191')
 await page.eval(async () => {
   const { default: React } = await import('/node_modules/.vite/deps/react.js')
   const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js')
   const { MessageList } = await import('/src/features/room/MessageList.tsx')
   const rows = Array.from({ length: 40 }, (_, i) => ({ id: `row-${i}`, kind: 'text', roomId: 'test', senderMemberId: 'me', createdAt: new Date(1700000000000 + i * 1000).toISOString(), text: `阅读位置测试 ${i}`, asset: null }))
   function Harness() {
     const [items, setItems] = React.useState(rows)
     React.useEffect(() => { window.__deleteRow = id => setItems(rows => rows.filter(row => row.id !== id)) }, [])
     return React.createElement('div', { style: { height: 600, display: 'flex', flexDirection: 'column' } }, React.createElement(MessageList, { items, members: [], selfMemberId: 'me', isOwner: true, hasOlder: false, loadingOlder: false, onLoadOlder() {}, onDelete() {}, onCopy() {}, onShare() {}, onPreview() {} }))
   }
   const host = document.createElement('div'); document.body.replaceChildren(host); createRoot(host).render(React.createElement(Harness))
 })
 await sleep(100)
 await page.eval(() => { document.querySelector('[role=log]').scrollTop = 300 })
 await sleep(100)
 const anchors = await page.eval(() => {
   const log = document.querySelector('[role=log]')
   return [...log.querySelectorAll('[data-item-id]')].filter(el => el.getBoundingClientRect().top >= log.getBoundingClientRect().top).slice(0, 2).map(el => ({ id: el.dataset.itemId, top: el.getBoundingClientRect().top }))
 })
 await page.eval(id => window.__deleteRow(id), anchors[0].id)
 await sleep(100)
 const after = await page.eval(id => [...document.querySelectorAll('[data-item-id]')].find(el => el.dataset.itemId === id).getBoundingClientRect().top, anchors[1].id)
 assert.ok(Math.abs(after - anchors[1].top) < 3, `Surviving row shifted ${after - anchors[1].top}px`)
 assert.equal(await page.eval(() => document.querySelectorAll('[data-item-id]').length), 39)
 console.log('PASS removing first reading anchor retains next surviving row within 3px')
} finally { await browser.close() }
