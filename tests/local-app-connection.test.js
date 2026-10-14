const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { loadTsModule } = require('./helpers/load-ts-module');

function fixture(t) {
  const config = { id: randomUUID(), name: 'Desktop app', mode: 'launch', command: 'electron --remote-debugging-port={cdpPort} .', cwd: 'project', environment: '', cdpPort: 9333, inspectPort: null, agentPort: 49333 };
  const state = { now: 1000, renderer: 'offline', agent: { connected: false }, managed: false,
    runtime: { status: 'running', pid: 123, startedAt: '2026-10-14T10:00:00.000Z', error: '', exitCode: null },
    events: [], quitAccepted: true, closes: true, opensConnection: true, attachWorks: true, phases: [] };
  t.mock.method(Date, 'now', () => state.now);
  const { LocalAppConnector } = loadTsModule('src/main/local-apps/connection.ts', { stubs: {
    './service-runtime': { invalidateProcessRuntime() {}, processRuntime: async () => ({ ...state.runtime }) },
    './quit': { requestAppQuit: async pid => {
      state.events.push(['quit', pid]);
      if (state.quitAccepted && state.closes) state.runtime = { ...state.runtime, status: 'stopped', pid: null };
      return state.quitAccepted;
    } },
    'node:timers/promises': { setTimeout: async ms => { state.now += ms; state.onDelay?.(); } }
  } });
  const connector = new LocalAppConnector({
    config: () => ({ ...config }),
    renderer: async () => state.renderer,
    inspect: async () => ({ ...config, managed: state.managed, runtime: { ...state.runtime }, controls: { start: ['stopped', 'failed'].includes(state.runtime.status) } }),
    agent: async () => { if (state.gatewayError) throw new Error(state.gatewayError); return { ...state.agent }; },
    attach: async () => { state.events.push(['attach']); state.agent.connected = state.attachWorks; },
    preflight: async () => { if (state.preflightError) throw new Error(state.preflightError); },
    launch: async () => {
      state.events.push(['launch']); state.phases.push(connector.state(config.id)?.phase);
      if (state.launchError) throw new Error(state.launchError);
      state.runtime = { ...state.runtime, status: 'running', pid: 456, startedAt: '2026-10-14T10:01:00.000Z' };
      if (state.opensConnection) state.renderer = 'connected';
    }
  });
  return { config, state, connector, connect: token => connector.connect(config.id, token) };
}

test('click connects a ready app directly and never requests a restart', async t => {
  const f = fixture(t); f.state.renderer = 'connected';
  assert.deepEqual(await f.connect(), { status: 'connected' });
  assert.deepEqual(f.state.events, [['attach']]);
  assert.equal(f.connector.state(f.config.id), undefined);
});

test('restart needs explicit single-use consent, then normal quit, launch, and verified Agent attachment', async t => {
  const f = fixture(t);
  const proposed = await f.connect();
  assert.equal(proposed.status, 'restart-required');
  assert.deepEqual(f.state.events, [], 'opening or cancelling the prompt cannot close the app');
  assert.deepEqual(await f.connect(proposed.confirmationToken), { status: 'connected' });
  assert.deepEqual(f.state.events, [['quit', 123], ['launch'], ['attach']]);
  assert.deepEqual(f.state.phases, ['starting']);
  await assert.rejects(f.connect(proposed.confirmationToken), /确认已失效/);
  assert.equal(f.connector.state(f.config.id), undefined);
});

test('stale confirmation cannot restart a changed config or process instance', async t => {
  for (const change of [f => { f.config.command = 'changed'; }, f => { f.state.runtime.pid = 999; }, f => { f.state.runtime.startedAt = 'new instance'; }, f => { f.state.now += 300001; }]) {
    const f = fixture(t); const proposed = await f.connect(); change(f);
    await assert.rejects(f.connect(proposed.confirmationToken), /已失效|已变化/);
    assert.deepEqual(f.state.events, []);
  }
});

test('direct readiness is rechecked after confirmation and an already exited app is started once', async t => {
  const f = fixture(t); const proposed = await f.connect(); f.state.renderer = 'connected';
  assert.deepEqual(await f.connect(proposed.confirmationToken), { status: 'connected' });
  assert.deepEqual(f.state.events, [['attach']]);
  const exited = fixture(t); const consent = await exited.connect();
  exited.state.runtime = { ...exited.state.runtime, status: 'stopped', pid: null };
  assert.deepEqual(await exited.connect(consent.confirmationToken), { status: 'connected' });
  assert.deepEqual(exited.state.events, [['launch'], ['attach']]);
});

test('missing identity, configuration, busy Agent, and invalid endpoints never lead to a restart prompt', async t => {
  for (const change of [f => { f.state.runtime.pid = null; }, f => { f.state.runtime.startedAt = null; }, f => { f.state.runtime.status = 'unknown'; }, f => { f.config.mode = 'attach'; }, f => { f.config.mode = 'service'; }, f => { f.state.renderer = 'unknown'; }, f => { f.state.agent.sessionId = 'active'; }, f => { f.state.gatewayError = 'Gateway unavailable'; }, f => { f.state.preflightError = 'Invalid launch path'; }, f => { f.config.cdpPort = null; }]) {
    const f = fixture(t); change(f);
    await assert.rejects(f.connect());
    assert.deepEqual(f.state.events, []);
  }
});

test('a denied quit or a cancelled save dialog cannot force termination or launch another instance', async t => {
  const denied = fixture(t); let proposed = await denied.connect(); denied.state.quitAccepted = false;
  await assert.rejects(denied.connect(proposed.confirmationToken), /无法请求应用正常退出/);
  assert.deepEqual(denied.state.events, [['quit', 123]]);
  const cancelled = fixture(t); proposed = await cancelled.connect(); cancelled.state.closes = false;
  cancelled.state.onDelay = () => cancelled.state.phases.push(cancelled.connector.state(cancelled.config.id)?.phase);
  await assert.rejects(cancelled.connect(proposed.confirmationToken), /尚未退出/);
  assert.deepEqual(cancelled.state.events, [['quit', 123]]);
  assert.ok(cancelled.state.phases.every(phase => phase === 'closing'));
});

test('launch failures, missing debug windows, and unverified gateway attachments report failure', async t => {
  const failed = fixture(t); let proposed = await failed.connect(); failed.state.launchError = 'Launch failed';
  await assert.rejects(failed.connect(proposed.confirmationToken), /Launch failed/);
  const timedOut = fixture(t); proposed = await timedOut.connect(); timedOut.state.opensConnection = false;
  await assert.rejects(timedOut.connect(proposed.confirmationToken), /没有开放可用的连接/);
  assert.equal(timedOut.state.runtime.status, 'running', 'a connection failure does not kill the relaunched app');
  assert.deepEqual(timedOut.state.events, [['quit', 123], ['launch']]);
  const unverified = fixture(t); unverified.state.renderer = 'connected'; unverified.state.attachWorks = false;
  await assert.rejects(unverified.connect(), /尚未建立/);
  assert.deepEqual(unverified.state.events, [['attach']]);
});

test('normal quit uses Windows window-close requests and macOS AppKit, with no forceful fallback', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const calls = [];
  const { requestAppQuit } = loadTsModule('src/main/local-apps/quit.ts', { stubs: {
    '../windows-platform': { requestWindowsProcessClose: async pids => { calls.push(pids); return true; } },
    'node:util': { promisify: () => async (...args) => { calls.push(args); return { stdout: 'true\n' }; } }
  } });
  Object.defineProperty(process, 'platform', { value: 'win32' });
  assert.equal(await requestAppQuit(123), true); assert.deepEqual(calls.pop(), [123]);
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  assert.equal(await requestAppQuit(123), true);
  const [executable, args] = calls.pop();
  assert.equal(executable, '/usr/bin/osascript');
  assert.match(args.at(-1), /runningApplicationWithProcessIdentifier\(123\)/);
  assert.match(args.at(-1), /app\.terminate/);
  assert.doesNotMatch(args.at(-1), /forceTerminate|kill|System Events/);
  assert.equal(await requestAppQuit(process.pid), false);
  assert.equal(await requestAppQuit(-1), false);
  assert.equal(calls.length, 0);
});

test('service allocates its Agent port before confirmation and serializes confirmed connection attempts', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const net = require('node:net');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-connect-'));
  t.after(() => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const cdpPort = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const config = { id: randomUUID(), createdAt: new Date().toISOString(), name: 'App', mode: 'launch', cwd: root, command: 'electron --remote-debugging-port={cdpPort} .', environment: '', cdpPort, inspectPort: null };
  fs.writeFileSync(path.join(root, 'apps.json'), JSON.stringify([config]));
  let quitCalls = 0, finishQuit;
  const { LocalAppsService } = loadTsModule('src/main/local-apps/service.ts', { stubs: {
    './service-runtime': { invalidateProcessRuntime() {}, processRuntime: async () => ({ status: 'running', pid: 123, startedAt: '2026-10-14T10:00:00.000Z', error: '', exitCode: null }) },
    './quit': { requestAppQuit: () => { quitCalls++; return new Promise(resolve => { finishQuit = resolve; }); } }
  } });
  const gateway = { status: async () => ({}), state: () => ({ connected: false }), attach: async () => {} };
  const service = new LocalAppsService(root, undefined, gateway);
  const proposed = await service.connect(config.id);
  assert.equal(proposed.status, 'restart-required');
  assert.ok(service.get(config.id).agentPort >= 1024);
  await service.syncAgents();
  const connecting = service.connect(config.id, proposed.confirmationToken);
  // Attach an error observer while the intentionally delayed quit is pending.
  const rejected = assert.rejects(connecting, /无法请求应用正常退出/);
  for (let i = 0; i < 100 && !quitCalls; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(quitCalls, 1, 'the background route refresh must not invalidate consent');
  assert.equal(service.snapshot()[0].connection.phase, 'closing');
  await assert.rejects(service.connect(config.id, proposed.confirmationToken), /另一项操作/);
  finishQuit(false); await rejected;
  assert.equal(quitCalls, 1);
  assert.equal(service.snapshot()[0].connection, undefined);
});
