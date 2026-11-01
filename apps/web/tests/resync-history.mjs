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
 await q.send('Page.addScriptToEvaluateOnNewDocument',{source:`window.__sources=[];const Original=window.EventSource;window.EventSource=class extends Original{constructor(...args){super(...args);window.__sources.push(this)}}`});
 await q.goto((process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5188'));
 await fill(q,'input[inputmode=numeric]',code);
 await q.eval(()=>document.querySelector('form').requestSubmit());
 await wait(q,()=>!!document.querySelector('textarea'));
 await q.send('Network.enable');
 await p.eval(async () => {
   const session = (await (await fetch('/api/v1/session')).json()).data;
   const id = location.pathname.split('/').at(-1);
   for(let i=0;i<40;i++) {
     const response = await fetch(`/api/v1/rooms/${id}/items`, {method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({text:`原有消息 ${i}`})});
     if(!response.ok) throw Error(`Seed failed ${response.status}`);
   }
 });
 await wait(q,()=>document.querySelectorAll('[role=log] article').length===40);
 await q.eval(()=>{document.querySelector('[role=log]').scrollTop=200});
 await sleep(150);
 const anchor=await q.eval(()=>{const log=document.querySelector('[role=log]');const row=[...log.querySelectorAll('[data-item-id]')].find(e=>e.getBoundingClientRect().top>=log.getBoundingClientRect().top);return {id:row.dataset.itemId,top:row.getBoundingClientRect().top}});
 await q.eval(()=>window.__sources.forEach(source=>source.close()));
 await p.eval(async () => {
   const session = (await (await fetch('/api/v1/session')).json()).data;
   const id = location.pathname.split('/').at(-1);
   for(let i=0;i<40;i++) {
     const response = await fetch(`/api/v1/rooms/${id}/items`, {method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({text:`重同步消息 ${i}`})});
     if(!response.ok) throw Error(`Seed failed ${response.status}`);
   }
 });
 let snapshots=0;
 b.on(q.sessionId,'Network.responseReceived',e=>{if(/\/rooms\/[^/]+$/.test(new URL(e.response.url).pathname)&&e.response.status===200)snapshots++});
 await q.eval(()=>window.__sources.at(-1).dispatchEvent(new Event('resync.required')));
 await wait(q,()=>document.querySelector('[role=log]').innerText.includes('重同步消息 39'));
 assert.ok(snapshots>0,'Injected resync.required must trigger a fresh snapshot');
 assert.equal(await q.eval(()=>document.querySelectorAll('[role=log] article').length),80);
 assert.equal(await q.eval(()=>[...document.querySelectorAll('[role=log] article')].filter(e=>e.innerText.includes('重同步消息 39')).length),1);
 const top=await q.eval(id=>[...document.querySelectorAll('[data-item-id]')].find(e=>e.dataset.itemId===id)?.getBoundingClientRect().top,anchor.id);
 assert.ok(Math.abs(top-anchor.top)<3,`Reader anchor moved ${top-anchor.top}px`);
 console.log('PASS full resync retains 40 old rows plus 40 new rows and reader anchor');
 assert.deepEqual(q.consoleErrors,[]);
}finally{await a.close();await b.close()}
