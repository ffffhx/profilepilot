const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { resolveAppRuntime } = require('../dist/main/local-apps/runtime');
const { processRuntimeFromSnapshot, appProcessPaths } = require('../dist/main/local-apps/service-runtime');
const { probeDebugPort } = require('../dist/main/local-apps/service');
const idle = { status: 'stopped', pid: null, startedAt: null, exitCode: null, error: '' };
const config = { mode: 'launch', cwd: 'C:\\Projects\\My App', command: '"C:\\Apps\\My App.exe" --remote-debugging-port={cdpPort}', cdpPort: 9333, inspectPort: null };
const proc = (commandLine, changes = {}) => ({ pid: 123, parentPid: 1, name: 'My App.exe', commandLine, executablePath: null, startedAt: null, ...changes });

test('all modes use live evidence and expose lifecycle controls only for owned processes', () => {
  for (const mode of ['launch', 'attach', 'service']) {
    const state = resolveAppRuntime({ ...config, mode }, idle, { ...idle, status: 'running', pid: 123 }, []);
    assert.equal(state.runtime.status, 'running');
    assert.equal(state.managed, false);
    assert.deepEqual(state.controls, { start: false, stop: false, restart: false });
    const unknown = resolveAppRuntime({ ...config, mode }, idle, { ...idle, status: 'unknown' }, []);
    assert.equal(unknown.runtime.status, 'unknown');
    assert.equal(unknown.controls.start, false);
  }
  const managed = resolveAppRuntime(config, { ...idle, status: 'running', pid: 456 }, idle, ['offline']);
  assert.equal(managed.runtime.status, 'running');
  assert.equal(managed.controls.stop, true);
  assert.match(managed.runtime.statusDetail, /调试连接尚未就绪/);
});

test('external debug evidence overrides old stopped/failed records and manager disconnections', () => {
  for (const status of ['stopped', 'failed', 'unknown']) {
    const state = resolveAppRuntime(config, { ...idle, status, error: 'stale failure' }, idle, ['connected']);
    assert.equal(state.runtime.status, 'running');
    assert.equal(state.runtime.error, '');
    assert.equal(state.controls.stop, false);
    assert.equal(state.controls.start, false);
  }
  assert.equal(resolveAppRuntime(config, idle, idle, ['unknown']).runtime.status, 'unknown');
  assert.equal(resolveAppRuntime(config, idle, idle, ['offline']).runtime.status, 'stopped');
  assert.equal(resolveAppRuntime(config, { ...idle, status: 'failed', exitCode: 7 }, idle, ['offline']).runtime.exitCode, 7);
});

test('external Windows executable is detected without a debug port; helpers and similarly named paths do not match', () => {
  const observed = processRuntimeFromSnapshot(config, { tcp: [], processes: [proc('"c:/apps/my app.exe"')] }, 'win32');
  assert.equal(observed.status, 'running');
  for (const command of ['"C:\\Apps\\My App.exe.bak"', '"C:\\Other\\My App.exe"', '"C:\\Apps\\My App.exe" --type=renderer']) {
    assert.equal(processRuntimeFromSnapshot(config, { tcp: [], processes: [proc(command)] }, 'win32').status, 'stopped');
  }
  assert.equal(processRuntimeFromSnapshot(config, { tcp: [], processes: [proc('My App.exe') ] }, 'win32').status, 'unknown');
  assert.equal(processRuntimeFromSnapshot(config, { tcp: [], processes: [], processesAvailable: false }, 'win32').status, 'unknown');
  assert.equal(processRuntimeFromSnapshot(config, { tcp: [], processes: [], tcpAvailable: false }, 'win32').status, 'unknown');
  assert.equal(processRuntimeFromSnapshot(config, { tcp: [], processes: [proc('cmd.exe /c "C:\\Apps\\My App.exe"', { name: 'cmd.exe' })] }, 'win32').status, 'stopped', 'a shell containing a launch command is not the actual app');
});

test('macOS bundles and project Electron executables preserve paths with spaces', () => {
  const mac = { ...config, cwd: '/Users/test/My Project', command: 'open "/Applications/My App.app"' };
  assert.equal(processRuntimeFromSnapshot(mac, { tcp: [], processes: [proc('/Applications/My App.app/Contents/MacOS/My App')] }, 'darwin').status, 'running');
  const project = { ...mac, command: 'npm run dev' };
  assert.equal(processRuntimeFromSnapshot(project, { tcp: [], processes: [proc('/Users/test/My Project/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .')] }, 'darwin').status, 'running');
  assert.ok(!appProcessPaths({ ...config, command: '"C:\\Program Files\\nodejs\\node.exe" script.js' }, 'win32').includes('C:\\Program Files\\nodejs\\node.exe'));
});

test('a closed debug port differs from occupied invalid/empty/timed-out endpoints', async () => {
  let payload = 'not JSON';
  let hang = false;
  const server = http.createServer((_request, response) => { if (!hang) response.end(payload); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal((await probeDebugPort(port, 'renderer')).state, 'unknown');
    payload = '[]';
    assert.equal((await probeDebugPort(port, 'renderer')).state, 'unknown');
    payload = JSON.stringify([{ id: 'window', type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/window` }]);
    assert.equal((await probeDebugPort(port, 'renderer')).state, 'connected');
    hang = true;
    assert.equal((await probeDebugPort(port, 'renderer')).state, 'unknown');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  assert.equal((await probeDebugPort(port, 'renderer')).state, 'offline');
});
