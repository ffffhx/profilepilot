const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');

test('assisted setup geometry, process identity and cleanup run with fake callbacks only', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-desktop-assisted-unit-'));
  const executable = path.join(directory, 'PolicyTests.exe');
  t.after(() => { fs.unlinkSync(executable); fs.rmdirSync(directory); });
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/codepage:65001',
    '/main:DesktopAssistedForegroundTests', `/out:${executable}`, '/r:System.Web.Extensions.dll', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    path.join(root, 'native/desktop/input-delivery.cs'), path.join(root, 'native/desktop/pointer-coordinates.cs'),
    path.join(root, 'scripts/e2e/assisted-foreground-policy.cs'), path.join(root, 'scripts/e2e/assisted-foreground-fixture.cs'),
    path.join(root, 'scripts/e2e/desktop-fixture.cs'),
    path.join(root, 'tests/helpers/desktop-assisted-foreground-tests.cs')],
  { windowsHide: true, timeout: 20000, encoding: 'utf8' });
  // The fixture source supplies the pure bounded marker collector. No fixture,
  // Control, Form or preparer is created, and no P/Invoke or hook is called.
  const report = JSON.parse(execFileSync(executable, [], { windowsHide: true, timeout: 5000, encoding: 'utf8' }));
  assert.equal(report.ok, true); assert.equal(report.guiStarted, false); assert.equal(report.inputAttempted, false);
  assert.equal(report.checks.length, 71);
});

test('assisted markers use nonzero random32 while retaining exact 16-hex representation', async () => {
  const { createAssistedForegroundMarker } = await import(pathToFileURL(path.join(root, 'scripts/e2e/assisted-foreground.mjs')));
  let calls = 0;
  assert.equal(createAssistedForegroundMarker(size => { assert.equal(size, 4); return ++calls === 1 ? Buffer.alloc(4) : Buffer.from('89abcdef', 'hex'); }), '0000000089abcdef');
  assert.equal(calls, 2);
  assert.equal(createAssistedForegroundMarker(() => Buffer.from('ffffffff', 'hex')), '00000000ffffffff');
  assert.throws(() => createAssistedForegroundMarker(() => Buffer.alloc(4)), /ASSISTED_RANDOM_MARKER_UNAVAILABLE/);
  assert.throws(() => createAssistedForegroundMarker(() => Buffer.alloc(8)), /four random marker bytes/);
});

test('explicit opt-in, exact temporary directory and independently captured process identity are required', async () => {
  const { validateAssistedTarget } = await import(pathToFileURL(path.join(root, 'scripts/e2e/assisted-foreground.mjs')));
  const directory = path.join(os.tmpdir(), 'pp-desktop-keyboard-owned');
  const valid = { enabled: true, directory, executable: path.join(directory, 'DesktopKeyboardFixture.exe'),
    fileBase: path.join(directory, 'fixture'), pid: 123, startedUtcTicks: '638970000000000000', hwnd: '100' };
  assert.equal(validateAssistedTarget(valid).pid, 123);
  for (const change of [{ enabled: false }, { enabled: undefined }, { pid: 0 }, { startedUtcTicks: '' }, { hwnd: '0' },
    { executable: path.join(directory, '..', 'Other.exe') }, { executable: path.join(directory, 'Orca.exe') },
    { fileBase: path.join(directory, '..', 'shared') }, { directory: root }]) {
    assert.throws(() => validateAssistedTarget({ ...valid, ...change }));
  }
});
