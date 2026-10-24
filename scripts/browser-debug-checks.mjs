import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

export function debugFixture(req,res){
  if(!req.url.startsWith('/debug-'))return false;
  if(req.url.startsWith('/debug-redirect')){res.writeHead(302,{Location:'/debug-api?redirected=1'});res.end();return true;}
  if(req.url.startsWith('/debug-frame')){res.setHeader('Content-Type','text/html');res.end(`<script>fetch('/debug-api?from=frame').then(r=>r.json()).then(value=>parent.postMessage({debugFrame:value},'*'));</script>`);return true;}
  res.writeHead(req.url.startsWith('/debug-error')?503:200,{'Content-Type':'application/json'});
  res.end(JSON.stringify({ok:true,url:req.url,payload:req.url.startsWith('/debug-big')?'x'.repeat(2*1024*1024+10):'正文保留'}));return true;
}
export async function verifyBrowserDebug({command,evaluate,navigate,baseUrl,outputDir,expectOopif=true}){
  await mkdir(outputDir,{recursive:true});const checks=[];const pass=name=>{checks.push(name);console.log('PASS debug:',name);};
  await command('debug',{action:'start'});
  await command('network',{action:'har',operation:'start',content:'text'});
  await evaluate(`Promise.all([fetch('/debug-api?main=1',{method:'POST'}),fetch('/debug-error'),fetch('/debug-redirect'),fetch('/debug-big')]).then(rs=>Promise.all(rs.map(r=>r.text()))).then(()=>true)`);
  const until=async fn=>{for(let i=0;i<40;i++){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,100));}throw Error('Debug fixture timed out');};
  const failures=await until(async()=>{const r=await command('network',{filter:'/debug-error',type:'xhr,fetch',method:'GET',status:'5xx',failed:true});return r.requests.some(r=>r.state==='complete')&&r;});
  assert.equal(failures.requests.length,1);assert.equal(failures.requests[0].status,503);
  const main=(await command('network',{filter:'main=1',method:'post'})).requests[0];assert.ok(main);
  const detail=await until(async()=>{const r=await command('network',{action:'request',id:main.id});return r.body.status==='captured'&&r;});
  assert.match(detail.body.text,/正文保留/);assert.equal((await command('network',{filter:'main=1',method:'GET'})).requests.length,0);
  pass('real HTTP request metadata, AND filters, IDs and retained response body');
  await evaluate(`console.log('debug-object',{count:3,name:'中文'});setTimeout(()=>{throw Error('debug-fixture-exception')},0);true`);
  const logs=await command('console',{filter:'debug-object'});assert.match(logs.messages[0].text,/count: 3/);
  await until(async()=>(await command('errors',{filter:'debug-fixture-exception'})).errors.length);
  pass('Console object preview and uncaught exception');
  const cross=new URL('/debug-frame',baseUrl);cross.hostname='localhost';
  await evaluate(`new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('iframe timeout')),10000);const listen=e=>{if(e.data?.debugFrame){clearTimeout(timer);removeEventListener('message',listen);resolve(true);}};addEventListener('message',listen);const frame=document.createElement('iframe');frame.src=${JSON.stringify(cross.href)};document.body.append(frame);})`);
  let frame;
  try{frame=await until(async()=>{const rs=(await command('network',{filter:'from=frame'})).requests;return rs.find(r=>r.body.status==='captured');});}
  catch(error){console.error('iframe capture diagnostics',JSON.stringify({status:await command('debug',{action:'status'}),requests:await command('network',{filter:'from=frame'})}));throw error;}
  assert.match((await command('network',{action:'request',id:frame.id})).body.text,/from=frame/);
  await until(async()=>(await command('network',{filter:'/debug-frame',type:'document'})).requests.some(r=>r.state==='complete'));
  if(expectOopif)assert.ok((await command('debug',{action:'status'})).targets>=2,'cross-process iframe must have a child CDP session');
  pass('cross-origin iframe request and response body on its own CDP session');
  await command('network',{action:'route',url:'*/debug-mock',body:'{"mocked":true}',status:201});
  assert.deepEqual(await evaluate(`fetch('/debug-mock').then(async r=>({status:r.status,...await r.json()}))`),{status:201,mocked:true});
  await command('network',{action:'route',url:'*/debug-abort',abort:true});assert.equal(await evaluate(`fetch('/debug-abort').then(()=>false,()=>true)`),true);
  await command('network',{action:'unroute'});assert.equal((await evaluate(`fetch('/debug-mock').then(r=>r.json())`)).ok,true);
  pass('mock response/status, abort and route cleanup');
  await navigate(baseUrl);
  assert.match((await command('network',{action:'request',id:main.id})).body.text,/正文保留/);
  const har=await command('network',{action:'har',operation:'stop',path:path.join(outputDir,'网络 请求.har')});
  const artifact=JSON.parse(await readFile(har.path,'utf8'));
  assert.ok(artifact.log.entries.some(r=>r.response.status===302));assert.ok(artifact.log.entries.some(r=>r._body.reason==='body-budget'));
  assert.ok(artifact.log.entries.some(r=>r.request.url.includes('from=frame')&&r.response.content.text));
  pass('HAR export preserves redirect, iframe and pre-navigation body; oversized body is explicitly omitted');
  await command('profiler',{action:'start'});await evaluate(`(()=>{const end=performance.now()+100;while(performance.now()<end){};performance.mark('profilepilot-debug-fixture');return true;})()`);
  const trace=await command('profiler',{action:'stop',path:path.join(outputDir,'性能 trace.json')});assert.equal(trace.complete,true);assert.ok(trace.eventCount>0);
  assert.ok(JSON.parse(await readFile(trace.path,'utf8')).traceEvents.length>0);pass('Chrome performance trace exports actual events');
  const report={at:new Date().toISOString(),platform:process.platform,checks,har,trace};await writeFile(path.join(outputDir,'result.json'),JSON.stringify(report,null,2));return report;
}
