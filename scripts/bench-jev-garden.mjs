// Reuse Garden Lab's original tasks and pages. Never modify the Agent during a series.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfiguredTaskProvider } from './task-provider-fixture.mjs';

const require = createRequire(import.meta.url);
const { TaskStore } = require('../dist/main/tasks/store');
const { TaskService } = require('../dist/main/tasks/service');
const { WrapperBrowser } = require('../dist/main/tasks/browser');
const { chooseJevAction } = require('../dist/main/tasks/jev-actions');
const { requestBrowserGateway, subscribeBrowserGatewayEvents } = require('../dist/main/browser-gateway-client');
const [profileId, portText, roundsText = '3', resumeId] = process.argv.slice(2);
const port = Number(portText), rounds = Number(roundsText);
assert.ok(profileId?.startsWith('isolated:') && Number.isInteger(port) && port >= 1024);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 5);
const repo = path.resolve('.'), garden = path.resolve('../garden-lab'), bench = path.join(garden, 'apps/browser-tool-bench');
const ids = ['T05', 'T06', 'T15', 'T20', 'T08', 'T18'];
const names = { T05: '动态列表', T06: '分页商品 JSON', T15: 'SSE 实时流', T20: '10 次检查统计', T08: '登录与 Shadow DOM', T18: '文件上传' };
assert.ok(!resumeId || /^jev-core-[\dTZ-]+$/.test(resumeId), 'Invalid series ID.');
const runId = resumeId || `jev-core-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const root = path.join(repo, '.cpm-data', runId), output = path.join(bench, 'results', runId);
await mkdir(root, { recursive: true }); await mkdir(output, { recursive: true });
const provider = await loadConfiguredTaskProvider({ includeJev: true });
assert.ok(provider.apiKey && provider.jevApiKey && provider.settings.jevEnabled);
const redact = s => [provider.apiKey, provider.jevApiKey].reduce((s, k) => s.replaceAll(k, '[REDACTED]'), s);
const sha = data => createHash('sha256').update(data).digest('hex');
const gateway = await requestBrowserGateway({ action: 'status' });
const gatewayRuntime = await requestBrowserGateway({ action: 'ping' });
// Protocol 15 changes Windows downloads, which these tasks do not exercise.
// Record and freeze the actual Gateway; version mismatch alone is not a reason
// to restart all user browsers or exclude otherwise comparable measurements.
const binding = gateway.state.profiles.find(p => p.profileId === profileId && p.publicPort === port);
assert.ok(binding && (!binding.ownerSessionId || binding.sessionStatus === 'stopped'), 'Allocated Profile is occupied; do not take over.');
const cards = await readdir(path.join(bench, 'tasks'));
const tasks = [];
for (const id of ids) {
  const file = cards.find(f => f.startsWith(id + '-')); const content = (await readFile(path.join(bench, 'tasks', file), 'utf8')).replace(/^\uFEFF/, '');
  const prompt = content.split('## Ground Truth')[0].split('\n').filter(l => l.startsWith('> ')).map(l => l.slice(2).trim()).join('\n');
  assert.ok(prompt.includes('http://localhost:4399/'));
  tasks.push({ id, name: names[id], card: path.relative(garden, path.join(bench, 'tasks', file)), sha256: sha(content), prompt });
}
const frozenFiles = ['service', 'browser', 'fast-browser', 'jev-driver', 'jev-actions', 'task-helper', 'worker', 'jev'];
const codeHashes = Object.fromEntries(await Promise.all(frozenFiles.map(async f => [f, sha(await readFile(path.join(repo, `dist/main/tasks/${f}.js`)))])));
const serverSource = await readFile(path.join(bench, 'server.mjs'), 'utf8');
// Only instrumentation: original handlers/pages/delays remain unchanged. Reset
// synthetic server sessions via private IPC; journal request paths for grading.
let instrumented = serverSource.replace('new URL("./public", import.meta.url)', `new URL(${JSON.stringify(pathToFileURL(path.join(bench, 'public') + path.sep).href)})`)
  .replace('const server = createServer(async (req, res) => {', 'const journal = [];\nconst server = createServer(async (req, res) => { journal.push({ at: Date.now(), method: req.method, url: req.url });');
assert.notEqual(instrumented, serverSource);
instrumented += '\nprocess.on("message", message => { if (message.kind === "reset") { sessions.clear(); journal.length = 0; } process.send?.({ id: message.id, journal: [...journal] }); });\nserver.on("listening", () => process.send?.({ ready: true }));\n';
const serverFile = path.join(root, 'instrumented-server.mjs'); await writeFile(serverFile, instrumented);
const server = fork(serverFile, { env: { ...process.env, PORT: '4399' }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
let serverError = ''; server.stderr.on('data', d => { serverError += d; });
await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Benchmark server startup timeout')), 10000); server.on('message', m => { if (m.ready) { clearTimeout(timer); resolve(); } }); server.once('exit', () => { clearTimeout(timer); reject(new Error(serverError)); }); });
const serverCall = kind => new Promise((resolve, reject) => { const id = randomUUID(); const timer = setTimeout(() => { server.off('message', receive); reject(new Error('Fixture IPC timeout')); }, 5000); const receive = m => { if (m.id === id) { clearTimeout(timer); server.off('message', receive); resolve(m.journal); } }; server.on('message', receive); server.send({ id, kind }); });
const manifest = { runId, startedAt: new Date().toISOString(), profileId, port, model: provider.settings.model, provider: new URL(provider.settings.baseUrl).hostname, jevProvider: provider.settings.jevProvider, node: process.version, platform: process.platform, rounds, tasks, codeHashes, serverSha256: sha(serverSource), modes: ['driver', 'advisory'], limits: { minutes: 4, actions: 35, budgetUsd: 0.6 }, rules: ['Original task prompts verbatim; no answers supplied to model.', 'Each cell uses a fresh task store and SDK session; synthetic fixture sessions reset.', 'Same real Chrome Profile, warm browser; serial execution with alternating mode and rotating task order.', 'Measure task start through agent drain and release; independent validation afterwards excluded.', 'Keep blocked, partial, timeout and failure cells; no human rescue or success-only reruns.', 'Compare complete product modes, including snapshot transport, helper prompting/thinking and fallback; not isolated model latency.', 'Do not compare numerically with historical six-tool article runs.'] };
manifest.gatewayRuntime = { protocolVersion: gatewayRuntime.protocolVersion, pid: gatewayRuntime.pid };
manifest.overlayCodeSha256 = sha(await readFile(path.join(repo,'dist/main/agent-overlay.js')));
const priorSummary = resumeId ? JSON.parse(await readFile(path.join(output, 'summary.json'), 'utf8')) : undefined;
if (priorSummary) {
  for (const key of ['runId', 'profileId', 'port', 'rounds', 'model', 'provider', 'jevProvider', 'tasks', 'codeHashes', 'serverSha256', 'gatewayRuntime', 'overlayCodeSha256', 'limits']) {
    assert.deepEqual(manifest[key], priorSummary.manifest[key], `Continuation conditions changed: ${key}`);
  }
  Object.assign(manifest, priorSummary.manifest);
  manifest.continuations = [...(manifest.continuations || []), { at: new Date().toISOString(), preservedCells: priorSummary.results.length, reason: 'Continue only unattempted cells after timer rejection; interrupted cell retained, no product runtime changes.' }];
}
await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
const results = priorSummary?.results || [];
const median = values => { const s = [...values].sort((a,b) => a-b); return s.length % 2 ? s[(s.length-1)/2] : (s[s.length/2-1] + s[s.length/2]) / 2; };
function aggregate() {
  return tasks.map(t => ({ id: t.id, name: t.name, ...Object.fromEntries(['driver','advisory'].map(mode => {
    const cells = results.filter(r => r.taskId === t.id && r.mode === mode), passed = cells.filter(r => r.grade === 'pass');
    return [mode, { runs: cells.length, passed: passed.length, medianMs: passed.length ? median(passed.map(r => r.elapsedMs)) : null, minMs: passed.length ? Math.min(...passed.map(r=>r.elapsedMs)) : null, maxMs: passed.length ? Math.max(...passed.map(r=>r.elapsedMs)) : null, allDurations: cells.map(r => ({ round:r.round, ms:r.elapsedMs, grade:r.grade, fallback:r.fallback, status:r.status })) }];
  })) }));
}
const escape = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function report() {
  const summary = aggregate();
  await writeFile(path.join(output, 'summary.json'), JSON.stringify({ manifest, completed: results.length, planned: rounds*tasks.length*2, summary, results }, null, 2));
  const rows = summary.map(r => { const d=r.driver,a=r.advisory; const time=v=>v===null?'—':(v/1000).toFixed(1)+' s'; return `<tr><td>${r.id} ${r.name}</td><td>${d.passed}/${d.runs}</td><td>${time(d.medianMs)}</td><td>${a.passed}/${a.runs}</td><td>${time(a.medianMs)}</td><td>${d.medianMs && a.medianMs ? ((1-d.medianMs/a.medianMs)*100).toFixed(1)+'%' : '—'}</td></tr>`; }).join('');
  const cells = results.map(r=>`<tr><td>${r.taskId} / ${r.round}</td><td>${r.mode}</td><td>${r.grade} / ${r.status}</td><td>${(r.elapsedMs/1000).toFixed(1)} s</td><td>${r.usage.jevActions||0}</td><td>${r.usage.helper?.calls||0}</td><td>${r.fallback?'是':'否'}</td><td><a href="${r.file}">记录</a></td></tr>`).join('');
  await writeFile(path.join(output, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jev × Garden Lab 复用任务评测</title><style>body{font:16px/1.7 system-ui;background:#f5f5f0;color:#182622;max-width:1180px;margin:48px auto;padding:0 24px}table{width:100%;border-collapse:collapse;background:white;margin:24px 0}th,td{padding:12px;border-bottom:1px solid #ddd;text-align:left}th{background:#e3ebe4}h1{font-size:32px}small{color:#52625b}a{color:#176749}.scroll{overflow:auto}</style><h1>Jev × Garden Lab</h1><p>复用原任务卡 · ${escape(provider.settings.model)} · 同一真实 Chrome · 两种执行方式</p><p>已完成 ${results.length} / ${rounds*tasks.length*2} 次。成功必须同时通过任务状态、答案和独立页面检查；失败耗时不混入成功中位数。</p><div class="scroll"><table><tr><th>任务</th><th>Jev 成功</th><th>成功中位数</th><th>原流程成功</th><th>成功中位数</th><th>耗时减少</th></tr>${rows}</table></div><p>少量本地受控样本，非网站通用性能结论。两种方式包含不同观察链路与主模型辅助方式，不能将差异全归因于 Jev 模型本身。无人工救场；需要人工时记录阻塞。SDK 估算费用不含 Jev 和直接文本辅助。</p><p><a href="manifest.json">条件和原任务</a> · <a href="summary.json">完整汇总</a></p><h2>全部运行</h2><div class="scroll"><table><tr><th>任务/轮次</th><th>方式</th><th>结果</th><th>耗时</th><th>Jev 操作</th><th>主模型辅助</th><th>启动 SDK</th><th>原始证据</th></tr>${cells}</table></div></html>`);
}
function jsonArrays(text) { const out=[]; for(let start=0;start<text.length;start++) if(text[start]==='[') { let depth=0,quoted=false,escaped=false; for(let end=start;end<text.length;end++) { const c=text[end]; if(quoted) { if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false; } else { if(c==='"')quoted=true;else if(c==='[')depth++;else if(c===']'&&--depth===0){try{out.push(JSON.parse(text.slice(start,end+1)));}catch{}break;} } } } return out; }
const truth = [['雷霆工作站',15999,2],['全画幅扫描仪',3699,3],['4K 专业显示器',2499,7],['人体工学椅',1899,0],['会议级摄像头',1599,11],['桌面监听音箱',1299,5],['降噪耳机 Pro',899,41],['便携 SSD 1TB',749,16],['USB-C 扩展坞',549,64],['电竞鼠标',459,0],['静音机械键盘',399,23],['智能护眼台灯',329,88]];
function grade(id, task, probe, answer, requests) {
  const clean=answer.replace(/[*`_]/g,''); let page=false, response=false;
  if(id==='T05'){page=probe?.feed?.length===12&&probe.feed.at(-1).includes('LIVE-512')&&requests.some(r=>r.url==='/api/feed?page=2');response=/12|十二/.test(clean)&&clean.includes('LIVE-512');}
  if(id==='T06'){page=probe?.products?.length===12&&requests.some(r=>r.url==='/api/products?page=2');response=jsonArrays(answer).some(a=>a.length===12&&a.every((p,i)=>p.name===truth[i][0]&&p.price===truth[i][1]&&p.stock===truth[i][2]));}
  if(id==='T15'){page=probe?.events?.length===5&&probe.events.at(-1).includes('evt-005')&&requests.some(r=>r.url==='/api/realtime-events');response=/5|五/.test(clean)&&clean.includes('evt-005')&&clean.includes('STREAM-721');}
  if(id==='T20'){page=probe?.checks?.length===10&&JSON.stringify(probe.checks.filter(r=>r[1]==='FAIL').map(r=>Number(r[0])))==='[3,6,9]'&&requests.filter(r=>r.url.startsWith('/api/flake-check?')).length>=10;response=/7|七/.test(clean)&&/3|三/.test(clean)&&/6|六/.test(clean)&&/9|九/.test(clean)&&/30\s*[%％]|三成/.test(clean)&&clean.includes('FLAKE-307');}
  if(id==='T08'){page=probe?.shadow?.includes('SHADOW-99')&&requests.some(r=>r.url==='/api/login'&&r.method==='POST');response=clean.includes('SHADOW-99');}
  if(id==='T18'){page=probe?.file?.name==='upload-token.txt'&&probe.file.size===36&&probe.upload?.includes('UPLOAD-448');response=clean.includes('upload-token.txt')&&clean.includes('36')&&clean.includes('UPLOAD-448');}
  return { grade: task.status==='completed'&&page&&response?'pass':page||response?'partial':'fail', page, answer:response };
}
let externalTakeover=false, infrastructureStop=false, activeTask, activeService;
const subscription=subscribeBrowserGatewayEvents({onEvent:event=>{const p=event.controlEvent?.profile;if(activeTask&&p?.ownerSessionId===activeTask.sessionId){if(event.controlEvent.reason==='user_takeover'&&activeTask.pending?.kind!=='handoff')externalTakeover=true;activeService.externalControl(activeTask.sessionId,p.ownership,p.sessionStatus,event.controlEvent.reason);}}});
await subscription.ready; await report();
console.log('BENCHMARK',JSON.stringify({output,planned:rounds*tasks.length*2,profileId,port}));
try {
  for(let round=1;round<=rounds;round++){
    const ordered=tasks.slice((round-1)*2).concat(tasks.slice(0,(round-1)*2));
    for(let index=0;index<ordered.length;index++) for(const mode of ((round+index)%2?['driver','advisory']:['advisory','driver'])){
      if (results.some(r => r.taskId === ordered[index].id && r.mode === mode && r.round === round)) continue;
      if(infrastructureStop)throw new Error('Gateway rejected a connection; stopped on the first rejection.');
      if(externalTakeover)throw new Error('User took over the allocated test browser; benchmark stopped.');
      const gatewayNow=await requestBrowserGateway({action:'ping'});assert.equal(gatewayNow.pid,gatewayRuntime.pid,'Gateway restarted mid-series.');assert.equal(gatewayNow.protocolVersion,gatewayRuntime.protocolVersion,'Gateway version changed mid-series.');
      for(const [f,hash] of Object.entries(codeHashes))assert.equal(sha(await readFile(path.join(repo,`dist/main/tasks/${f}.js`))),hash,'Runtime changed mid-series.');
      const state=await requestBrowserGateway({action:'status'});const p=state.state.profiles.find(p=>p.publicPort===port);assert.ok(!p.ownerSessionId||p.sessionStatus==='stopped','Test Profile occupied; stop series.');
      await serverCall('reset');
      const test=ordered[index],cell=`${test.id}-${mode}-r${round}`,store=new TaskStore(path.join(root,cell));
      store.data.settings={...store.data.settings,...provider.settings,jevEnabled:true,jevMode:mode,notifications:false};
      const browser=new WrapperBrowser(path.join(store.root,'artifacts'));
      const decisions=[],observations=[],tools=[];let workerStarted=false,lastEvent,validation,validationMs=0;
      for(const method of ['observe','observeFast']){const original=browser[method].bind(browser);browser[method]=async(...args)=>{const start=Date.now(),o=await original(...args);observations.push({at:o.at,method,url:o.url,snapshot:o.snapshot,elapsedMs:Date.now()-start});return o;};}
      const capture=async task=>{const start=Date.now();try{const r=await browser.fast.raw(task,'Runtime.evaluate',{expression:`JSON.stringify({url:location.href,feed:[...document.querySelectorAll('#feed li')].map(n=>n.innerText),products:[...document.querySelectorAll('.prod')].map(n=>n.innerText),events:[...document.querySelectorAll('#events li')].map(n=>n.innerText),checks:[...document.querySelectorAll('#flake-rows tr')].map(n=>[...n.cells].map(c=>c.innerText)),shadow:document.querySelector('bench-widget')?.shadowRoot?.textContent,upload:document.querySelector('#upload-result')?.innerText,file:(()=>{const f=document.querySelector('#token-file')?.files?.[0];return f?{name:f.name,size:f.size}:null})()})`,returnByValue:true});validation=JSON.parse(r.result.value);}catch(error){validation={error:String(error.message).slice(0,400)};}validationMs+=Date.now()-start;};
      const originalControl=browser.control.bind(browser);browser.control=async(task,action)=>{if(action==='complete'&&!validation)await capture(task);return originalControl(task,action);};
      const service=new TaskService(store,{browser,apiKey:()=>provider.apiKey,jevApiKey:()=>provider.jevApiKey,profileName:async()=>binding.profileName,prepareProfile:async()=>({port,name:binding.profileName}),changed:s=>{const e=s.tasks[0]?.events.at(-1);if(e&&e.id!==lastEvent){lastEvent=e.id;console.log(cell,e.kind,redact(e.text).slice(0,180));}},notify:()=>{},chooseJev:async(...args)=>{const d=await chooseJevAction(...args);decisions.push(d);return d;},worker:(task,start)=>{workerStarted=true;return fork(path.join(repo,'dist/main/tasks/worker.js'),[],{cwd:start.cwd,env:require('../dist/main/tasks/service').workerEnvironment(),execArgv:[],windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});}});
      const originalTool=service.handleTool.bind(service);service.handleTool=async(task,run,name,args)=>{const start=Date.now();try{const r=await originalTool(task,run,name,args);tools.push({name,args,ms:Date.now()-start,isError:r?.isError});return r;}catch(error){tools.push({name,args,ms:Date.now()-start,error:String(error.message)});if(/Session 不属于|AGENT_USER_IN_CONTROL|PROFILE_LEASE_CONFLICT|CONTROL_GENERATION_STALE/.test(String(error.message))){infrastructureStop=true;await service.control(task.id,'pause');}throw error;}};
      const originalTick=service.tick.bind(service);service.tick=async()=>{};
      if(test.id==='T18'){const file=path.join(bench,'fixtures/upload-token.txt');store.data.attachments.push({id:randomUUID(),name:'upload-token.txt',path:file,size:(await stat(file)).size});}
      const task=await service.create({profileId,prompt:test.prompt,authorization:'允许在本地靶场按任务要求进行测试登录、测试按钮操作和上传选定的虚构文本附件。',grant:{origin:'http://localhost:4399',effects:['submit'],maxActions:5},attachmentIds:store.data.attachments.map(f=>f.id),limits:manifest.limits});
      activeTask=task;activeService=service;
      // The setup Session is separate and ENDED before the actual task starts.
      // Do not pre-acquire an SDK task's daemon before its startup delay.
      task.port=port;const setup={...task,id:randomUUID(),sessionId:`pp-bench-setup-${randomUUID()}`};
      await browser.execute(setup,{kind:'open',value:'http://localhost:4399/',effect:'read',summary:'Benchmark setup: common initial page'});
      await originalControl(setup,'complete');
      const started=Date.now();service.tick=originalTick;await service.tick();
      while(Date.now()-started<255000&&(task.status==='running'||task.status==='queued'||service.runs.has(task.id)))await new Promise(r=>setTimeout(r,200));
      const elapsedMs=Date.now()-started-validationMs;
      const requests=await serverCall('journal');
      let answer=[task.result?.summary||'',...task.events.filter(e=>e.kind==='assistant').map(e=>e.text)].join('\n');
      for(const file of task.outputs||[])if(/\.(json|md|txt)$/.test(file.name))answer+='\n'+await readFile(file.path,'utf8');
      const graded=grade(test.id,task,validation,answer,requests);
      const result={taskId:test.id,name:test.name,mode,round,...graded,status:task.status,elapsedMs,validationMs,usage:task.usage,fallback:workerStarted,pending:task.pending,result:task.result,answerText:answer,validation,requests,decisions,observations,toolCalls:tools,receipts:task.receipts,events:task.events,file:`${cell}.json`};
      // Record outcome BEFORE cancellation cleanup. Never resume or rescue a blocked run.
      await writeFile(path.join(output,result.file),redact(JSON.stringify(result,null,2)));
      results.push({...result,observations:undefined,toolCalls:undefined,receipts:undefined,events:undefined,answerText:undefined,requests:undefined,decisions:undefined});
      console.log('CELL',JSON.stringify({cell,grade:result.grade,status:result.status,elapsedMs,fallback:workerStarted,jevActions:task.usage.jevActions||0,completed:results.length}));
      if(!['completed','partial','failed','cancelled'].includes(task.status)&&!externalTakeover)await service.control(task.id,'cancel');
      await service.close();activeTask=undefined;activeService=undefined;
      await report();
    }
  }
  console.log('COMPLETE',JSON.stringify({output,summary:aggregate()}));
}finally{
  subscription.close();
  if(activeService){if(activeTask&&!externalTakeover&&!['completed','partial','failed','cancelled'].includes(activeTask.status))await activeService.control(activeTask.id,'cancel');await activeService.close();}
  server.kill();await report();
}
