const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { loadCli } = require('./cli-test-build.cjs');
const { NativeBrowserBridge } = loadCli('src/main/tasks/native-bridge.ts');
const { nativeControlError } = loadCli('src/main/native-control/errors.ts');

const source = fs.readFileSync('tests/native-control.test.js', 'utf8');
const workerSource = source.slice(source.indexOf('async function worker()'), source.indexOf("test('full-access"));
const worker = new Function('fs', 'vm', `${workerSource}; return worker;`)(fs, vm);
const conflict = 'Cannot access a chrome-extension:// URL of different extension';

test('foreign-extension attach failure retains the cause and session without retrying or claiming user takeover', async t => {
  const w = await worker(); t.after(w.close);
  let attempts = 0;
  w.chrome.debugger.attach = async () => { attempts++; throw Error(conflict); };
  await assert.rejects(w.handle('claim', { sessionId: 'one', tabId: 7 }), error => {
    assert.equal(error.code, 'NATIVE_EXTENSION_FRAME_CONFLICT');
    assert.match(error.message, /其他扩展/); return true;
  });
  const state = await w.state();
  assert.equal(state.sessionId, 'one'); assert.equal(state.ownership, 'user');
  assert.equal(state.controlIssue.code, 'NATIVE_EXTENSION_FRAME_CONFLICT');
  await assert.rejects(w.handle('cdp', { sessionId: 'one', method: 'Runtime.evaluate' }), error => error.code === state.controlIssue.code);
  assert.equal(attempts, 1, 'failed input is not automatically retried');
  assert.ok(!w.calls.some(call => ['update', 'Input.dispatchMouseEvent'].includes(call[0])));
  w.chrome.debugger.attach = async () => { attempts++; };
  await w.handle('control', { sessionId: 'one', action: 'resume', controlGeneration: state.controlGeneration });
  assert.equal((await w.state()).ownership, 'agent');
  assert.equal((await w.state()).controlIssue, undefined);
});

test('technical detach differs from a real user stop, which overrides a previous failure', async t => {
  const w = await worker(); t.after(w.close);
  await w.handle('claim', { sessionId: 'one', tabId: 7 });
  w.chrome.debugger.onDetach.fire({ tabId: 7 }, 'target_closed');
  assert.equal((await w.state()).controlIssue.code, 'NATIVE_DEBUGGER_DETACHED');
  await w.ui({ method: 'takeover' });
  assert.equal((await w.state()).controlIssue, undefined);
  await assert.rejects(w.handle('cdp', { sessionId: 'one', method: 'Input.insertText' }), /用户正在操作/);
  await w.handle('control', { sessionId: 'one', action: 'resume', controlGeneration: (await w.state()).controlGeneration });
  w.chrome.debugger.onDetach.fire({ tabId: 7 }, 'canceled_by_user');
  assert.equal((await w.state()).controlIssue, undefined);
  assert.equal((await w.state()).ownership, 'user');
});

test('failed resume cannot overwrite a newer user stop with a stale technical error', async t => {
  const w = await worker(); t.after(w.close);
  await w.handle('claim', { sessionId: 'one', tabId: 7 });
  w.chrome.debugger.onDetach.fire({ tabId: 7 }, 'target_closed');
  const generation = (await w.state()).controlGeneration;
  w.chrome.debugger.attach = async () => { await w.ui({ method: 'takeover' }); throw Error(conflict); };
  await assert.rejects(w.handle('control', { sessionId: 'one', action: 'resume', controlGeneration: generation }));
  assert.equal((await w.state()).controlIssue, undefined);
  assert.equal((await w.state()).ownership, 'user');
});

test('bridge and CLI preserve structured failure codes and bounded diagnostics', () => {
  const bridge = Object.create(NativeBrowserBridge.prototype);
  bridge.emit = () => {}; bridge.onboarding = { connected() {} };
  const connection = { state: { profileId: 'native:fixture' }, pending: new Map() };
  const issue = { code: 'NATIVE_EXTENSION_FRAME_CONFLICT', message: '扩展冲突'.repeat(400) };
  bridge.receive(connection, { type: 'state', state: { ownership: 'user', controlIssue: issue } });
  assert.equal(connection.state.controlIssue.code, issue.code);
  assert.equal(connection.state.controlIssue.message.length, 1000);
  let failure;
  connection.pending.set(1, { reject: error => { failure = error; } });
  bridge.receive(connection, { id: 1, error: conflict, code: issue.code });
  assert.equal(nativeControlError(failure).code, issue.code);
  assert.equal(nativeControlError(failure).exitCode, 1);
  assert.equal(nativeControlError(new Error(conflict)).code, issue.code, 'legacy workers also classify correctly');
  assert.equal(nativeControlError(new Error('Another debugger is already attached to the tab with id: 7.')).code, 'NATIVE_DEBUGGER_BUSY');
  bridge.receive(connection, { type: 'state', state: { ownership: 'agent', controlIssue: issue } });
  assert.equal(connection.state.controlIssue, undefined, 'an active connection cannot advertise a stale pause cause');
});
