import assert from 'node:assert/strict';
import {Browser,sleep} from './browser.mjs';
const a=await Browser.launch(), b=await Browser.launch();
const wait=async(p,fn)=>{for(let i=0;i<100;i++){if(await p.eval(fn))return;await sleep(200)}throw Error('Condition timed out: '+await p.eval(()=>document.body.innerText))};
const fill=async(p,selector,value)=>{await p.eval(({selector,value})=>{const e=document.querySelector(selector);Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}))},{selector,value});await sleep(80)};
try{
 const p=await a.newPage({width:390,height:844,mobile:true}),q=await b.newPage();
 await p.goto((process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5188'));
 await p.eval(()=>document.querySelector('[aria-label="随机创建房间"]').click());
 await wait(p,()=>!!document.querySelector('textarea'));
 const code=await p.eval(()=>document.querySelector('h1').innerText.trim());
 await q.goto((process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5188'));
 await fill(q,'input[inputmode=numeric]',code);
 await q.eval(()=>document.querySelector('form').requestSubmit());
 await wait(q,()=>!!document.querySelector('textarea'));
 await q.send('Network.enable');
 await q.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
 await p.eval(async () => {
   const session = (await (await fetch('/api/v1/session')).json()).data;
   const id = location.pathname.split('/').at(-1);
   for(let i=0;i<270;i++) {
     const response = await fetch(`/api/v1/rooms/${id}/items`, {method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({text:`重同步消息 ${i}`})});
     if(!response.ok) throw Error(`Seed failed ${response.status}`);
   }
 });
 let snapshots=0;
 b.on(q.sessionId,'Network.responseReceived',e=>{if(/\/rooms\/[^/]+$/.test(new URL(e.response.url).pathname)&&e.response.status===200)snapshots++});
 await q.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
 await wait(q,()=>document.querySelector('[role=log]').innerText.includes('重同步消息 269'));
 assert.ok(snapshots>0,'Old cursor must trigger a fresh room snapshot');
 assert.equal(await q.eval(()=>document.querySelectorAll('[role=log] article').length),30);
 assert.equal(await q.eval(()=>[...document.querySelectorAll('[role=log] article')].filter(e=>e.innerText.includes('重同步消息 269')).length),1);
 console.log('PASS expired event cursor triggers fresh snapshot, latest 30 rows contain newest message once');
 assert.deepEqual(q.consoleErrors,[]);
}finally{await a.close();await b.close()}
