const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { requestProfilePilotManagement } = loadCli('src/main/profilepilot-cli.ts');
const { startProfilePilotManagementServer } = loadCli('src/main/profilepilot-management-server.ts');
const { phoneRequest } = loadCli('src/main/phones/adb.ts');

test('status and screenshot timeouts explain recovery; input timeouts preserve uncertain-result guidance', async t => {
  const http = require('node:http');
  const { EventEmitter } = require('node:events');
  t.mock.method(http, 'request', () => {
    const request = new EventEmitter(); let timeout;
    request.setTimeout = (ms, callback) => { assert.equal(ms, 7000); timeout = callback; return request; };
    request.destroy = error => request.emit('error', error);
    request.end = () => queueMicrotask(timeout);
    return request;
  });
  for (const [method, body] of [['sync', {}], ['action', { action: { kind: 'screenshot' } }]]) {
    await assert.rejects(phoneRequest(1234, 'fixture', method, body), error => {
      assert.match(error.message, /App 超过 7 秒没有回复.*解锁手机.*ProfilePilot/);
      assert.doesNotMatch(error.message, /重试输入|是否已生效/);
      return true;
    });
  }
  await assert.rejects(phoneRequest(1234, 'fixture', 'action', { action: { kind: 'tap', x: 1, y: 1 } }), /确认点击或输入是否已生效/);
});

test('phone screenshot crosses the authenticated CLI transport above 1 MiB', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-phone-response-'));
  const env = { PROFILEPILOT_MANAGEMENT_ROOT: root };
  let base64 = 'a'.repeat(1400000);
  const server = await startProfilePilotManagementServer({ homeDir: root, env, appVersion: base64, profileManager: {}, getPhoneService: () => ({ perform: async () => ({ state: {}, result: { mime: 'image/jpeg', base64 } }), performWrapper: async () => ({ state: {}, result: { mime: 'image/png', base64 } }), basicPerform: async () => ({ state: {}, result: { mime: 'image/png', base64 } }) }) });
  try {
    const response = await requestProfilePilotManagement({ action: 'phone', method: 'action', params: { id: 'fixture', sessionId: 'session', generation: 1, requestId: randomUUID(), action: { kind: 'screenshot' } } }, root, env);
    assert.equal(response.ok, true); assert.equal(response.data.result.base64.length, base64.length);
    const wrapper = await requestProfilePilotManagement({ action: 'phone', method: 'wrapper-action', params: { lease: randomUUID(), generation: 1, requestId: randomUUID(), action: { kind: 'screenshot', format: 'png' } } }, root, env);
    assert.equal(wrapper.ok, true); assert.equal(wrapper.data.result.base64.length, base64.length);
    const ordinary = await requestProfilePilotManagement({ action: 'ping' }, root, env);
    assert.equal(ordinary.ok, false); assert.equal(ordinary.error.code, 'MANAGEMENT_RESPONSE_TOO_LARGE');
    base64 = 'a'.repeat(9 * 1024 * 1024);
    const oversized = await requestProfilePilotManagement({ action: 'phone', method: 'action', params: { id: 'fixture', sessionId: 'session', generation: 1, requestId: randomUUID(), action: { kind: 'screenshot' } } }, root, env);
    assert.equal(oversized.ok, false); assert.equal(oversized.error.code, 'MANAGEMENT_RESPONSE_TOO_LARGE');
    const basic = await requestProfilePilotManagement({ action: 'phone', method: 'basic-action', params: { id: 'fixture', sessionId: 'session', generation: 1, requestId: randomUUID(), action: { kind: 'screenshot' } } }, root, env);
    assert.equal(basic.ok, true); assert.equal(basic.data.result.base64.length, base64.length);
  } finally {
    await server.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
