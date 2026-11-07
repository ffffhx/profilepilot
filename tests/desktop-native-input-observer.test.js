const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadCli } = require('./cli-test-build.cjs');
const { inputObserverMessageSchema, inputObserverStartupFailureSchema } = loadCli('src/main/desktop/input-observer.ts');

test('native shared observer protocol, retention, privacy and browser policy are pure and bounded', { skip: process.platform !== 'win32', timeout: 30000 }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-input-observer-pure-'));
  const executable = path.join(directory, 'InputObserverPureTests.exe');
  t.after(() => { if (fs.existsSync(executable)) fs.unlinkSync(executable); fs.rmdirSync(directory); });
  const root = path.resolve(__dirname, '..');
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  // Alternate /main is mandatory: the native helper entry is never executed.
  // The selected test class contains no process, HWND, keyboard or hook calls.
  execFileSync(path.join(framework, 'csc.exe'), [
    '/nologo', '/codepage:65001', '/target:exe', '/platform:x64', '/optimize+', '/warnaserror+',
    '/main:InputObserverWindowsTests', `/out:${executable}`, '/r:System.Web.Extensions.dll',
    path.join(root, 'native', 'input-observer-win.cs'), path.join(__dirname, 'helpers', 'input-observer-win-tests.cs')
  ], { cwd: root, windowsHide: true, timeout: 20000, encoding: 'utf8' });
  const result = JSON.parse(execFileSync(executable, [], { windowsHide: true, timeout: 10000, encoding: 'utf8' }));
  assert.equal(result.ok, true);
  assert.equal(result.checks.length, 44);
  for (const message of result.messages) {
    const schema = message.type === 'startup-failure' ? inputObserverStartupFailureSchema : inputObserverMessageSchema;
    assert.equal(schema.safeParse(message).success, true, JSON.stringify(message));
    assert.ok(Buffer.byteLength(JSON.stringify(message), 'utf8') <= 2048);
  }
  assert.ok(result.messages.some(value => value.sequence === '18446744073709551615'));
  assert.ok(result.messages.some(value => value.marker === 'ffffffffffffffff'));
  t.diagnostic(result.checks.join('; '));
});
