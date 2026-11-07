const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const source = fs.readFileSync('tests/native-control.test.js', 'utf8');
const workerSource = source.slice(source.indexOf('async function worker()'), source.indexOf("test('full-access"));
const worker = new Function('fs', 'vm', `${workerSource}; return worker;`)(fs, vm);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settled(w) {
  for (let i = 0; i < 150; i++) {
    const state = await w.state();
    if (['failed', 'cancelled', 'recovered'].includes(state.debuggerDiagnostic?.phase)) return state;
    await sleep(10);
  }
  throw Error('Recovery did not settle');
}

test('a live navigated tab reconnects without old-document overlay history or replay', async t => {
  const w = await worker(); t.after(w.close);
  await w.handle('claim', { sessionId: 'one', tabId: 7 });
  w.tabs.get(7).url = 'https://fixture.test/after-submit';
  w.chrome.scripting.executeScript = async () => [{ result: { active: true, removed: 0, lastRemovedAt: 0 } }];
  let inputs = 0;
  w.chrome.debugger.sendCommand = async () => {
    inputs++;
    w.chrome.debugger.onDetach.fire({ tabId: 7 }, 'target_closed');
    throw Error('Detached while handling command.');
  };
  await assert.rejects(w.handle('cdp', { sessionId: 'one', method: 'Input.insertText', params: { text: 'only once' } }),
    error => error.code === 'NATIVE_DEBUGGER_RECOVERED');
  const state = await settled(w);
  assert.equal(inputs, 1);
  assert.equal(state.ownership, 'agent');
  assert.equal(state.debuggerDiagnostic.reason, 'target_closed');
  assert.equal(state.debuggerDiagnostic.phase, 'recovered');
  assert.equal(w.calls.filter(c => c[0] === 'attach').length, 2);
  assert.equal(w.calls.filter(c => c[0] === 'update').length, 0);
});

test('a transient document replacement gets one bounded preflight retry', async t => {
  const w = await worker(); t.after(w.close);
  await w.handle('claim', { sessionId: 'one', tabId: 7 });
  let injections = 0;
  w.chrome.scripting.executeScript = async () => {
    if (++injections === 1) throw Error('The document was unloaded');
    return [{ result: { active: true, removed: 0, lastRemovedAt: 0 } }];
  };
  w.chrome.debugger.onDetach.fire({ tabId: 7 }, 'target_closed');
  const state = await settled(w);
  assert.equal(state.debuggerDiagnostic.phase, 'recovered');
  assert.equal(state.debuggerDiagnostic.attempts, 2);
  assert.equal(injections, 2);
});

test('failed reconnect keeps the specific error, detach reason and attempts', async t => {
  for (const scenario of ['busy', 'foreign-frame', 'guard']) await t.test(scenario, async t => {
    const w = await worker(); t.after(w.close);
    await w.handle('claim', { sessionId: 'one', tabId: 7 });
    const expected = { busy: 'NATIVE_DEBUGGER_BUSY', 'foreign-frame': 'NATIVE_EXTENSION_FRAME_CONFLICT', guard: 'NATIVE_FRAME_GUARD_UNAVAILABLE' }[scenario];
    let attempts = 0;
    if (scenario === 'guard') w.chrome.scripting.executeScript = async () => { attempts++; throw Error('injection failed'); };
    else w.chrome.debugger.attach = async () => { attempts++; throw Error(scenario === 'busy' ? 'Another debugger is already attached' : 'Cannot access a chrome-extension:// URL of different extension'); };
    w.chrome.debugger.onDetach.fire({ tabId: 7 }, 'target_closed');
    const state = await settled(w);
    assert.equal(state.ownership, 'user');
    assert.equal(state.controlIssue.code, expected);
    assert.equal(state.debuggerDiagnostic.code, expected);
    assert.match(state.controlIssue.message, /target_closed/);
    assert.equal(attempts, scenario === 'guard' ? 2 : 1);
  });
});

test('Chrome cancellation while reconnect is pending wins over a late attach', async t => {
  const w = await worker(); t.after(w.close);
  await w.handle('claim', { sessionId: 'one', tabId: 7 });
  let finish, entered = false;
  w.chrome.debugger.attach = async () => { entered = true; await new Promise(resolve => { finish = resolve; }); };
  w.chrome.debugger.onDetach.fire({ tabId: 7 }, 'target_closed');
  for (let i = 0; i < 100 && !entered; i++) await sleep(10);
  assert.ok(entered);
  w.chrome.debugger.onDetach.fire({ tabId: 7 }, 'canceled_by_user');
  finish(); await sleep(30);
  const state = await w.state();
  assert.equal(state.ownership, 'user');
  assert.equal(state.controlIssue, undefined);
  assert.equal(state.debuggerDiagnostic.phase, 'cancelled');
  assert.ok(w.calls.some(c => c[0] === 'detach'), 'late attachment is closed');
});

test('recovery stops on closed, sleeping or restricted tabs without changing target', async t => {
  for (const scenario of ['closed', 'discarded', 'restricted']) await t.test(scenario, async t => {
    const w = await worker(); t.after(w.close);
    await w.handle('claim', { sessionId: 'one', tabId: 7 });
    if (scenario === 'closed') w.tabs.delete(7);
    if (scenario === 'discarded') w.tabs.get(7).discarded = true;
    if (scenario === 'restricted') w.tabs.get(7).url = 'chrome://settings';
    w.chrome.debugger.onDetach.fire({ tabId: 7 }, 'target_closed');
    const state = await settled(w);
    assert.equal(state.ownership, 'user');
    assert.equal(state.debuggerDiagnostic.phase, 'failed');
    assert.equal(w.calls.filter(c => c[0] === 'attach').length, 1);
    assert.equal(w.calls.filter(c => c[0] === 'update').length, 0);
  });
});

test('persistent detach storms are bounded even if each attach succeeds', async t => {
  const w = await worker(); t.after(w.close);
  await w.handle('claim', { sessionId: 'one', tabId: 7 });
  for (let i = 0; i < 4; i++) {
    w.chrome.debugger.onDetach.fire({ tabId: 7 }, 'target_closed');
    await settled(w);
  }
  const state = await w.state();
  assert.equal(state.controlIssue.code, 'NATIVE_DEBUGGER_RECOVERY_LIMIT');
  assert.equal(state.ownership, 'user');
  assert.equal(w.calls.filter(c => c[0] === 'attach').length, 4);
});

test('bridge persists only whitelisted debugger diagnostics, including asynchronous failures', t => {
  const { NativeBrowserBridge } = loadCli('src/main/tasks/native-bridge.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-debugger-trace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bridge = Object.create(NativeBrowserBridge.prototype);
  bridge.root = root;
  const connection = { state: { profileId: 'native:fixture', ownerSessionId: 'task' } };
  bridge.receive(connection, { type: 'debuggerDiagnostic', diagnostic: {
    id: '13d5b5d4-60d5-4855-8d99-52c7256e261f', at: '2026-10-25T06:15:59.852Z',
    reason: 'target_closed', phase: 'failed', attempts: 1, code: 'NATIVE_DEBUGGER_BUSY',
    url: 'https://private.example?token=secret', message: 'password=secret'
  } });
  assert.equal(connection.state.debuggerDiagnostic.reason, 'target_closed');
  const content = fs.readFileSync(path.join(root, 'control-diagnostics', `extension-${process.pid}.jsonl`), 'utf8');
  assert.match(content, /debugger.failed/);
  assert.match(content, /NATIVE_DEBUGGER_BUSY/);
  assert.doesNotMatch(content, /secret|private|password/);
  bridge.receive(connection, { type: 'debuggerDiagnostic', diagnostic: { reason: 'bad' } });
  assert.equal(fs.readFileSync(path.join(root, 'control-diagnostics', `extension-${process.pid}.jsonl`), 'utf8'), content);
});
