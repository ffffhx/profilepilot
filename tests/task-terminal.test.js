const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskTerminal, terminalEnvironment, terminalInvocation } = require('../dist/main/tasks/terminal');
const { TaskStore } = require('../dist/main/tasks/store');
const { TaskService } = require('../dist/main/tasks/service');

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pp-terminal-'));
  const terminal = new TaskTerminal(root);
  t.after(async () => { await terminal.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, terminal };
}
const run = (terminal, command, options = {}) => terminal.run('task-one', { command, summary: '验收终端', runtime: 'node', yield_ms: 10000, ...options });

test('real shell supports Unicode, paths with spaces, and failing exit codes', async t => {
  const { terminal } = fixture(t);
  const command = process.platform === 'win32' ? "[IO.File]::WriteAllText((Join-Path $PWD '中文 文件.txt'), '你好，终端'); Get-Content -Encoding utf8 -LiteralPath '中文 文件.txt'" : "printf '你好，终端' > '中文 文件.txt'; cat '中文 文件.txt'";
  const result = await run(terminal, command, { runtime: 'shell' });
  assert.equal(result.status, 'succeeded', result.stderr); assert.match(result.stdout, /你好，终端/);
  assert.equal(readFileSync(path.join(result.cwd, '中文 文件.txt'), 'utf8'), '你好，终端');
  const failed = await run(terminal, 'exit 7', { runtime: 'shell' });
  assert.equal(failed.status, 'failed'); assert.equal(failed.exit_code, 7);
});

test('node runtime bounds output and does not inherit model secrets or NODE_OPTIONS', async t => {
  const { terminal } = fixture(t);
  const env = terminalEnvironment({ PATH: 'path', HOME: 'home', ANTHROPIC_API_KEY: 'secret', OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1' });
  assert.deepEqual(env, { PATH: 'path', HOME: 'home' });
  const result = await run(terminal, "console.log('x'.repeat(100000) + '输出末尾'); console.error('stderr test'); console.log('node works');");
  assert.equal(result.status, 'succeeded'); assert.equal(result.truncated, true);
  assert.ok(result.stdout.length <= 24000); assert.match(result.stdout, /输出末尾\nnode works/); assert.match(result.stderr, /stderr test/);
});

test('macOS command construction uses Bash and no Windows quoting', () => {
  const call = terminalInvocation('darwin', 'shell', '/tmp/a b/test.sh', "printf '%s' '你好'");
  assert.equal(call.executable, '/bin/bash'); assert.deepEqual(call.args, ['--noprofile', '--norc', '/tmp/a b/test.sh']);
  assert.match(call.source, /^set -eo pipefail/); assert.match(call.source, /printf '%s' '你好'/);
});

test('process IDs and working directories are scoped to the owning task', async t => {
  const { terminal } = fixture(t);
  await assert.rejects(run(terminal, 'console.log(1)', { cwd: '..' }), /当前任务目录/);
  assert.throws(() => terminal.workspace('../outside'), /无效/);
  const result = await run(terminal, 'setInterval(() => {}, 1000)', { background: true, yield_ms: 0 });
  await assert.rejects(terminal.stop('task-two', { process_id: result.process_id }), /不属于当前任务/);
  assert.equal((await terminal.stop('task-one', { process_id: result.process_id })).status, 'stopped');
});

test('timeout kills a process tree including a child hosting an HTTP server', async t => {
  const { terminal } = fixture(t);
  const source = "const s=require('http').createServer((q,r)=>r.end('child'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port));";
  const command = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(source)}],{stdio:['ignore','inherit','inherit'],env:process.env}); setInterval(()=>{},1000);`;
  let result = await run(terminal, command, { timeout_ms: 1200, yield_ms: 500 });
  const port = Number(result.stdout.trim()); assert.ok(port > 0, result.stdout + result.stderr);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'child');
  result = await terminal.read('task-one', { process_id: result.process_id, wait_ms: 3000 });
  assert.equal(result.status, 'timed_out');
  await terminal.stopTask('task-one');
  await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }));
});

function serviceFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pp-terminal-service-'));
  const store = new TaskStore(root);
  const task = store.create({ profileId: 'fixture', prompt: '生成 HTML 并运行本地网页' }, 'fixture');
  const browser = { control: async () => {}, tabs: async () => [], observe: async () => { throw new Error('unexpected browser access'); } };
  const service = new TaskService(store, { browser, apiKey: () => '', prepareProfile: async () => ({ name: 'fixture' }), profileName: async () => 'fixture', changed: () => {}, notify: () => {} });
  service.tick = async () => {};
  const active = { started: Date.now(), stopped: false, chain: Promise.resolve(), repeat: '', repeatCount: 0 };
  task.status = 'running'; service.runs.set(task.id, active);
  t.after(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  const tool = async (name, args) => {
    const response = await service.handleTool(task, active, name, args);
    assert.equal(response.isError, false, response.content[0].text);
    try { return JSON.parse(response.content[0].text); } catch { return response.content[0].text; }
  };
  return { root, task, service, active, tool };
}

test('product tools export actual HTML, serve it, verify HTTP, finish and retain server until app close', async t => {
  const f = serviceFixture(t);
  const html = '<!doctype html><html lang="zh"><meta charset="utf-8"><h1>终端验收网页</h1></html>';
  const file = await f.tool('export_result', { name: '验收.html', format: 'html', text: html });
  assert.equal(file.name, '验收.html'); assert.equal(readFileSync(file.path, 'utf8'), html);
  const server = await f.tool('terminal_run', { summary: '启动本地预览', runtime: 'node', background: true, yield_ms: 700,
    command: `const fs=require('fs');fs.copyFileSync(${JSON.stringify(file.path)},'index.html');const s=require('http').createServer((q,r)=>{r.setHeader('content-type','text/html; charset=utf-8');r.end(fs.readFileSync('index.html'));});s.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+s.address().port));` });
  assert.equal(server.status, 'running'); const url = server.stdout.trim();
  const response = await fetch(url); assert.equal(response.status, 200); assert.equal(await response.text(), html);
  const verify = await f.tool('terminal_run', { summary: '验证 HTTP 与页面内容', runtime: 'node', yield_ms: 10000,
    command: `fetch(${JSON.stringify(url)}).then(async r=>{const t=await r.text();if(r.status!==200||!t.includes('终端验收网页'))process.exit(1);console.log('HTTP 200：终端验收网页');}).catch(e=>{console.error(e);process.exit(1)});` });
  assert.equal(verify.status, 'succeeded');
  await assert.rejects(f.service.handleTool(f.task, f.active, 'verify_account', { account: '终端验收网页', evidence: 'HTTP 200：终端验收网页' }), /账号核对/);
  await f.tool('finish', { status: 'completed', summary: `预览已启动：${url}`, evidence: ['HTTP 200：终端验收网页'], remaining: [] });
  await f.service.endRun(f.task, f.active);
  assert.equal(f.service.runs.size, 0); assert.equal(f.service.terminal.hasRunning(f.task.id), true);
  assert.equal((await fetch(url)).status, 200, 'Server survives SDK run completion');
  assert.throws(() => f.service.deleteTask(f.task.id), /后台服务/);
  await f.service.close();
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
});

test('pausing stops background processes and disallows further commands', async t => {
  const f = serviceFixture(t);
  const process = await f.tool('terminal_run', { summary: '后台测试', runtime: 'node', background: true, command: "setInterval(()=>{},1000)", yield_ms: 100 });
  await f.service.control(f.task.id, 'pause');
  await f.active.terminalStop;
  assert.equal(f.service.terminal.hasRunning(f.task.id), false);
  assert.equal((await f.service.terminal.read(f.task.id, { process_id: process.process_id, wait_ms: 0 })).status, 'stopped');
  await assert.rejects(f.service.handleTool(f.task, f.active, 'terminal_run', { command: 'throw 1' }), /停止/);
});

test('failed terminal output cannot be submitted as completed evidence', async t => {
  const f = serviceFixture(t);
  const result = await f.service.handleTool(f.task, f.active, 'terminal_run', { command: "console.log('NOT VERIFIED');process.exit(3)", summary: '失败验收', runtime: 'node', yield_ms: 10000 });
  assert.equal(result.isError, true);
  const finish = await f.service.handleTool(f.task, f.active, 'finish', { status: 'completed', summary: 'done', evidence: ['NOT VERIFIED'], remaining: [] });
  assert.equal(finish.isError, true); assert.equal(f.task.status, 'running');
});

test('archiving a completed task stops its server and allows workspace deletion', async t => {
  const f = serviceFixture(t);
  await f.tool('terminal_run', { summary: '归档清理', runtime: 'node', background: true, command: 'setInterval(()=>{},1000)', yield_ms: 100 });
  f.task.status = 'completed'; await f.service.endRun(f.task, f.active);
  assert.equal(f.service.terminal.hasRunning(f.task.id), true);
  await f.service.updateTaskMetadata(f.task.id, { archived: true });
  assert.equal(f.service.terminal.hasRunning(f.task.id), false);
  f.service.deleteTask(f.task.id);
  assert.equal(f.service.store.data.tasks.length, 0);
});

test('Jev delegates terminal requests to the full Agent before browser actions', async t => {
  const { runJevDriver } = require('../dist/main/tasks/jev-driver');
  const f = serviceFixture(t);
  const result = await runJevDriver({ task: f.task, signal: new AbortController().signal, current: () => true,
    tool: () => { throw new Error('unexpected browser action'); }, observe: () => { throw new Error('unexpected browser observation'); } });
  assert.match(result, /终端工具/);
});
