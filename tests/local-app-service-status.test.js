const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTsModule } = require('./helpers/load-ts-module');
const { windowsServiceRuntime } = require('../dist/main/local-apps/service-runtime');
const config = { servicePort: 47632, serviceProcess: 'C:\\Apps\\ClipRelay\\cliprelay.ps1' };
const listener = { pid: 123, localPort: 47632, state: 'Listen' };
const processInfo = { pid: 123, name: 'powershell.exe', commandLine: 'powershell.exe', executablePath: null, startedAt: '2026-10-07T14:43:01.517Z' };

test('Windows listener with a hidden command line is unconfirmed, not stopped or verified running', () => {
  const state = windowsServiceRuntime(config, { tcp: [listener], processes: [processInfo] });
  assert.equal(state.status, 'unknown');
  assert.equal(state.pid, null);
  assert.match(state.statusDetail, /正在监听/);
  for (const commandLine of ['', 'C:\\Windows\\powershell.exe']) {
    assert.equal(windowsServiceRuntime(config, { tcp: [listener], processes: [{ ...processInfo, commandLine, executablePath: commandLine || null }] }).status, 'unknown');
  }
  assert.equal(windowsServiceRuntime(config, { tcp: [listener], processes: [] }).status, 'unknown');
});

test('Windows distinguishes a running process from its listening readiness', () => {
  const matching = { ...processInfo, commandLine: 'powershell.exe -File "C:\\Apps\\ClipRelay\\cliprelay.ps1"' };
  const state = windowsServiceRuntime(config, { tcp: [listener], processes: [matching] });
  assert.equal(state.status, 'running');
  assert.equal(state.pid, 123);
  assert.equal(state.startedAt, matching.startedAt);
  assert.equal(state.serviceReady, true);
  const withoutListener = windowsServiceRuntime(config, { tcp: [], processes: [matching] });
  assert.equal(withoutListener.status, 'running');
  assert.equal(withoutListener.serviceReady, false);
  assert.equal(windowsServiceRuntime(config, { tcp: [{ ...listener, state: 'Established' }], processes: [matching] }).serviceReady, false);
  assert.equal(windowsServiceRuntime(config, { tcp: [listener], processes: [{ ...processInfo, commandLine: 'powershell.exe -File "C:\\Apps\\other.ps1"' }] }).status, 'stopped');
});

test('an unconfirmed service cannot be started a second time', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-service-status-'));
  const { LocalAppsService } = loadTsModule('src/main/local-apps/service.ts', { stubs: {
    './service-runtime': { processRuntime: async () => ({ status: 'unknown' }), invalidateProcessRuntime() {} }
  } });
  try {
    const service = new LocalAppsService(path.join(root, 'store'));
    const id = await service.save({ name: 'Service', cwd: root, mode: 'service', command: 'must-not-run', environment: '', cdpPort: null, inspectPort: null, servicePort: 47632, serviceProcess: path.join(root, 'app.ps1') });
    assert.equal((await service.list())[0].runtime.status, 'unknown');
    await assert.rejects(service.start(id), /避免重复启动/);
    assert.equal(fs.existsSync(path.join(root, 'store', `${id}.launch.json`)), false);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('macOS keeps lsof/ps detection and distinguishes missing process information', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  let psResult = '123 /Applications/Service.app/Contents/MacOS/Service';
  let listening = true;
  const calls = [];
  const { serviceRuntime, invalidateProcessRuntime } = loadTsModule('src/main/local-apps/service-runtime.ts', { stubs: {
    'node:util': { promisify: () => async executable => {
      calls.push(executable);
      if (executable === 'lsof') {
        if (!listening) throw Object.assign(new Error('No listeners'), { code: 1 });
        return { stdout: 'p123\n' };
      }
      return { stdout: psResult };
    } }
  } });
  const input = { mode: 'service', servicePort: 47632, serviceProcess: '/Applications/Service.app/Contents/MacOS/Service' };
  assert.equal((await serviceRuntime(input)).status, 'running');
  psResult = '';
  invalidateProcessRuntime();
  assert.equal((await serviceRuntime(input)).status, 'unknown');
  listening = false;
  invalidateProcessRuntime();
  assert.equal((await serviceRuntime(input)).status, 'stopped');
  assert.ok(calls.every(value => ['lsof', 'ps'].includes(value)));
});
