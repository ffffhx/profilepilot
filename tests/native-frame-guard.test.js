const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('tests/native-control.test.js', 'utf8');
const workerSource = source.slice(source.indexOf('async function worker()'), source.indexOf("test('full-access"));
const worker = new Function('fs', 'vm', `${workerSource}; return worker;`)(fs, vm);
const sender = (w, tabId = 7) => ({ id: 'fixture', frameId: 0, documentId: 'document-7', tab: w.tabs.get(tabId), url: w.tabs.get(tabId).url });
const request = (w, action, token = 'guard-one', from = sender(w)) => w.content({ method: 'frameGuard', action, token }, from);

test('frame suppression is limited to the authorized top document and expires on handoff', async t => {
  const w = await worker(); t.after(w.close);
  assert.equal((await request(w, 'acquire')).allowed, false);
  await w.handle('claim', { sessionId: 'one', tabId: 7 });
  assert.equal((await request(w, 'acquire')).allowed, true);
  assert.equal((await request(w, 'renew')).allowed, true);
  for (const invalid of [sender(w, 8), sender(w, 9), { ...sender(w), frameId: 1 }, { ...sender(w), id: 'foreign' }, { ...sender(w), url: 'chrome://settings' }]) {
    assert.equal((await request(w, 'acquire', 'wrong', invalid)).allowed, false);
  }
  await w.handle('control', { sessionId: 'one', action: 'handoff' });
  assert.equal((await request(w, 'renew')).allowed, false);
  assert.equal((await request(w, 'acquire')).allowed, false, 'a page cannot resume a user-owned task');
});

test('preflight runs before attach and frames are restored after debugger detach', async t => {
  const w = await worker(); t.after(w.close);
  const events = [];
  w.chrome.scripting.executeScript = async options => {
    if (options.files?.includes('frame-guard.js')) { events.push('suspend'); await request(w, 'acquire'); }
    return [{ result: { active: true } }];
  };
  w.chrome.debugger.attach = async () => events.push('attach');
  w.chrome.debugger.detach = async () => events.push('detach');
  w.chrome.tabs.sendMessage = async (tabId, message, target) => { events.push('restore'); assert.equal(tabId, 7); assert.equal(target.documentId, 'document-7'); assert.equal(message.token, 'guard-one'); };
  await w.handle('claim', { sessionId: 'one', tabId: 7 });
  assert.deepEqual(events, ['suspend', 'attach']);
  await w.handle('control', { sessionId: 'one', action: 'complete' });
  assert.deepEqual(events, ['suspend', 'attach', 'detach', 'restore']);
  assert.equal((await request(w, 'renew')).allowed, false);
});

test('explicit resume permits preflight but a concurrent takeover cancels attach', async t => {
  const w = await worker(); t.after(w.close);
  await w.handle('claim', { sessionId: 'one', tabId: 7 });
  await w.handle('control', { sessionId: 'one', action: 'handoff' });
  let attempts = 0;
  w.chrome.debugger.attach = async () => attempts++;
  w.chrome.scripting.executeScript = async options => {
    if (options.files?.includes('frame-guard.js')) {
      assert.equal((await request(w, 'acquire')).allowed, true, 'explicit return allows preflight before ownership changes');
      await w.ui({ method: 'takeover' });
      assert.equal((await request(w, 'renew')).allowed, false);
    }
    return [{ result: { active: true } }];
  };
  assert.match((await w.ui({ method: 'return' })).error, /停止或接管/);
  assert.equal(attempts, 0);
  assert.equal((await w.state()).ownership, 'user');
});

test('Chrome cancellation and service disconnect revoke guards without replaying input', async t => {
  for (const cause of ['canceled_by_user', 'disconnect']) await t.test(cause, async t => {
    const w = await worker(); t.after(w.close);
    await w.handle('claim', { sessionId: 'one', tabId: 7 });
    await request(w, 'acquire');
    if (cause === 'disconnect') w.socket.close(); else w.chrome.debugger.onDetach.fire({ tabId: 7 }, cause);
    assert.equal((await request(w, 'renew')).allowed, false);
    assert.equal((await request(w, 'acquire')).allowed, false);
    assert.equal(w.calls.filter(call => call[0] === 'attach').length, 1);
    assert.equal(w.calls.some(call => String(call[0]).startsWith('Input.')), false);
  });
});

test('a proved frame interruption reconnects transport but reports the input outcome as unknown', async t => {
  const w = await worker(); t.after(w.close);
  await w.handle('claim', { sessionId: 'one', tabId: 7 });
  await request(w, 'acquire');
  w.chrome.scripting.executeScript = async () => [{ result: { active: true, lastRemovedAt: Date.now() } }];
  let inputs = 0;
  w.chrome.debugger.sendCommand = async () => {
    inputs++;
    w.chrome.debugger.onDetach.fire({ tabId: 7 }, 'target_closed');
    throw Error('Detached while handling command.');
  };
  await assert.rejects(w.handle('cdp', { sessionId: 'one', method: 'Input.insertText', params: {text:'once'} }), error => error.code === 'NATIVE_DEBUGGER_RECOVERED');
  assert.equal(inputs, 1);
  assert.equal(w.calls.filter(call => call[0] === 'attach').length, 2);
  assert.equal((await w.state()).ownership, 'agent');
  assert.equal((await w.state()).controlIssue, undefined);
});

test('a user stop wins over a pending automatic reconnect', async t => {
  const w = await worker(); t.after(w.close);
  await w.handle('claim', { sessionId: 'one', tabId: 7 });
  await request(w, 'acquire');
  w.chrome.scripting.executeScript = async () => [{ result: { active: true, lastRemovedAt: Date.now() } }];
  w.chrome.debugger.onDetach.fire({ tabId: 7 }, 'target_closed');
  await w.ui({ method: 'takeover' });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(w.calls.filter(call => call[0] === 'attach').length, 1);
  assert.equal((await w.state()).ownership, 'user');
  assert.equal((await w.state()).controlIssue, undefined);
});
