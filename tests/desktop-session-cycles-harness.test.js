const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

function fake() {
  const expected = { nonce: 'a'.repeat(32), executable: 'C:\\owned\\Cycle.exe', sha256: 'b'.repeat(64), lifetimeMinutes: 120 };
  const identity = { ok: true, pid: 123, parentPid: 99, startedUtcTicks: '639289000000000000', executable: expected.executable,
    sha256: expected.sha256, integrityRid: 8192, elevated: false, uiAccess: false };
  const ready = { nonce: expected.nonce, pid: identity.pid, startedUtcTicks: identity.startedUtcTicks, hwnd: '456', lifetimeMinutes: 120,
    administrator: false, inputInjected: false, hooksInstalled: false };
  const state = { alive: false }, calls = [];
  const io = {
    async launch() { state.alive = true; calls.push('launch'); throw new Error('launcher handshake failed after start'); },
    async ready() { calls.push('ready'); return ready; },
    async inspect(pid) { calls.push('inspect:' + pid); return identity; },
    async requestClose() { calls.push('nonce-close'); state.alive = false; },
    async closed() { calls.push('closed'); return { ...ready, closeReason: 'nonce_close' }; },
    async wait(value, ms) { assert.deepEqual(value, identity); assert.equal(ms, 5000); calls.push('wait:' + value.pid); return { ok: true, originalExited: !state.alive }; },
    async force(value) { assert.deepEqual(value, identity); calls.push('force:' + value.pid); state.alive = false; return { ok: true, originalExited: true, forced: true }; }
  };
  return { expected, identity, ready, state, calls, io };
}

test('cycle launch side effect followed by throw still closes nonce and confirms the exact original exit', async () => {
  const { sessionCycleFixtureLifecycle } = await import('../scripts/e2e/desktop-session-cycle-lifecycle.mjs');
  const f = fake(), lifecycle = sessionCycleFixtureLifecycle(f.expected, f.io);
  let fixture; await assert.rejects(async () => { fixture = await lifecycle.launch(); }, /handshake failed/);
  assert.equal(fixture, undefined); assert.equal(lifecycle.attempted, true); assert.equal(f.state.alive, true);
  const result = await lifecycle.cleanup();
  assert.equal(result.ok, true); assert.equal(result.identityRecovered, true); assert.equal(result.exit.originalExited, true);
  assert.deepEqual(result.exit.forcedAttempts, []); assert.equal(f.state.alive, false);
  assert.deepEqual(f.calls, ['launch', 'ready', 'inspect:123', 'nonce-close', 'closed', 'wait:123']);
});

test('unknown or mismatched cycle identity still sends nonce close and never waits or kills by PID', async () => {
  const { sessionCycleFixtureLifecycle } = await import('../scripts/e2e/desktop-session-cycle-lifecycle.mjs');
  for (const defect of ['missing-ready', 'nonce', 'ready-pid', 'birth', 'hwnd', 'lifetime', 'parent', 'path', 'hash', 'integrity', 'elevation', 'uiAccess']) {
    const f = fake();
    if (defect === 'missing-ready') f.io.ready = async () => { throw new Error('No ready receipt'); };
    if (defect === 'nonce') f.ready.nonce = 'c'.repeat(32);
    if (defect === 'ready-pid') f.ready.pid = 456;
    if (defect === 'birth') f.identity.startedUtcTicks = '639289000000000001';
    if (defect === 'hwnd') f.ready.hwnd = '0';
    if (defect === 'lifetime') f.ready.lifetimeMinutes = 30;
    if (defect === 'parent') f.identity.parentPid = 0;
    if (defect === 'path') f.identity.executable = 'C:\\other\\Cycle.exe';
    if (defect === 'hash') f.identity.sha256 = 'c'.repeat(64);
    if (defect === 'integrity') f.identity.integrityRid = 12288;
    if (defect === 'elevation') f.identity.elevated = true;
    if (defect === 'uiAccess') f.identity.uiAccess = true;
    const lifecycle = sessionCycleFixtureLifecycle(f.expected, f.io); await assert.rejects(lifecycle.launch());
    const result = await lifecycle.cleanup(); assert.equal(result.ok, false, defect); assert.equal(result.closeRequested, true, defect);
    assert.ok(result.errors.some(value => value.stage === 'identity'), defect);
    assert.equal(f.calls.some(value => /^(wait|force):/.test(value)), false, defect); assert.equal(f.state.alive, false, defect);
  }
});

test('a launch return PID must agree with nonce readiness before identity can be pinned', async () => {
  const { sessionCycleFixtureLifecycle } = await import('../scripts/e2e/desktop-session-cycle-lifecycle.mjs');
  const f = fake(); f.io.launch = async () => ({ pid: 999 });
  const lifecycle = sessionCycleFixtureLifecycle(f.expected, f.io); await lifecycle.launch(); await assert.rejects(lifecycle.confirm());
  const result = await lifecycle.cleanup(); assert.equal(result.ok, false); assert.equal(result.closeRequested, true);
  assert.equal(f.calls.some(value => /^(inspect|wait|force):/.test(value)), false);
});

test('verified force cleanup requires a separate exact exit confirmation and always fails acceptance', async () => {
  const { sessionCycleFixtureLifecycle } = await import('../scripts/e2e/desktop-session-cycle-lifecycle.mjs');
  const f = fake(); f.io.requestClose = async () => { f.calls.push('nonce-close'); };
  f.io.closed = async () => { throw new Error('Close receipt absent'); };
  const lifecycle = sessionCycleFixtureLifecycle(f.expected, f.io); await assert.rejects(lifecycle.launch());
  const result = await lifecycle.cleanup(); assert.equal(result.ok, false); assert.equal(result.exit.ok, false);
  assert.equal(result.exit.originalExited, true); assert.equal(result.exit.forcedAttempts.length, 1);
  assert.deepEqual(f.calls.slice(-3), ['wait:123', 'force:123', 'wait:123']); assert.equal(f.state.alive, false);
});

test('nonce close write failure and misleading force result cannot fake confirmed exit', async () => {
  const { sessionCycleFixtureLifecycle } = await import('../scripts/e2e/desktop-session-cycle-lifecycle.mjs');
  const f = fake(); f.io.requestClose = async () => { throw new Error('Write denied'); };
  f.io.force = async () => ({ ok: true, originalExited: true });
  const lifecycle = sessionCycleFixtureLifecycle(f.expected, f.io); await assert.rejects(lifecycle.launch());
  const result = await lifecycle.cleanup(); assert.equal(result.ok, false); assert.equal(result.closeRequested, false);
  assert.equal(result.exit.originalExited, false); assert.equal(f.state.alive, true);
  assert.ok(result.errors.some(value => value.stage === 'request-close')); assert.ok(result.errors.some(value => value.stage === 'after-force-wait'));
});

test('an invalid close receipt fails while independent pinned exit confirmation still runs', async () => {
  const { sessionCycleFixtureLifecycle } = await import('../scripts/e2e/desktop-session-cycle-lifecycle.mjs');
  for (const extra of [{ nonce: 'c'.repeat(32) }, { pid: 999 }, { startedUtcTicks: '639289000000000001' }, { hwnd: '999' }, { closeReason: 'heartbeat_expired' }]) {
    const f = fake(); f.io.closed = async () => ({ ...f.ready, closeReason: 'nonce_close', ...extra });
    const lifecycle = sessionCycleFixtureLifecycle(f.expected, f.io); await assert.rejects(lifecycle.launch());
    const result = await lifecycle.cleanup(); assert.equal(result.ok, false); assert.equal(result.exit.originalExited, true);
    assert.ok(result.errors.some(value => value.stage === 'close-receipt')); assert.equal(f.calls.includes('force:123'), false);
  }
});

test('normal cycle startup pins full identity and cleanup is single-use', async () => {
  const { sessionCycleFixtureLifecycle } = await import('../scripts/e2e/desktop-session-cycle-lifecycle.mjs');
  const f = fake(); f.io.launch = async () => { f.state.alive = true; return { pid: f.identity.pid }; };
  const lifecycle = sessionCycleFixtureLifecycle(f.expected, f.io); await lifecycle.launch();
  const confirmed = await lifecycle.confirm(); assert.deepEqual(confirmed.identity, f.identity); assert.ok(Object.isFrozen(confirmed.identity));
  const [first, second] = await Promise.all([lifecycle.cleanup(), lifecycle.cleanup()]);
  assert.equal(first, second); assert.equal(first.ok, true); assert.equal(first.identityRecovered, false);
  assert.equal(f.calls.filter(value => value === 'inspect:123').length, 1); assert.equal(f.calls.filter(value => value === 'nonce-close').length, 1);
});

test('never-attempted cycle fixture cleanup performs no I/O', async () => {
  const { sessionCycleFixtureLifecycle } = await import('../scripts/e2e/desktop-session-cycle-lifecycle.mjs');
  const f = fake(); const result = await sessionCycleFixtureLifecycle(f.expected, f.io).cleanup();
  assert.equal(result.ok, true); assert.equal(result.attempted, false); assert.deepEqual(f.calls, []);
});

test('cycle harness uses attempted lifecycle cleanup and keeps any original run failure failed', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/verify-desktop-session-cycles.mjs'), 'utf8');
  assert.match(source, /fixture = await fixtureLifecycle\.launch\(\)/);
  assert.match(source, /await fixtureLifecycle\.confirm\(\)/);
  assert.match(source, /if \(fixtureLifecycle\.attempted\)/);
  assert.doesNotMatch(source, /if \(fixture\)\s*\{/);
  const cleanup = source.slice(source.lastIndexOf('finally {'));
  assert.match(cleanup, /if \(!result\.ok\) \{ report\.ok = false; process\.exitCode = 1;/);
  assert.doesNotMatch(cleanup, /report\.ok = true/);
});

test('the real cycle harness finally cleans an unreturned fixture even when status queries also fail', async () => {
  const { sessionCycleFixtureLifecycle } = await import('../scripts/e2e/desktop-session-cycle-lifecycle.mjs');
  const entry = path.resolve(__dirname, '../scripts/verify-desktop-session-cycles.mjs');
  const source = fs.readFileSync(entry, 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.url', 'moduleUrl');
  for (const statusFails of [false, true]) {
    const root = path.dirname(path.dirname(entry)), home = path.join(root, '.tools', 'fake-cycle-lifecycle');
    const artifact = Buffer.from('mocked fixture artifact'), sha256 = crypto.createHash('sha256').update(artifact).digest('hex');
    const nonce = 'd'.repeat(32), calls = [];
    let attempted = false, alive = false, report;
    const base = { ok: true, parentPid: 99, startedUtcTicks: '639289000000000000', sha256, integrityRid: 8192, elevated: false, uiAccess: false };
    const app = { ...base, pid: 100, executable: path.join(root, 'node_modules/electron/dist/electron.exe') };
    const fixture = { ...base, pid: 123, executable: path.join(home, 'DesktopSessionCycleFixture.exe') };
    const ready = { nonce, pid: fixture.pid, startedUtcTicks: fixture.startedUtcTicks, hwnd: '456', lifetimeMinutes: 30, administrator: false, inputInjected: false, hooksInstalled: false };
    const build = { entry: path.join(root, 'dist/main/entry.js'), buildId: 'mock-build', startedAt: 'fixed' };
    const manifest = { buildId: build.buildId, cliSha256: sha256, components: Object.fromEntries(['Desktop', 'InputObserver', 'WindowsSampler'].map(name => ['dist/native/ProfilePilot.' + name + '.exe', sha256])) };
    const processValue = { platform: 'win32', argv: ['node', entry, '--run', '--cycles', '1'], env: {}, exit() { throw new Error('Unexpected compile-only exit'); } };
    const context = vm.createContext({ assert, path, Buffer, JSON, Date, performance, process: processValue, moduleUrl: require('node:url').pathToFileURL(entry).href,
      fileURLToPath: require('node:url').fileURLToPath, os: { tmpdir: () => path.dirname(home) },
      createHash: crypto.createHash, randomUUID: crypto.randomUUID, randomBytes: () => ({ toString: () => nonce }),
      sessionCycleFixtureLifecycle, assertDesktopAcceptanceWindow: async () => {},
      mkdtemp: async () => home, mkdir: async () => {},
      readFile: async file => file.endsWith('control-build.json') ? JSON.stringify(manifest) : file.endsWith('.ready.json') ? JSON.stringify(ready)
        : file.endsWith('.closed.json') ? JSON.stringify({ ...ready, closeReason: 'nonce_close' }) : artifact,
      writeFile: async (file, value) => { if (file.endsWith('.close')) { assert.equal(value, nonce); calls.push('nonce-close'); alive = false; }
        if (file.endsWith('report.json')) report = JSON.parse(value); },
      setInterval: () => 1, clearInterval: () => {}, setTimeout,
      console: { log() {} },
      launchWindowsUserProcess: async () => { attempted = alive = true; calls.push('launch'); throw new Error('launcher failed after actual-side-effect simulation'); },
      runDesktopCliProcess: async ({ args }) => {
        if (args[0] === 'status') return { response: { ok: true, data: { pid: app.pid, build } } };
        assert.equal(args[0], 'desktop'); assert.equal(args[1], 'status');
        if (attempted && statusFails) throw new Error('status unavailable');
        return { response: { ok: true, result: { session: null } } };
      },
      execFileSync: (file, args) => {
        if (file.endsWith('csc.exe')) return '';
        if (args[0] === '--sample') return JSON.stringify({ ok: true, app, children: [] });
        if (args[0] === '--inspect') return JSON.stringify(args[1] === String(app.pid) ? app : fixture);
        assert.equal(args[0], '--wait-owned-exit'); assert.equal(args[1], String(fixture.pid)); assert.equal(args[2], fixture.startedUtcTicks);
        calls.push('wait'); return JSON.stringify({ ok: true, originalExited: !alive });
      }
    });
    await new vm.Script('(async () => {\n' + source + '\n})()', { filename: entry }).runInContext(context);
    assert.equal(report.ok, false); assert.equal(processValue.exitCode, 1); assert.match(report.error.message, /launcher failed/);
    assert.equal(report.cleanup.fixtureLifecycle.identityRecovered, true); assert.equal(report.cleanup.fixtureLifecycle.ok, true);
    assert.equal(report.cleanup.fixtureStopped, true); assert.equal(alive, false); assert.deepEqual(calls, ['launch', 'nonce-close', 'wait']);
    if (statusFails) assert.match(report.cleanup.sessionError, /status unavailable/);
  }
});
