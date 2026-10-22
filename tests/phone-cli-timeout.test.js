const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const test = require('node:test');
const { runProfilePilotCli, requestProfilePilotManagement } = require('./cli-test-build.cjs').loadCli('src/main/profilepilot-cli.ts');

// Exercise the actual CLI routing and IPC client with a deterministic socket.
// No desktop service, phone connection, shared dist, or wall-clock timeout wait.
function harness(t, { connect = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppct-'));
  fs.writeFileSync(path.join(root, 'secret'), '0'.repeat(64));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PROFILEPILOT_MANAGEMENT_ROOT: root, PROFILEPILOT_PHONE_LEASE: 'fixture-lease' };
  const requests = [], sockets = [];
  let elapsed = 0, stderr = '';
  const state = { phase: 'controlling', mode: 'control', generation: 7 };
  class Socket extends EventEmitter {
    setEncoding() { return this; }
    setTimeout(ms, callback) { this.timeoutMs = ms; this.deadline = elapsed + ms; this.timeout = callback; return this; }
    write(line) {
      this.request = JSON.parse(line); requests.push(this);
      if (this.request.command.method === 'wrapper-state') this.respond({ id: 'fixture-phone', transport: 'usb', connection: 'device', state });
      return true;
    }
    respond(data, error) {
      queueMicrotask(() => {
        if (!this.destroyed) this.emit('data', JSON.stringify({ version: 1, id: this.request.id, ok: !error, ...(error ? { error } : { data }) }) + '\n');
      });
    }
    destroy() { this.destroyed = true; return this; }
  }
  t.mock.method(net, 'createConnection', () => {
    const socket = new Socket(); sockets.push(socket);
    if (connect) queueMicrotask(() => socket.emit('connect'));
    return socket;
  });
  return {
    env, root, requests, sockets, state,
    io: { stdout: { write() {} }, stderr: { write(text) { stderr += text; } } },
    stderr: () => stderr,
    advance(ms) { elapsed += ms; for (const socket of sockets) if (!socket.destroyed && socket.deadline <= elapsed) socket.timeout(); }
  };
}
async function until(predicate) {
  for (let n = 0; n < 1000; n++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('IPC fixture did not reach the expected request');
}
const png = Buffer.alloc(24);
Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
png.writeUInt32BE(2772, 16); png.writeUInt32BE(1240, 20);

test('managed native PNG waits beyond ten seconds without resubmitting capture', async t => {
  const h = harness(t);
  const command = runProfilePilotCli(['phone', 'adb', 'exec-out', 'screencap', '-p'], h.io, { homeDir: h.root, env: h.env });
  await until(() => h.requests.length === 2);
  const capture = h.requests[1];
  assert.equal(h.requests[0].timeoutMs, 10000);
  assert.equal(capture.request.command.method, 'wrapper-action');
  assert.deepEqual(capture.request.command.params.action, { kind: 'screenshot', format: 'png' });
  assert.equal(capture.timeoutMs, 35000);
  h.advance(16000);
  assert.equal(capture.destroyed, undefined);
  capture.respond({ state: h.state, result: { mime: 'image/png', width: 2772, height: 1240, base64: png.toString('base64') } });
  assert.equal(await command, 0);
  assert.equal(h.requests.length, 2);
});

test('native PNG response wait stays bounded and does not recapture on timeout', async t => {
  const h = harness(t);
  const command = runProfilePilotCli(['adb', 'exec-out', 'screencap', '-p'], h.io, { homeDir: h.root, env: h.env });
  await until(() => h.requests.length === 2);
  h.advance(35000);
  assert.equal(await command, 1);
  assert.match(h.stderr(), /等待 ProfilePilot 管理服务返回结果超时/);
  assert.equal(h.requests.length, 2);
});

test('input keeps its ten-second limit and reports uncertain response without replay', async t => {
  const h = harness(t);
  const command = runProfilePilotCli(['phone', 'adb', 'shell', 'input', 'swipe', '10', '20', '30', '40', '500'], h.io, { homeDir: h.root, env: h.env });
  await until(() => h.requests.length === 2);
  assert.equal(h.requests[1].request.command.params.action.kind, 'swipe');
  assert.equal(h.requests[1].timeoutMs, 10000);
  h.advance(10000);
  assert.equal(await command, 1);
  assert.match(h.stderr(), /等待 ProfilePilot 管理服务返回结果超时.*不要直接重放/);
  assert.equal(h.requests.length, 2);
});

test('revoked screenshot ownership rejects immediately without waiting or retrying', async t => {
  const h = harness(t);
  const command = runProfilePilotCli(['phone', 'adb', 'exec-out', 'screencap', '-p'], h.io, { homeDir: h.root, env: h.env });
  await until(() => h.requests.length === 2);
  h.requests[1].respond(undefined, { code: 'PHONE_REJECTED', message: '手机会话已改变，本次截图已丢弃。' });
  assert.equal(await command, 1);
  assert.match(h.stderr(), /手机会话已改变/);
  assert.equal(h.requests.length, 2);
});

test('an IPC socket that never connects keeps the connection timeout diagnosis', async t => {
  const h = harness(t, { connect: false });
  const pending = requestProfilePilotManagement({ action: 'ping' }, h.root, h.env, 10000);
  await until(() => h.sockets.length === 1);
  h.advance(10000);
  await assert.rejects(pending, { code: 'ETIMEDOUT', message: '连接 ProfilePilot 管理服务超时。' });
  assert.equal(h.requests.length, 0);
});
