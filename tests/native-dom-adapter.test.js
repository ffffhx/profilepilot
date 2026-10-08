require('./helpers/native-dom-source.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { NativeBrowser } = require('../src/main/tasks/native-browser.ts');

function adapter() {
  const requests = [];
  const state = { profileId: 'native:test', connected: true, taskTabs: true, controlGeneration: 'fixture:0', ownership: 'agent', ownerSessionId: 'session' };
  const bridge = { states: () => [state], onEvent: () => () => {}, request: async (_profile, method, params, timeout) => {
    requests.push({ method, params, timeout });
    if (method === 'downloads.arm') return { token: 'watch-1' };
    if (method === 'downloads.start') return { id: 23 };
    if (method === 'downloads.wait') throw Error('等待下载超时');
    return {};
  } };
  const browser = new NativeBrowser(bridge, 'unused-artifacts');
  browser.fast.node = async () => ({ result: undefined });
  browser.fast.frameId = () => 'frame-2';
  browser.fast.execute = async () => { requests.push({ method: 'click' }); };
  return { browser, state, requests, task: { id: 'task', profileId: 'native:test', sessionId: 'session' } };
}

test('first claim forwards flat nativeTarget only once and does not recreate on resume', async () => {
  const f = adapter(); f.state.ownerSessionId = undefined;
  f.task.nativeTarget = { tabId: 321, newTab: false };
  await f.browser.tabs(f.task);
  assert.deepEqual(f.requests[0].params, { sessionId: 'session', tabId: 321, newTab: false });
  f.state.ownerSessionId = 'session';
  await f.browser.control(f.task, 'resume');
  assert.equal(f.requests.filter(r => r.method === 'claim').length, 1);
  assert.deepEqual(f.requests.at(-1).params, { sessionId: 'session', action: 'resume', controlGeneration: 'fixture:0' });
});

test('HTTP anchor download preserves query, starts once and exposes resumable ID on timeout', async () => {
  const f = adapter();
  f.browser.fast.node = async () => ({ result: 'https://fixture.test/export?report=31&token=fixture' });
  await assert.rejects(f.browser.download(f.task, { ref: 'e1', timeoutMs: 50 }), /download id=23/);
  assert.equal(f.requests.find(r => r.method === 'downloads.start').params.url, 'https://fixture.test/export?report=31&token=fixture');
  assert.equal(f.requests.filter(r => r.method === 'downloads.start').length, 1);
  assert.equal(f.requests.some(r => r.method === 'click'), false);
  await assert.rejects(f.browser.download(f.task, { operation: 'wait', id: 23, timeoutMs: 50 }), /download id=23/);
  assert.equal(f.requests.filter(r => r.method === 'downloads.start').length, 1);
});

test('JS and blob downloads arm before one click; timeout retains token for subsequent wait', async () => {
  for (const href of [undefined, 'blob:https://fixture.test/uuid']) {
    const f = adapter(); f.browser.fast.node = async () => ({ result: href });
    await assert.rejects(f.browser.download(f.task, { ref: 'e1', timeoutMs: 50 }), /token=watch-1/);
    assert.deepEqual(f.requests.map(r => r.method), ['downloads.arm', 'preparePointer', 'click', 'downloads.wait']);
    await assert.rejects(f.browser.download(f.task, { operation: 'wait', token: 'watch-1', timeoutMs: 50 }), /token=watch-1/);
    assert.equal(f.requests.filter(r => r.method === 'click').length, 1);
    assert.equal(f.requests.some(r => r.method === 'downloads.disarm'), false);
  }
});

test('failed click disarms; direct blob URL and invalid filenames never trigger a download', async () => {
  const f = adapter();
  f.browser.fast.execute = async () => { throw Error('stale element'); };
  await assert.rejects(f.browser.download(f.task, { ref: 'e1' }), /stale element/);
  assert.equal(f.requests.at(-1).method, 'downloads.disarm');
  const before = f.requests.length;
  await assert.rejects(f.browser.download(f.task, { url: 'blob:https://fixture.test/id' }), /HTTP/);
  for (const name of ['../report.csv', 'C:\\report.csv', 'NUL.txt', 'bad?.txt']) await assert.rejects(f.browser.download(f.task, { url: 'https://fixture.test/file', filename: name }), /文件名/);
  assert.equal(f.requests.length, before);
});

test('native keyboard normalizes Windows Control and macOS Meta without converting modified Enter into plain submission text', async () => {
  const f = adapter(), calls = [];
  f.browser.fast.press = async (_task, action, params) => calls.push({ action, params });
  for (const value of ['Control+a', 'Meta+a', 'Enter', 'Return', 'Control+Enter', 'Meta+Return', 'Escape', 'Space']) {
    await f.browser.execute(f.task, { kind: 'press', value, effect: 'read', summary: 'Keyboard fixture' });
  }
  assert.deepEqual(calls.map(call => [call.params.key, call.params.code, call.params.modifiers]), [
    ['a', 'KeyA', 2], ['a', 'KeyA', 4], ['Enter', 'Enter', 0], ['Enter', 'Enter', 0],
    ['Enter', 'Enter', 2], ['Enter', 'Enter', 4], ['Escape', 'Escape', 0], [' ', 'Space', 0]
  ]);
  assert.equal(calls[2].params.text, '\r'); assert.equal(calls[3].params.text, '\r');
  assert.equal(calls[4].params.text, undefined); assert.equal(calls[5].params.text, undefined);
  assert.equal(calls[7].params.text, ' ');
  for (const value of ['a', 'A', 'Control+Escape', 'Meta+Delete']) {
    await assert.rejects(f.browser.execute(f.task, { kind: 'press', value, effect: 'read', summary: 'Unsupported fixture' }), /不支持/);
  }
  assert.equal(calls.length, 8);
});
