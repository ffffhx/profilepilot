// Explicit-target, installed-CLI acceptance. Creates only a local fixture tab.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
const profile = process.argv[2];
if (!profile?.startsWith('native:')) throw Error('Provide the explicitly authorized native Profile ID.');
const cli = path.join(os.homedir(), '.profilepilot/cli/profilepilot-cli.cjs');
const session = `acceptance-${randomUUID()}`;
const output = path.resolve('artifacts/session-review-20261022'); await mkdir(output, {recursive:true});
const invoke = async (args, expected = 0) => {
  let stdout='', stderr='', code=0;
  try { ({stdout,stderr} = await promisify(execFile)(process.execPath,[cli,'browser',...args],{windowsHide:true,timeout:40000,maxBuffer:8*1024*1024})); }
  catch(e) { stdout=e.stdout||''; stderr=e.stderr||''; code=e.code; }
  if (expected === null) assert.ok(code === 0 || code === 1,stderr || stdout);
  else assert.equal(code,expected,stderr || stdout);
  return JSON.parse((code===0 ? stdout : stderr).trim());
};
const prefix=['--profile',profile,'--session',session];
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(`<!doctype html><meta charset="utf-8"><title>ProfilePilot 本地回归检查</title>
<h1>ProfilePilot 本地回归检查</h1><p>此页仅验证控制接口，不提交外部表单。</p>
<label>验证文本<input aria-label="验证文本"></label><p><input id="other" aria-label="动态区域"></p><span id="tick">动态</span>
<style>@keyframes p{to{opacity:.5}}#tick{animation:p .2s infinite alternate}</style>
<script>setInterval(()=>{document.querySelector('#tick').textContent=Date.now();document.querySelector('#other').value=Date.now()},40)</script>`)});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let claimed=false;
try {
  const status=(await invoke(['status'])).result;
  const target=status.profiles.find(p=>p.profileId===profile);
  assert.ok(target?.connected); assert.ok(!target.ownerSessionId,'Target is occupied; no takeover is attempted.');
  await invoke([...prefix,'--controller','Codex','--task','ProfilePilot 本地回归检查','claim','--new-tab']); claimed=true;
  await invoke([...prefix,'open',`http://127.0.0.1:${server.address().port}`]);
  const visual=await invoke([...prefix,'observe','--output',path.join(output,'installed-default-dynamic.png')],null);
  if (!visual.ok) {
    assert.equal(visual.code,'NATIVE_RENDER_UNAVAILABLE');
    assert.equal(visual.recovery.actionOutcome,'not-applicable');
    assert.equal(visual.recovery.requiresUser,false);
  }
  const observed=visual.result || visual.partialResult;
  assert.equal(observed.availability.dom.status,'available'); assert.equal(observed.availability.coordinates.status,'unavailable');
  const actionFile=path.join(output,'installed-action.json');
  await writeFile(actionFile,JSON.stringify({kind:'fill',version:observed.version,ref:observed.fast.candidates.find(c=>c.label==='验证文本').ref,value:'中文 "literal" $()'}));
  const sent=await invoke([...prefix,'action','--params-file',actionFile]); assert.ok(sent.requestId);
  const stale=await invoke([...prefix,'action','--params-file',actionFile],75); assert.equal(stale.recovery.actionOutcome,'not-executed');
  const fresh=(await invoke([...prefix,'observe'])).result; assert.equal(fresh.fast.candidates.find(c=>c.label==='验证文本').value,'中文 "literal" $()');
  const conflict=await invoke(['--profile',profile,'--session',session+'-other','claim','--new-tab'],75);
  assert.equal(conflict.recovery.nextStep,'wait-for-owner');
  await invoke([...prefix,'complete']); claimed=false;
  const doctor=(await invoke(['--profile',profile,'doctor'])).result; assert.equal(doctor.status,'ok');
  const state=(await invoke(['status'])).result; assert.ok(!state.profiles.find(p=>p.profileId===profile).ownerSessionId);
  const result={status:'passed',platform:process.platform,profile,cli,buildId:doctor.cli.buildId,extensionVersion:target.extensionVersion,
    screenshot:observed.availability.screenshot.status, screenshotReason:observed.availability.screenshot.reason || null,
    checks:['installed CLI and live build match','actual Default extension',visual.ok?'fresh dynamic PNG + DOM':'capture unavailable preserves fresh DOM and control','Chinese literal JSON input','stale version rejected','second session rejected','owned session completed']};
  await writeFile(path.join(output,'installed-control-result.json'),JSON.stringify(result,null,2)); console.log(JSON.stringify(result));
} finally {
  if(claimed) await invoke([...prefix,'release']).catch(()=>{});
  server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
}
