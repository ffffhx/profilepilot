const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { LocalAppsService, debugTargets } = require('../dist/main/local-apps/service');
const { parseEnvironment, launchCommand, workerRequest } = require('../dist/main/local-apps/protocol');

const input = (cwd, changes = {}) => ({ name: '测试项目', mode: 'launch', cwd, command: 'npm run dev', environment: '', cdpPort: null, inspectPort: null, ...changes });
function temporary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-local-apps-'));
  return { root, clean() { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { const result = await fn(); if (result) return result; await delay(100); } throw new Error('condition timed out'); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

test('environment and shell commands preserve values and handle Windows/macOS invocation', () => {
  assert.deepEqual({ ...parseEnvironment('# comment\nA=中 文\nTOKEN=a=b\nEMPTY=') }, { A: '中 文', TOKEN: 'a=b', EMPTY: '' });
  assert.throws(() => parseEnvironment('NO VALUE'), /NAME=value/);
  const config = input('/project', { command: 'electron --remote-debugging-port={cdpPort} --inspect={inspectPort} .', cdpPort: 9333, inspectPort: 9230 });
  const windows = launchCommand(config, 'win32', { ComSpec: 'C:\\Windows\\cmd.exe' });
  assert.equal(windows.executable, 'C:\\Windows\\cmd.exe');
  assert.deepEqual(windows.args, ['/d', '/s', '/c', '"electron --remote-debugging-port=9333 --inspect=9230 ."']);
  assert.deepEqual(launchCommand(config, 'darwin', { SHELL: '/bin/zsh' }), { executable: '/bin/zsh', args: ['-lc', 'electron --remote-debugging-port=9333 --inspect=9230 .'] });
});

test('configuration validates ports, paths, identifiers and preserves project files', async () => {
  const temp = temporary();
  try {
    const service = new LocalAppsService(path.join(temp.root, 'store'), async () => new Set([9223]));
    await assert.rejects(service.save(input('relative')), /项目文件夹/);
    await assert.rejects(service.save(input(temp.root, { command: 'electron --inspect={inspectPort}' })), /主进程/);
    await assert.rejects(service.save(input(temp.root, { cdpPort: 9223 })), /浏览器 Profile/);
    await assert.rejects(service.save(input('', { mode: 'attach' })), /至少/);
    await assert.rejects(service.save(input(temp.root, { cdpPort: 9333, inspectPort: 9333 })), /不同/);
    const id = await service.save(input(temp.root, { cdpPort: 9333 }));
    await assert.rejects(service.save(input(temp.root, { inspectPort: 9333 })), /已分配/);
    await assert.rejects(service.save(input(temp.root, { id: '00000000-0000-4000-8000-000000000000' })), /不存在/);
    const reopened = new LocalAppsService(path.join(temp.root, 'store'));
    assert.equal(reopened.get(id).name, '测试项目');
    fs.writeFileSync(path.join(temp.root, 'keep.txt'), 'project');
    await reopened.remove(id);
    assert.equal(fs.readFileSync(path.join(temp.root, 'keep.txt'), 'utf8'), 'project');
    assert.equal((await reopened.list()).length, 0);
    fs.writeFileSync(path.join(temp.root, 'store/apps.json'), '{broken');
    assert.throws(() => new LocalAppsService(path.join(temp.root, 'store')), /原文件已保留/);
    assert.equal(fs.readFileSync(path.join(temp.root, 'store/apps.json'), 'utf8'), '{broken');
  } finally { temp.clean(); }
});

test('supervisor tracks a real process tree across service recreation, restarts and stops only its tree', { timeout: 35000 }, async () => {
  const temp = temporary(); const store = path.join(temp.root, 'store'); const service = new LocalAppsService(store);
  const project = path.join(temp.root, '中文 project'); fs.mkdirSync(project);
  const fixture = path.join(project, 'run.cjs');
  fs.writeFileSync(fixture, `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log('READY '+JSON.stringify({pid:process.pid,child:child.pid,value:process.env.PP_TEST_VALUE,runAsNode:process.env.ELECTRON_RUN_AS_NODE})); console.error('错误日志'); setInterval(()=>{},1000);`);
  let id;
  try {
    id = await service.save(input(project, { command: `"${process.execPath}" "${fixture}"`, environment: 'PP_TEST_VALUE=中文 value' }));
    await service.start(id);
    const log = await until(() => { const text = service.logs(id); return text.includes('READY') && text.includes('错误日志') ? text : ''; });
    const pids = JSON.parse(log.match(/READY (.+)/)[1]);
    assert.equal(pids.value, '中文 value'); assert.equal(pids.runAsNode, undefined);
    assert.ok(alive(pids.pid)); assert.ok(alive(pids.child));
    const record = JSON.parse(fs.readFileSync(path.join(store, `${id}.runtime.json`), 'utf8'));
    await assert.rejects(workerRequest({ ...record, token: 'wrong' }, 'stop'), /身份/);
    const reopened = new LocalAppsService(store);
    assert.equal((await reopened.list())[0].runtime.status, 'running');
    await assert.rejects(reopened.start(id), /先停止/);
    await assert.rejects(reopened.remove(id), /先停止/);
    await reopened.restart(id);
    await until(() => !alive(pids.pid) && !alive(pids.child));
    const newLog = await until(() => { const text = reopened.logs(id); return text.includes('READY') ? text : ''; });
    const next = JSON.parse(newLog.match(/READY (.+)/)[1]);
    assert.notEqual(next.pid, pids.pid);
    await reopened.stop(id);
    await until(() => !alive(next.pid) && !alive(next.child));
    assert.equal((await reopened.list())[0].runtime.status, 'stopped');
    await reopened.remove(id); id = undefined;
  } finally { if (id) await service.stop(id).catch(() => {}); await delay(500); temp.clean(); }
});

test('debug discovery supports multiple windows and inspector while rejecting remote endpoints; attach never owns the process', async () => {
  const temp = temporary(); let debugPort;
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([
      { id: 'window-1', type: 'page', title: '主窗口', url: 'file:///index.html', webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort}/devtools/page/one` },
      { id: 'window-2', type: 'webview', title: '设置窗口', webSocketDebuggerUrl: `ws://localhost:${debugPort}/devtools/page/two` },
      { id: 'main', type: 'node', title: 'main.js', webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort}/main` },
      { id: 'remote', type: 'page', webSocketDebuggerUrl: `ws://example.com:${debugPort}/attack` },
      { id: 'other-port', type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:1/attack` }
    ]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); debugPort = server.address().port;
  try {
    assert.equal((await debugTargets(debugPort, 'renderer')).length, 2);
    assert.equal((await debugTargets(debugPort, 'main')).length, 1);
    const service = new LocalAppsService(path.join(temp.root, 'store'));
    const launch = await service.save(input(temp.root, { cdpPort: debugPort }));
    await assert.rejects(service.start(launch), /已被占用/); await service.remove(launch);
    const id = await service.save(input('', { mode: 'attach', cdpPort: debugPort }));
    assert.equal((await service.list())[0].runtime.status, 'running');
    assert.match(await service.debuggerUrl(id, 'renderer', 'window-1'), /^devtools:\/\/devtools\/bundled\/inspector.html\?ws=/);
    await assert.rejects(service.debuggerUrl(id, 'renderer', 'remote'), /已关闭/);
    await assert.rejects(service.stop(id), /外部/);
    await assert.rejects(service.start(id), /已有应用/);
    await service.remove(id); assert.equal(server.listening, true);
  } finally { await new Promise(resolve => server.close(resolve)); temp.clean(); }
});

test('applications survive the launching manager process exiting and can be adopted and stopped', { timeout: 25000 }, async () => {
  const temp = temporary(); const store = path.join(temp.root, 'store');
  const service = new LocalAppsService(store); let id;
  try {
    const fixture = path.join(temp.root, 'alive.cjs');
    fs.writeFileSync(fixture, 'console.log("DETACHED_READY"); setInterval(()=>{},1000);');
    id = await service.save(input(temp.root, { command: `"${process.execPath}" "${fixture}"` }));
    const starter = path.join(temp.root, 'start.cjs');
    fs.writeFileSync(starter, `const {LocalAppsService}=require(${JSON.stringify(require.resolve('../dist/main/local-apps/service'))}); new LocalAppsService(${JSON.stringify(store)}).start(${JSON.stringify(id)}).then(()=>console.log('manager done')).catch(e=>{console.error(e);process.exitCode=1});`);
    const { stdout } = await promisify(execFile)(process.execPath, [starter], { windowsHide: true, timeout: 10000 });
    assert.match(stdout, /manager done/);
    await until(() => service.logs(id).includes('DETACHED_READY'));
    const state = (await service.list())[0]; assert.equal(state.runtime.status, 'running');
    assert.ok(alive(state.runtime.pid));
    await service.stop(id); assert.equal((await service.list())[0].runtime.status, 'stopped');
  } finally { if (id) await service.stop(id).catch(() => {}); await delay(500); temp.clean(); }
});

test('failed launch reports its exit code and logs and remains editable', { timeout: 15000 }, async () => {
  const temp = temporary(); const service = new LocalAppsService(path.join(temp.root, 'store')); let id;
  try {
    const fixture = path.join(temp.root, 'fail.cjs'); fs.writeFileSync(fixture, 'console.error("fixture startup failed"); process.exit(7);');
    id = await service.save(input(temp.root, { command: `"${process.execPath}" "${fixture}"` }));
    await service.start(id).catch(error => assert.match(error.message, /退出码 7/));
    const view = await until(async () => { const app = (await service.list())[0]; return app.runtime.status === 'failed' ? app : null; });
    assert.equal(view.runtime.exitCode, 7); assert.match(service.logs(id), /fixture startup failed/);
    await service.save(input(temp.root, { id, name: 'fixed project' }));
    assert.equal(service.get(id).name, 'fixed project');
  } finally { if (id) await service.stop(id).catch(() => {}); await delay(500); temp.clean(); }
});

test('native service registration matches process and listener without connecting, starting or stopping the existing service', { timeout: 20000 }, async () => {
  const temp = temporary(); let connections = 0;
  const server = require('node:net').createServer(socket => { connections++; socket.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const service = new LocalAppsService(path.join(temp.root, 'store'));
  try {
    const logPath = path.join(temp.root, 'native.log'); fs.writeFileSync(logPath, 'native service log');
    const config = input(temp.root, { mode: 'service', servicePort: server.address().port, serviceProcess: process.execPath, logPath, command: 'exit 9' });
    await assert.rejects(service.save({ ...config, serviceProcess: 'relative.exe' }), /完整程序/);
    const id = await service.save(config);
    const state = (await service.list())[0];
    assert.equal(state.runtime.status, 'running'); assert.equal(state.runtime.pid, process.pid);
    assert.equal(service.logs(id), 'native service log');
    assert.equal(state.debug.targets.length, 0);
    await service.start(id); // Already running: must not execute the failing startup command.
    assert.equal(fs.existsSync(path.join(temp.root, 'store', `${id}.runtime.json`)), false);
    await assert.rejects(service.stop(id), /外部/);
    await assert.rejects(service.restart(id), /外部/);
    await service.save({ ...config, id, serviceProcess: path.join(temp.root, 'other-app.exe') });
    assert.equal((await service.list())[0].runtime.status, 'stopped');
    await assert.rejects(service.start(id), /已被占用/);
    await service.remove(id);
    assert.equal(server.listening, true); assert.equal(connections, 0);
  } finally { await new Promise(resolve => server.close(resolve)); temp.clean(); }
});
