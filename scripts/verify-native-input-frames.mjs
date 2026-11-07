// Real default-Profile extension test. The caller supplies an owned task session.
// No claims/resumes, focus changes, extra models, or external-site requests.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {requestNativeControl}=require('../dist/main/native-control/cli');
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){assert.ok(['--session','--output'].includes(args[i])&&args[i+1]&&!options[args[i]]);options[args[i]]=args[i+1];}
assert.ok(options['--session'],'Provide an already-owned --session');
const sessionId=options['--session'],out=path.resolve(options['--output']||'artifacts/native-input-frames');
await mkdir(out,{recursive:true});
const request=(method,params={})=>requestNativeControl({requestId:randomUUID(),sessionId,method,params});
let profileId;
const guard=async()=>{const s=(await request('status')).sessions.find(s=>s.sessionId===sessionId);assert.ok(s&&s.ownership==='agent'&&!s.pauseReason,'Control lost; no automatic resume');if(profileId)assert.equal(s.profileId,profileId);profileId=s.profileId;};
const records=[];
const cdp=async(method,params={})=>{await guard();const began=performance.now();const result=await request('cdp',{method,params});records.push({method,ms:performance.now()-began});return result;};
const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true});assert.ok(!r.exceptionDetails,r.exceptionDetails?.text);return r.result.value;};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fixture=child=>`<!doctype html><meta charset="utf-8"><title>ProfilePilot 后台输入验证</title>
<style>body{font:16px system-ui;margin:${child?'10':'24'}px;background:#f6f8fa;color:#17242b}h1{font-size:24px}#track{height:42px;width:480px;background:#dce8ef;border-radius:24px;position:relative;margin:16px 0;touch-action:none}#handle{width:40px;height:40px;background:#176b55;border-radius:50%;position:absolute;top:1px;left:0;cursor:grab}input{font:18px system-ui;padding:8px;width:350px}iframe{display:block;border:1px solid #b7c6ce;width:620px;height:170px;margin-top:18px}#report{white-space:pre-wrap}</style>
${child?'<b>iframe 内的后台拖动</b>':'<h1>ProfilePilot 默认 Profile 后台输入验证</h1><p>通过已连接的 Chrome 扩展执行，验证真实输入事件与绘制结果。</p>'}
<div id="track"><div id="handle"></div></div><p id="status">等待拖动</p>
${child?'':'<input id="keyboard" placeholder="中文输入验证"><iframe id="child" src="/frame"></iframe><pre id="report"></pre>'}
<script>
window.fixture={events:[],painted:0,ready:true};let dragging=false;
const trackElement=document.getElementById('track'),handleElement=document.getElementById('handle'),statusLabel=document.getElementById('status');
for(const type of ['pointerdown','pointermove','pointerup'])document.addEventListener(type,event=>{
 if(type==='pointerdown'&&event.target.id==='handle'){dragging=true;handleElement.setPointerCapture(event.pointerId);}
 if(!dragging)return;
 fixture.events.push({type:event.type,x:event.clientX,y:event.clientY,trusted:event.isTrusted});
 const rect=trackElement.getBoundingClientRect(),x=Math.max(0,Math.min(rect.width-40,event.clientX-rect.x-20));
 requestAnimationFrame(()=>{handleElement.style.left=x+'px';fixture.painted=x;fixture.label=statusLabel.textContent=x>=rect.width-42?'拖动验证：已到达终点':'拖动中';});
 if(type==='pointerup'){dragging=false;handleElement.releasePointerCapture(event.pointerId);}
});
document.getElementById('keyboard')?.addEventListener('input',e=>{fixture.keyboard={value:e.target.value,trusted:e.isTrusted};});
</script>`;
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fixture(req.url==='/frame'));});
const report={startedAt:new Date().toISOString(),platform:process.platform,status:'incomplete',checks:[],runs:[],records};
const save=()=>writeFile(path.join(out,'summary.json'),JSON.stringify(report,null,2),'utf8');
try {
 await guard();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}/`;
 await request('open',{url});
 let ready=false;
 for(let n=0;n<30;n++){ready=await evaluate('Boolean(window.fixture?.ready&&document.getElementById("child")?.contentWindow?.fixture?.ready)');if(ready)break;await pause(100);}
 assert.ok(ready,'Local fixture did not load');
 report.profileId=profileId;report.url=url;
 report.initial=await evaluate('({visibility:document.visibilityState,width:innerWidth,height:innerHeight,dpr:devicePixelRatio})');
 assert.equal(report.initial.visibility,'hidden','Use an inactive owned task tab; the test never activates or hides user tabs');
 const shot=async name=>{const png=Buffer.from((await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64');
   assert.equal(png.readUInt32BE(16),Math.round(report.initial.width*report.initial.dpr));
   assert.equal(png.readUInt32BE(20),Math.round(report.initial.height*report.initial.dpr));
   await writeFile(path.join(out,name+'.png'),png);};
 await shot('before');
 for(const child of [false,true]) {
   const geometry=await evaluate(`(()=>{const frame=${child?'document.getElementById("child")':'null'},doc=frame?frame.contentDocument:document;const h=doc.getElementById('handle').getBoundingClientRect(),t=doc.getElementById('track').getBoundingClientRect(),f=frame?frame.getBoundingClientRect():{x:0,y:0};const x=f.x+(frame?frame.clientLeft:0),y=f.y+(frame?frame.clientTop:0);return {start:{x:x+h.x+h.width/2,y:y+h.y+h.height/2},end:{x:x+t.right-2,y:y+h.y+h.height/2},max:t.width-h.width}})()`);
   const points=Array.from({length:25},(_,i)=>({x:geometry.start.x+(geometry.end.x-geometry.start.x)*(i+1)/25,y:geometry.start.y}));
   assert.ok([geometry.start,geometry.end,...points].every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
   const mouse=(type,p,buttons)=>cdp('Input.dispatchMouseEvent',{type,...p,button:buttons||type==='mouseReleased'?'left':'none',buttons,...(type!=='mouseMoved'?{clickCount:1}:{})});
   const before=records.length,began=performance.now();
   await mouse('mouseMoved',geometry.start,0);
   // Refuse another long drag if the extension update has not actually fixed ACK latency.
   assert.ok(records.at(-1).ms<2000,'Initial mousemove still stalls; stopped before pressing');
   await mouse('mousePressed',geometry.start,1);
   for(const p of points){await mouse('mouseMoved',p,1);await pause(25);}
   await mouse('mouseReleased',geometry.end,0);
   const elapsedMs=performance.now()-began;
   await shot(child?'iframe-after':'top-after');
   const state=await evaluate(child?'document.getElementById("child").contentWindow.fixture':'window.fixture');
   assert.equal(state.events.filter(e=>e.type==='pointerdown').length,1);
   assert.equal(state.events.filter(e=>e.type==='pointerup').length,1);
   assert.ok(state.events.filter(e=>e.type==='pointermove').length>=20);
   assert.ok(state.events.every(e=>e.trusted));
   assert.ok(Math.abs(state.painted-geometry.max)<2,'rAF must paint the final position');
   assert.equal(state.label,'拖动验证：已到达终点');
   const timings=records.slice(before).filter(r=>r.method==='Input.dispatchMouseEvent').map(r=>r.ms).sort((a,b)=>a-b);
   const run={scope:child?'iframe':'top',elapsedMs,inputCalls:timings.length,medianMs:timings[Math.floor(timings.length/2)],maxMs:Math.max(...timings),trustedEvents:state.events.length,painted:state.painted};
   assert.ok(run.medianMs<500&&run.maxMs<2500,'Background input latency still exceeds the verification budget');
   report.runs.push(run);console.log(JSON.stringify(run));
 }
 const keyboard=await evaluate(`(()=>{const r=document.getElementById('keyboard').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
 for(const type of ['mousePressed','mouseReleased'])await cdp('Input.dispatchMouseEvent',{type,...keyboard,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1});
 await cdp('Input.insertText',{text:'默认 Profile 中文输入 ✓'});
 const typed=await evaluate('window.fixture.keyboard');assert.equal(typed?.value,'默认 Profile 中文输入 ✓');assert.equal(typed.trusted,true);
 report.checks=['inactive tab remained hidden','top-level drag delivered trusted events and painted its endpoint','iframe drag delivered trusted events and painted its endpoint','full viewport screenshots kept their dimensions','Unicode input delivered a trusted event'];
 report.finalVisibility=await evaluate('document.visibilityState');assert.equal(report.finalVisibility,'hidden');
 report.status='verified';
 await evaluate(`document.getElementById('report').textContent=${JSON.stringify(report.runs.map(r=>`${r.scope}: ${Math.round(r.elapsedMs)} ms / ${r.inputCalls} 次输入 / 单次中位 ${Math.round(r.medianMs)} ms`).join('\n'))}`);
 await shot('verified');
}catch(error){report.failure={code:error.code,message:error.message};process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await save();const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closed;}
console.log(JSON.stringify({status:report.status,output:out,failure:report.failure}));
