const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
let harness;
test.before(async () => { harness = await import('../scripts/verify-desktop-observer-startup.mjs'); });

test('startup harness defaults to offline check and one explicit competition case', () => {
  assert.deepEqual(harness.parseOptions([]), { run: false, mode: 'mutex' });
  assert.deepEqual(harness.parseOptions(['--check', '--case', 'event']), { run: false, mode: 'event' });
  assert.deepEqual(harness.parseOptions(['--run']), { run: true, mode: 'mutex' });
  assert.deepEqual(harness.parseOptions(['--run', '--case', 'event']), { run: true, mode: 'event' });
  for (const args of [['--run', '--run'], ['--check', '--run'], ['--case'], ['--case', 'unknown'], ['--case', 'mutex', '--case', 'event'], ['--run', '--retry'], ['--check', '--check']]) assert.throws(() => harness.parseOptions(args));
});

test('competition accepts only exact bounded production diagnostic, never a generic unavailable or wrong code', () => {
  for (const [mode, code, win32Error] of [['mutex', 'DESKTOP_INPUT_OBSERVER_INSTANCE_BUSY', 183], ['event', 'DESKTOP_INPUT_OBSERVER_STARTUP_UNAVAILABLE', 6]]) {
    const value = { ok: false, code, details: { inputObserver: { stage: 'instance-gate', win32Error } } };
    harness.assertExpectedStartup(value, mode);
    for (const invalid of [{ ...value, ok: true }, { ...value, code: 'DESKTOP_INPUT_OBSERVER_UNAVAILABLE' },
      { ...value, details: { inputObserver: { stage: 'instance-gate', win32Error: 5 } } },
      { ...value, details: { inputObserver: { stage: 'instance-gate', win32Error, private: 'owner' } } }]) assert.throws(() => harness.assertExpectedStartup(invalid, mode));
  }
});

test('owned process pins PID, birth, executable, hash, parent and actual Medium token', () => {
  const executable = path.resolve('owned-fixture.exe');
  const original = { ok: true, pid: 123, executable, sha256: 'a'.repeat(64), startedUtcTicks: '639000000000000000', parentPid: 99, integrityRid: 8192, elevated: false, uiAccess: false };
  const expected = { pid: 123, executable, sha256: original.sha256, original };
  harness.assertOwnedIdentity(original, expected);
  for (const changed of [{ pid: 124 }, { parentPid: 100 }, { startedUtcTicks: '639000000000000001' }, { executable: executable + '.other' }, { sha256: 'b'.repeat(64) },
    { integrityRid: 12288 }, { integrityRid: 4096 }, { elevated: true }, { uiAccess: true }, { ok: false }]) assert.throws(() => harness.assertOwnedIdentity({ ...original, ...changed }, expected));
});

test('known observer presence or unknown legacy shell evidence blocks the run', () => {
  const value = { ok: true, sessionId: 1, candidates: [], gaps: [] };
  harness.assertNoObserverInventory(value);
  for (const invalid of [{ ...value, candidates: [{ pid: 123, kind: 'input-observer' }] }, { ...value, candidates: [{ pid: 456, kind: 'legacy-input-guard' }] },
    { ...value, gaps: ['shell_command_unavailable'] }, { ...value, sessionId: null }, { ...value, ok: false }]) assert.throws(() => harness.assertNoObserverInventory(invalid));
});

test('test object contract stays aligned with the production fixed name and has no hook/input API', () => {
  const root = path.resolve(__dirname, '..');
  const source = readFileSync(path.join(root, 'scripts/e2e/desktop-observer-startup-holder.cs'), 'utf8');
  const production = readFileSync(path.join(root, 'native/input-observer-win.cs'), 'utf8');
  const testName = source.match(/GateName\s*=\s*@"([^"]+)"/)[1];
  assert.equal(testName, production.match(/const string Name\s*=\s*@"([^"]+)"/)[1]);
  assert.doesNotMatch(source, /SetWindowsHookEx|SendInput|SetCursorPos|SetForegroundWindow|Process\.Kill|\.Kill\(/);
  assert.match(source, /error == 183/); assert.match(source, /Stopwatch\.StartNew\(\)/);
});
