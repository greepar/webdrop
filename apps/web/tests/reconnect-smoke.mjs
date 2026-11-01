import assert from 'node:assert/strict';
import {Browser,sleep, enterRoom } from './browser.mjs';
const a=await Browser.launch(), b=await Browser.launch();
const wait=async(p,fn)=>{for(let i=0;i<100;i++){if(await p.eval(fn))return;await sleep(200)}throw Error('Condition timed out: '+await p.eval(()=>document.body.innerText))};
const fill=async(p,selector,value)=>{await p.eval(({selector,value})=>{const e=document.querySelector(selector);Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}))},{selector,value});await sleep(80)};
try{
 const p=await a.newPage({width:390,height:844,mobile:true}),q=await b.newPage();
 await p.goto((process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5188'));
 await enterRoom(p);
 await wait(p,()=>!!document.querySelector('textarea'));
 const code=await p.eval(()=>document.querySelector('h1').innerText.trim());
 await q.goto((process.env.WEBDROP_TEST_URL || 'http://127.0.0.1:5188'));
 await fill(q,'input[inputmode=numeric]',code);
 await q.eval(()=>document.querySelector('form').requestSubmit());
 await wait(q,()=>!!document.querySelector('textarea'));
 await q.send('Network.enable');
 await q.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
 await fill(p,'textarea','离线期间的消息');
 await p.eval(()=>document.querySelector('[aria-label="发送"]').click());
 await wait(p,()=>document.querySelector('[role=log]').innerText.includes('离线期间的消息'));
 await q.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
 await wait(q,()=>document.querySelector('[role=log]').innerText.includes('离线期间的消息'));
 assert.equal(await q.eval(()=>[...document.querySelectorAll('[role=log] article')].filter(e=>e.innerText.includes('离线期间的消息')).length),1);
 console.log('PASS offline reconnect recovers one copy of missed message');
 assert.deepEqual(q.consoleErrors,[]);

}finally{await a.close();await b.close()}
