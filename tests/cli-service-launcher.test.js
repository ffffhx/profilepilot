const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { buildSync } = require('esbuild');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ppilot-service-launcher-'));
buildSync({ entryPoints: ['src/main/cli/service-launcher.ts'], outfile: path.join(directory, 'launcher.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const { windowsArgument, windowsDetachedScript, ensureChatService } = require(path.join(directory, 'launcher.cjs'));
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('Windows detached service launch treats paths as data and hides the process window', () => {
  const executable = 'C:\\Program Files\\ProfilePilot\\ProfilePilot.exe';
  const cwd = 'C:\\Users\\a $(`not a command`)\\Project';
  const args = [cwd, '--background'];
  const script = windowsDetachedScript({ executable, args, cwd });
  assert.match(script, /Invoke-CimMethod/);
  assert.match(script, /ShowWindow = \[uint16\]0/);
  assert.equal(script.includes('not a command'), false);
  const encoded = script.match(/FromBase64String\('([^']+)'\)/)[1];
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), [executable, ...args].map(windowsArgument).join(' '));
  assert.equal(windowsArgument('C:\\space path\\'), '"C:\\space path\\\\"');
});

test('an already connected service is reused without reading a launcher or starting a process', async () => {
  let calls = 0;
  await ensureChatService(async command => { calls++; assert.equal(command.action, 'ping'); return { ok: true, data: {} }; }, '/missing-home', () => assert.fail('No startup notice expected'));
  assert.equal(calls, 1);
});

test('authentication failures are preserved rather than starting a second app instance', async () => {
  await assert.rejects(ensureChatService(async () => ({ ok: false, error: { message: 'Authentication failed' } }), directory, () => {}), /Authentication failed/);
});
