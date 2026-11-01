import assert from 'node:assert/strict';
import {Browser,sleep} from './browser.mjs';
const a=await Browser.launch(), b=await Browser.launch(), c=await Browser.launch();
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
 assert.equal(await q.eval(()=>[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='管理')),false);
 await q.eval(()=>{const f=document.querySelector('input[type=file]'),d=new DataTransfer();for(const name of ['delete.txt','close.txt'])d.items.add(new File(['lifecycle bytes'],name,{type:'text/plain'}));f.files=d.files;f.dispatchEvent(new Event('change',{bubbles:true}))});
 await wait(q,()=>!!document.querySelector('[aria-label="分享 close.txt"]')&&!!document.querySelector('[aria-label="分享 delete.txt"]'));
 const links={};
 for(const name of ['delete.txt','close.txt']){
   await q.eval(name=>document.querySelector(`[aria-label="分享 ${name}"]`).click(),name);
   await wait(q,()=>!document.body.innerText.includes('正在读取链接'));
   await q.eval(()=>[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='创建分享链接').click());
   await wait(q,()=>document.body.innerText.includes('已创建分享链接'));
   links[name]=await q.eval(()=>document.querySelector('[role=dialog] .font-mono').textContent);
   await q.eval(()=>document.querySelector('[role=dialog] button[aria-label="关闭"]').click());
   await wait(q,()=>!document.querySelector('[role=dialog]'));
 }
 const publicPage=await c.newPage();
 let unavailable=true;
 await publicPage.send('Fetch.enable',{patterns:[{urlPattern:'*/shares/*',requestStage:'Request'}]});
 const off=c.on(publicPage.sessionId,'Fetch.requestPaused',async event=>{
   if(unavailable)await publicPage.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:503,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify({error:{code:'UNAVAILABLE',message:'test'}})).toString('base64')});
   else await publicPage.send('Fetch.continueRequest',{requestId:event.requestId});
 });
 await publicPage.goto(links['delete.txt']);
 await wait(publicPage,()=>document.body.innerText.includes('暂时无法打开'));
 unavailable=false;
 await publicPage.eval(()=>[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='重试').click());
 await wait(publicPage,()=>!!document.querySelector('a[download]'));
 await publicPage.send('Fetch.disable');off();
 const contentUrls={};
 for(const name of ['delete.txt','close.txt']){
   await publicPage.goto(links[name]);
   await wait(publicPage,()=>!!document.querySelector('a[download]'));
   contentUrls[name]=await publicPage.eval(()=>document.querySelector('a[download]').href);
 }
 await q.eval(()=>[...document.querySelectorAll('article')].find(e=>e.innerText.includes('delete.txt')).querySelector('[aria-label="删除这条内容"]').click());
 await wait(q,()=>!document.querySelector('[aria-label="预览 delete.txt"]'));
 await publicPage.goto(links['delete.txt']);
 await wait(publicPage,()=>document.body.innerText.includes('链接已失效'));
 assert.equal(await publicPage.eval(async url=>(await fetch(url)).status,contentUrls['delete.txt']),410);
 await p.eval(()=>document.querySelector('[aria-label="房间设置"]').click());
 await p.eval(()=>[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='关闭房间').click());
 await p.eval(()=>[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='确认').click());
 await wait(q,()=>document.body.innerText.includes('房间不可用'));
 await publicPage.goto(links['close.txt']);
 await wait(publicPage,()=>document.body.innerText.includes('链接已失效'));
 assert.equal(await publicPage.eval(async url=>(await fetch(url)).status,contentUrls['close.txt']),410);
 assert.deepEqual(q.consoleErrors,[]);assert.deepEqual(publicPage.consoleErrors,[]);
 console.log('PASS share retry recovers from 503; deletion and closure invalidate anonymous pages and raw links');
}finally{await a.close();await b.close();await c.close()}
