const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { loadCli } = require('./cli-test-build.cjs');
const { NativeBrowserBridge } = loadCli('src/main/tasks/native-bridge.ts');

// Reuse the Chrome API fixture while executing the current production worker.
// No sockets, browser process, discovery files or installed extension are used.
const source = fs.readFileSync('tests/native-control.test.js', 'utf8');
const workerSource = source.slice(source.indexOf('async function worker()'), source.indexOf("test('full-access"));
const worker = new Function('fs', 'vm', `${workerSource}; return worker;`)(fs, vm);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function command(w, id, method, params) {
  w.socket.receive({ id, method, params });
  const deadline = Date.now() + 2000;
  while (!w.messages.some(message => message.id === id)) {
    if (Date.now() > deadline) throw Error(`No fixture reply to ${id}`);
    await tick();
  }
  return w.messages.find(message => message.id === id);
}

test('worker rejects a resume carrying permission from before a repeated stop, even if desktop has not observed state', async t => {
  const w = await worker(); t.after(w.close);
  await w.handle('claim', { sessionId: 'one', tabId: 7 });
  await w.ui({ method: 'takeover' });
  const authorized = (await w.state()).controlGeneration;
  await w.ui({ method: 'takeover' });
  const stopped = (await w.state()).controlGeneration;
  assert.notEqual(stopped, authorized);
  const before = w.calls.length;
  const stale = await command(w, 101, 'control', { sessionId: 'one', action: 'resume', controlGeneration: authorized });
  assert.match(stale.error, /已停止或接管/);
  assert.equal(w.calls.length, before, 'stale permission never attaches or executes CDP');
  assert.equal((await w.state()).ownership, 'user');
  assert.equal((await w.state()).controlGeneration, stopped, 'ordinary state reads do not manufacture stops');
  const fresh = await command(w, 102, 'control', { sessionId: 'one', action: 'resume', controlGeneration: stopped });
  assert.equal(fresh.error, undefined);
  assert.equal((await w.state()).ownership, 'agent');
});

test('a worker restart changes permission even with the same numeric stop epoch', async t => {
  const before = await worker(), after = await worker(); t.after(before.close); t.after(after.close);
  await before.handle('claim', { sessionId: 'one', tabId: 7 });
  await after.handle('claim', { sessionId: 'one', tabId: 7 });
  await before.ui({ method: 'takeover' }); await after.ui({ method: 'takeover' });
  const oldGeneration = (await before.state()).controlGeneration, newGeneration = (await after.state()).controlGeneration;
  assert.equal(oldGeneration.split(':')[1], newGeneration.split(':')[1]);
  assert.notEqual(oldGeneration, newGeneration);
  assert.match((await command(after, 103, 'control', { sessionId: 'one', action: 'resume', controlGeneration: oldGeneration })).error, /已停止或接管/);
  assert.equal((await after.state()).ownership, 'user');
  assert.match((await command(after, 104, 'control', { sessionId: 'one', action: 'resume' })).error, /更新 ProfilePilot 应用/);
});

test('UI return waiting for tab preparation cannot overwrite a newer takeover or disconnect', async t => {
  for (const stopping of ['takeover', 'disconnect']) await t.test(stopping, async t => {
    const w = await worker(); t.after(w.close);
    await w.handle('claim', { sessionId: 'one', tabId: 7 });
    await w.ui({ method: 'takeover' });
    const started = deferred(), finish = deferred(), get = w.chrome.tabs.get;
    let first = true;
    w.chrome.tabs.get = async id => { if (first) { first = false; started.resolve(); await finish.promise; } return get(id); };
    const returning = w.ui({ method: 'return' });
    await started.promise;
    if (stopping === 'takeover') await w.ui({ method: 'takeover' }); else w.socket.close();
    const stopped = (await w.state()).controlGeneration;
    finish.resolve();
    assert.match((await returning).error, /已停止或接管/);
    const state = await w.state();
    assert.equal(state.ownership, 'user'); assert.equal(state.sessionId, 'one');
    assert.equal(state.controlGeneration, stopped);
  });
});

test('takeover during asynchronous debugger attach also cancels UI return', async t => {
  const w = await worker(); t.after(w.close);
  await w.handle('claim', { sessionId: 'one', tabId: 7 });
  w.chrome.debugger.onDetach.fire({ tabId: 7 }, 'canceled_by_user');
  const started = deferred(), finish = deferred();
  w.chrome.debugger.attach = async () => { started.resolve(); await finish.promise; };
  const returning = w.ui({ method: 'return' });
  await started.promise; await w.ui({ method: 'takeover' });
  const stopped = (await w.state()).controlGeneration;
  finish.resolve();
  assert.match((await returning).error, /已停止或接管/);
  assert.equal((await w.state()).ownership, 'user');
  assert.equal((await w.state()).controlGeneration, stopped, 'stale attach cleanup cannot advance or overwrite newer stop state');
  assert.ok(w.calls.some(call => call[0] === 'detach'));
});

test('bridge preserves a valid stop generation and drops missing or malformed advertisements', () => {
  const events = [];
  // Call the actual receive parser without constructing its HTTP listener.
  const bridge = Object.create(NativeBrowserBridge.prototype);
  bridge.emit = event => events.push(event);
  bridge.onboarding = { connected() {} };
  const connection = { state: { profileId: 'native:fixture' } };
  for (const [value, expected] of [['worker-id:23', 'worker-id:23'], [undefined, undefined], [{ epoch: 23 }, undefined], ['x'.repeat(81) + ':1', undefined], ['worker:-1', undefined]]) {
    bridge.receive(connection, { type: 'state', state: { ownership: 'user', controlGeneration: value } });
    assert.equal(connection.state.controlGeneration, expected);
    assert.equal(events.at(-1).state.controlGeneration, expected);
  }
});
