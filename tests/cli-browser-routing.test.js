const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { buildSync } = require('esbuild');
const directory = mkdtempSync(path.join(os.tmpdir(), 'ppilot-browser-route-'));
const bundle = path.join(directory, 'profilepilot-cli.cjs');
buildSync({ entryPoints: ['src/main/profilepilot-cli.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
test.after(() => rmSync(directory, { recursive: true, force: true }));
function invoke(args, root = directory) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, ...args], { env: { ...process.env, PROFILEPILOT_NATIVE_ROOT: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
async function server(t, handler) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ppilot-browser-service-'));
  const instance = http.createServer((req, res) => {
    if (req.url === '/native-service') { req.resume(); res.end(JSON.stringify({ ok: true, result: { service: 'browser', version: 1, pid: process.pid, root } })); }
    else handler(req, res);
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  writeFileSync(path.join(root, 'native-control.json'), JSON.stringify({ version: 1, port: instance.address().port, token: 'a'.repeat(64), pid: process.pid, service: 'browser', serviceVersion: 1 }));
  t.after(async () => { await new Promise(resolve => instance.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  return root;
}

test('main bundle routes browser help once and keeps standard help/version intact', async () => {
  const browser = await invoke(['browser', '--help']);
  assert.equal(browser.code, 0); assert.equal(browser.stderr, '');
  assert.equal(browser.stdout.split('ProfilePilot Browser CLI').length - 1, 1);
  assert.match(browser.stdout, /ppilot browser/);
  const help = await invoke(['--help']);
  assert.equal(help.code, 0); assert.match(help.stdout, /ppilot browser/);
  assert.equal(help.stdout.includes('no model invocation'), false);
  const version = await invoke(['--version']);
  assert.equal(version.code, 0); assert.match(version.stdout, /^\d+\.\d+\.\d+\r?\n$/);
});

test('browser route sends exactly one authenticated request through installed main bundle', async t => {
  const requests = [];
  const root = await server(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${'a'.repeat(64)}`);
    let body = ''; req.on('data', chunk => body += chunk);
    req.on('end', () => { requests.push(JSON.parse(body)); res.end(JSON.stringify({ ok: true, result: { connected: true } })); });
  });
  const result = await invoke(['browser', 'observe', '--profile', 'native:Default', '--session', 'fixture-session', '--params', '{"layout":true}'], root);
  assert.equal(result.code, 0, result.stderr); assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'observe'); assert.equal(requests[0].sessionId, 'fixture-session');
  assert.deepEqual(requests[0].params, { layout: true });
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, result: { connected: true } });
});

test('browser errors preserve structured exit codes and do not retry uncertain actions', async t => {
  let calls = 0;
  const root = await server(t, (_req, res) => { calls++; res.end(JSON.stringify({ ok: false, code: 'NATIVE_USER_IN_CONTROL', error: 'User has taken control' })); });
  const result = await invoke(['browser', 'action', '--params', '{"kind":"click"}'], root);
  assert.equal(result.code, 75); assert.equal(calls, 1); assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).code, 'NATIVE_USER_IN_CONTROL');
  const invalid = await invoke(['browser', 'action', '--params', 'invalid-json'], root);
  assert.equal(invalid.code, 64); assert.equal(calls, 1);
  assert.equal(JSON.parse(invalid.stderr).code, 'NATIVE_INVALID_REQUEST');
});

test('service status does not launch a missing service, leaving conversation routing available', async () => {
  const absent = await invoke(['browser', 'service', 'status'], directory);
  assert.equal(absent.code, 0); assert.equal(JSON.parse(absent.stdout).result.running, false);
  const chat = await invoke(['chat', '--help']);
  assert.equal(chat.code, 0); assert.match(chat.stdout, /ppilot/); assert.equal(chat.stderr, '');
});
