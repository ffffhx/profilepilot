const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GpuiService } = require('../dist/main/gpui/service');
const { GpuiMcpClient, toolData } = require('../dist/main/gpui/mcp');
const { runGpuiCli } = require('../dist/main/gpui/cli');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ppilot-gpui-test-'));
  const apps = [1, 2].map(pid => ({ target_id: 'app-' + pid, app_id: 'demo', app_name: 'Demo', pid }));
  const nodes = { button: { id: 'button', bounds: { x: 0, y: 0, width: 80, height: 32 }, label: 'Add' } };
  const calls = [], clients = [], guards = [];
  let failTool, pending, occupied = false;
  const options = { directory, defaultBackend: process.execPath, occupied: () => occupied,
    guardFactory(callbacks) { guards.push(callbacks); return { sync() { callbacks.onStatus({ status: 'guard-unavailable' }); queueMicrotask(() => callbacks.onStatus({ status: 'guard-active' })); }, dispose() {} }; },
    backendFactory(_exe, onClose) {
      const client = { selected: undefined, closed: false, async start() {}, close() { this.closed = true; onClose(); }, async call(name, args = {}) {
        if (this.closed) throw Object.assign(new Error('closed'), { code: 'GPUI_DISCONNECTED' });
        calls.push({ name, args, target: this.selected });
        if (failTool === name) throw Object.assign(new Error('uncertain'), { code: 'GPUI_OUTCOME_UNKNOWN' });
        if (pending?.name === name) await pending.promise;
        let data;
        if (name === 'list_apps') data = { apps };
        else if (name === 'select_app') { this.selected = args.target_id; data = { selected: apps.find(app => app.target_id === args.target_id) }; }
        else if (name === 'ping') data = { protocol_version: 14 };
        else if (name === 'get_ui_tree') data = { nodes: structuredClone(nodes), roots: ['button'], generation: 1 };
        else data = { ok: true };
        return { structuredContent: data };
      } }; clients.push(client); return client;
    }
  };
  const service = new GpuiService(options);
  t.after(() => { service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const execute = (method, extra = {}) => service.execute({ action: 'gpui', method, session: 'task', ...extra });
  return { service, execute, apps, nodes, calls, clients, guards, options, setFail: name => failTool = name, occupy: () => occupied = true,
    defer(name) { let resolve; pending = { name, promise: new Promise(r => resolve = r) }; return () => { resolve(); pending = undefined; }; } };
}
test('default GPUI feedback yields a usable next observation without a separate snapshot', async t => {
  const f=fixture(t);await f.execute('claim',{target:'app-1'});
  const initial=await f.execute('snapshot'), started=Date.now();
  const first=await f.execute('call',{tool:'click_element',params:{id:'button'},observation:initial.observation});
  assert.ok(Date.now()-started>=450);
  assert.equal(first.actionOutcome,'completed');assert.equal(first.observationStatus,'available');
  assert.notEqual(first.observation.version,initial.observation);assert.equal(first.observation.tree.nodes.button.label,'Add');
  const second=await f.execute('call',{tool:'click_element',params:{id:'button'},observation:first.observation.version});
  assert.equal(second.observationStatus,'available');
  assert.equal(f.calls.filter(c=>c.name==='click_element').length,2);
});

test('GPUI post-input read failure discards refs without replaying input', async t => {
  const f=fixture(t);await f.execute('claim',{target:'app-1'});const initial=await f.execute('snapshot');
  const client=f.clients.at(-1), call=client.call.bind(client);
  client.call=async(name,args)=>{const result=await call(name,args);if(name==='click_element')f.setFail('get_ui_tree');return result;};
  const result=await f.execute('call',{tool:'click_element',params:{id:'button'},observation:initial.observation});
  assert.equal(result.actionOutcome,'completed');assert.equal(result.observationStatus,'unavailable');
  assert.equal(result.observation,undefined);assert.equal(result.requiresObservation,true);
  assert.equal(f.calls.filter(c=>c.name==='click_element').length,1);
  await assert.rejects(f.execute('call',{tool:'click_element',params:{id:'button'},observation:initial.observation}),{code:'GPUI_STALE_OBSERVATION'});
});

test('GPUI takeover during settle cancels feedback; opt-out does not request a post-input tree', async t => {
  const f=fixture(t);await f.execute('claim',{target:'app-1'});let initial=await f.execute('snapshot');
  const before=f.calls.length;
  const skipped=await f.execute('call',{tool:'click_element',params:{id:'button'},observation:initial.observation,observeAfter:false});
  assert.equal(skipped.requiresObservation,true);
  assert.deepEqual(f.calls.slice(before).map(c=>c.name),['get_ui_tree','click_element']);
  initial=await f.execute('snapshot');
  const client=f.clients.at(-1),call=client.call.bind(client);
  client.call=async(name,args)=>{const result=await call(name,args);if(name==='click_element')setTimeout(()=>f.guards[0].onClick({pid:1}),20);return result;};
  const result=await f.execute('call',{tool:'click_element',params:{id:'button'},observation:initial.observation});
  assert.equal(result.actionOutcome,'completed');assert.equal(result.observationStatus,'unavailable');
  assert.equal(f.service.status().sessions[0].state,'paused');
});

test('GPUI CLI forwards no-observe only for call', async () => {
  let command;const io={stdout:{write(){}},stderr:{write(){}}};
  const request=async c=>{command=c;return {ok:true,data:{}};};
  assert.equal(await runGpuiCli(['call','--session','task','--tool','keyboard','--no-observe'],request,io),0);
  assert.equal(command.observeAfter,false);
  assert.equal(await runGpuiCli(['snapshot','--session','task','--no-observe'],request,io),2);
});

test('two GPUI instances retain independent selection; observation is consumed once', async t => {
  const f = fixture(t); await f.execute('claim', { target: 'app-1' }); await f.execute('claim', { target: 'app-2', session: 'other' });
  const { observation } = await f.execute('snapshot');
  await f.execute('call', { tool: 'click_element', params: { id: 'button' }, observation });
  await assert.rejects(f.execute('call', { tool: 'click_element', params: { id: 'button' }, observation }), { code: 'GPUI_STALE_OBSERVATION' });
  assert.equal(f.calls.find(call => call.name === 'click_element').target, 'app-1');
  assert.equal(f.calls.filter(call => call.name === 'click_element').length, 1);
});
test('user click revokes inflight read; CLI cannot resume or release a paused reservation', async t => {
  const f = fixture(t); await f.execute('claim', { target: 'app-1' });
  const release = f.defer('get_ui_tree'); const read = f.execute('snapshot');
  f.guards[0].onClick({ pid: 1 }); release();
  await assert.rejects(read, { code: 'GPUI_INTERRUPTED' });
  for (const method of ['resume', 'release', 'complete', 'snapshot']) await assert.rejects(f.execute(method), { code: 'GPUI_PAUSED' });
  await assert.rejects(f.execute('claim', { target: 'app-1', session: 'another' }), { code: 'GPUI_OCCUPIED' });
  const before = f.service.status().sessions[0];
  await assert.rejects(f.service.control('return', 'task', before.revision - 1), { code: 'GPUI_STALE_CONTROL' });
  await f.service.control('return', 'task', before.revision);
  assert.equal(f.service.status().sessions[0].state, 'active');
});
test('layout changes reject input; timeout pauses without replay', async t => {
  const f = fixture(t); await f.execute('claim', { target: 'app-1' });
  let snapshot = await f.execute('snapshot'); f.nodes.button.bounds.x = 40;
  await assert.rejects(f.execute('call', { tool: 'click_element', params: { id: 'button' }, observation: snapshot.observation }), { code: 'GPUI_STALE_OBSERVATION' });
  assert.equal(f.calls.filter(call => call.name === 'click_element').length, 0);
  snapshot = await f.execute('snapshot'); f.setFail('click_element');
  await assert.rejects(f.execute('call', { tool: 'click_element', params: { id: 'button' }, observation: snapshot.observation }), { code: 'GPUI_OUTCOME_UNKNOWN' });
  assert.equal(f.service.status().sessions[0].state, 'paused');
  assert.equal(f.calls.filter(call => call.name === 'click_element').length, 1);
});
test('paused ownership survives service restart and cross-route occupation blocks activation', async t => {
  const f = fixture(t); await f.execute('claim', { target: 'app-1' }); f.service.close();
  const restored = new GpuiService(f.options); t.after(() => restored.close());
  assert.equal(restored.status().sessions[0].state, 'paused'); assert.equal(restored.reserved(1), true);
  f.occupy(); await assert.rejects(restored.control('return', 'task', 1), { code: 'GPUI_OCCUPIED' });
});
test('raw target switching and arbitrary application commands are not passed through', async t => {
  const f = fixture(t); await f.execute('claim', { target: 'app-1' });
  for (const tool of ['select_app', 'execute_application_command', 'preview_live_document']) await assert.rejects(f.execute('call', { tool }), { code: 'GPUI_TOOL_UNSUPPORTED' });
});
test('MCP transport preserves fragmented UTF-8, large IDs as strings, and fails closed on timeout', async t => {
  const script = `let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;let n;while((n=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(!m.id)continue;if(m.params?.name==='timeout')continue;const result=m.method==='initialize'?{capabilities:{tools:{}}}:{structuredContent:{label:'中文',target_id:'demo-ffffffffffffffff'}};const buf=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');for(let i=0;i<buf.length;i++)process.stdout.write(buf.subarray(i,i+1));}});`;
  const client = new GpuiMcpClient(process.execPath, { args: ['-e', script], timeoutMs: 500 }); t.after(() => client.close());
  assert.deepEqual(toolData(await client.call('ping')), { label: '中文', target_id: 'demo-ffffffffffffffff' });
  await assert.rejects(client.call('timeout'), { code: 'GPUI_OUTCOME_UNKNOWN' });
  await assert.rejects(client.call('ping'), { code: 'GPUI_DISCONNECTED' });
});
test('CLI rejects unknown flags before connecting and propagates paused exit code', async () => {
  const io = { stdout: { write() {} }, stderr: { write() {} } }; let called = false;
  assert.equal(await runGpuiCli(['claim', '--unsafe'], async () => { called = true; }, io), 2); assert.equal(called, false);
  assert.equal(await runGpuiCli(['snapshot', '--session', 'task'], async () => ({ ok: false, error: { code: 'GPUI_PAUSED', message: 'paused' } }), io), 75);
});

async function consentFixture(t) {
  const f = fixture(t);
  await f.execute('claim', { target: 'app-1' }); await f.execute('handoff');
  return { ...f, pauseId: f.service.status().sessions[0].pauseId };
}
test('explicit CLI return re-arms the guard and requires a fresh observation; concurrent replay fails', async t => {
  const f = await consentFixture(t);
  const outcomes = await Promise.allSettled([f.execute('return-control', { pauseId: f.pauseId }), f.execute('return-control', { pauseId: f.pauseId })]);
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['fulfilled', 'rejected']);
  assert.equal(outcomes[1].reason.code, 'GPUI_STALE_CONTROL');
  assert.equal(f.service.status().sessions[0].inputGuard, 'active');
  assert.equal(f.guards.length, 2);
  await assert.rejects(f.execute('call', { tool: 'click_element', params: { id: 'button' } }), { code: 'GPUI_STALE_OBSERVATION' });
  const snapshot = await f.execute('snapshot');
  await f.execute('call', { tool: 'click_element', params: { id: 'button' }, observation: snapshot.observation });
});
test('another user takeover invalidates old return requests and retains the paused reservation', async t => {
  const f = await consentFixture(t), paused = f.service.status().sessions[0];
  await f.service.control('takeover', paused.name, paused.revision);
  await assert.rejects(f.execute('return-control', { pauseId: f.pauseId }), { code: 'GPUI_STALE_CONTROL' });
  await assert.rejects(f.execute('resume'), { code: 'GPUI_PAUSED' });
  assert.equal(f.service.reserved(1), true);
});
test('an old return request cannot be retried after failed activation', async t => {
  const f = await consentFixture(t); f.occupy();
  await assert.rejects(f.execute('return-control', { pauseId: f.pauseId }), { code: 'GPUI_OCCUPIED' });
  await assert.rejects(f.execute('return-control', { pauseId: f.pauseId }), { code: 'GPUI_STALE_CONTROL' });
  assert.equal(f.service.status().sessions[0].state, 'paused');
});
test('CLI requires explicit return and a valid pause ID before connecting', async t => {
  const f = await consentFixture(t);
  const io = { stdout: { write() {} }, stderr: { write() {} } };
  let calls = 0;
  const request = async command => { calls++; return { ok: true, data: await f.service.execute(command) }; };
  for (const flag of ['--force', '--user-consented']) assert.equal(await runGpuiCli(['resume', '--session', 'task', flag], request, io), 2);
  assert.equal(calls, 0);
  assert.equal(await runGpuiCli(['return-control', '--session', 'task'], request, io), 2);
  assert.equal(await runGpuiCli(['return-control', '--session', 'task', '--pause-id', 'invalid'], request, io), 2);
  assert.equal(calls, 0);
  await assert.rejects(f.execute('return-control'), { code: 'GPUI_ARGUMENT' });
  assert.equal(await runGpuiCli(['return-control', '--session', 'task', '--pause-id', f.pauseId], request, io), 0);
  assert.equal(calls, 1);
});
test('pause IDs cannot cross sessions or service restarts', async t => {
  const f = await consentFixture(t);
  await f.execute('claim', { session: 'other', target: 'app-2' }); await f.execute('handoff', { session: 'other' });
  await assert.rejects(f.execute('return-control', { session: 'other', pauseId: f.pauseId }), { code: 'GPUI_STALE_CONTROL' });
  f.service.close(); const restored = new GpuiService(f.options); t.after(() => restored.close());
  await assert.rejects(restored.execute({ action: 'gpui', method: 'return-control', session: 'task', pauseId: f.pauseId }), { code: 'GPUI_STALE_CONTROL' });
});
test('return waits for an inflight interrupted request to settle', async t => {
  const f = fixture(t); await f.execute('claim', { target: 'app-1' });
  const release = f.defer('get_ui_tree'), read = f.execute('snapshot');
  f.guards[0].onClick({ pid: 1 }); const pauseId = f.service.status().sessions[0].pauseId;
  await assert.rejects(f.execute('return-control', { pauseId }), { code: 'GPUI_BUSY' });
  release(); await assert.rejects(read, { code: 'GPUI_INTERRUPTED' });
  await f.execute('return-control', { pauseId });
});
