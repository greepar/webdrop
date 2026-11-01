import assert from 'node:assert/strict'
import { Browser, sleep, enterRoom } from './browser.mjs'
const browser = await Browser.launch()
const wait = async (p, fn) => { for (let i = 0; i < 150; i++) { if (await p.eval(fn)) return; await sleep(100) } throw Error(await p.eval(() => document.body.innerText)) }
try {
 const p = await browser.newPage()
 await p.goto(process.env.WEBDROP_TEST_URL)
 let tampered = false
 await p.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/v1/rooms', requestStage: 'Request' }] })
 browser.on(p.sessionId, 'Fetch.requestPaused', async event => {
   if (!tampered && event.request.method === 'POST') {
     tampered = true
     const body = JSON.parse(event.request.postData)
     body.proof.nonce = '00'
     await p.send('Fetch.continueRequest', { requestId: event.requestId, postData: Buffer.from(JSON.stringify(body)).toString('base64') })
   } else await p.send('Fetch.continueRequest', { requestId: event.requestId })
 })
 await enterRoom(p)
 await wait(p, () => document.body.innerText.includes('验证已失效，请重试'))
 assert.equal(tampered, true)
 assert.equal(await p.eval(() => location.pathname), '/')
 assert.equal(await p.eval(async () => (await (await fetch('/api/v1/session')).json()).data.memberships.length), 0)
 await enterRoom(p)
 await wait(p, () => !!document.querySelector('textarea'))
 assert.equal(await p.eval(async () => (await (await fetch('/api/v1/session')).json()).data.memberships.length), 1)
 assert.deepEqual(p.consoleErrors, [])
 console.log('PASS server rejects modified nonce without membership; fresh PoW retry enters only after authorization')
} finally { await browser.close() }
