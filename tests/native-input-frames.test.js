const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('tests/native-control.test.js', 'utf8');
const workerSource = source.slice(source.indexOf('async function worker()'), source.indexOf("test('full-access"));
const worker = new Function('fs', 'vm', `${workerSource}; return worker;`)(fs, vm);
const tick = () => new Promise(resolve => setImmediate(resolve));
const input = (w, method = 'Input.dispatchMouseEvent', extra = {}) => w.handle('cdp', {
  sessionId: 'one', method, params: { type: 'mouseMoved', x: 100, y: 100, buttons: 1 }, ...extra
});
async function fixture(t) {
  const w = await worker(); t.after(w.close);
  await w.handle('claim', { sessionId: 'one', tabId: 8 });
  return w;
}

test('background input requests a compositor frame before waiting for the real input ACK', async t => {
  const w = await fixture(t), calls = []; let acknowledge;
  w.chrome.debugger.sendCommand = (target, method, params) => {
    calls.push({ target, method, params });
    if (method === 'Input.dispatchMouseEvent') return new Promise(resolve => { acknowledge = resolve; });
    assert.equal(method, 'Page.captureScreenshot');
    acknowledge({ actualInputAck: true });
    return Promise.resolve({ data: 'discard-this-image' });
  };
  assert.deepEqual(await input(w), { actualInputAck: true });
  assert.deepEqual(calls.map(c => c.method), ['Input.dispatchMouseEvent', 'Page.captureScreenshot']);
  const capture = calls[1];
  assert.equal(capture.target.tabId, 8);
  assert.equal(capture.params.clip, undefined);
  assert.equal(capture.params.format, 'jpeg'); assert.equal(capture.params.quality, 1);
  assert.equal(capture.params.fromSurface, true); assert.equal(capture.params.captureBeyondViewport, false);
  assert.equal(w.calls.some(c => c === 'focus' || c[0] === 'update'), false, 'background/minimized tabs stay in place');
});

test('a completed or failed capture cannot acknowledge, retry, or conceal an input', async t => {
  for (const captureFails of [false, true]) await t.test(String(captureFails), async t => {
    const w = await fixture(t); let acknowledge, count = 0, settled = false;
    w.chrome.debugger.sendCommand = (_target, method) => {
      if (method === 'Page.captureScreenshot') return captureFails ? Promise.reject(Error('No surface')) : Promise.resolve({ data: 'frame' });
      count++; return new Promise(resolve => { acknowledge = resolve; });
    };
    const operation = input(w).then(result => { settled = true; return result; });
    await tick(); assert.equal(settled, false, 'only the real input response completes input');
    acknowledge({ sent: true }); assert.deepEqual(await operation, { sent: true }); assert.equal(count, 1);
    const failure = Error('Unsupported input');
    w.chrome.debugger.sendCommand = (_target, method) => method === 'Page.captureScreenshot' ? Promise.resolve({ data: 'frame' }) : Promise.reject(failure);
    await assert.rejects(input(w), error => error === failure);
    assert.equal((await w.state()).ownership, 'agent');
  });
});

test('slow capture is coalesced without blocking subsequent input or flooding Chrome', async t => {
  const w = await fixture(t); let finishCapture, captures = 0, inputs = 0;
  w.chrome.debugger.sendCommand = (_target, method) => {
    if (method === 'Page.captureScreenshot') { captures++; return new Promise(resolve => { finishCapture = resolve; }); }
    inputs++; return Promise.resolve({ sent: true });
  };
  for (let n = 0; n < 8; n++) await input(w);
  assert.equal(inputs, 8); assert.equal(captures, 1);
  finishCapture({ data: 'frame' }); await tick();
  assert.equal(captures, 2, 'one follow-up frame covers inputs sent during the first capture');
  finishCapture({ data: 'frame' }); await tick(); assert.equal(captures, 2);
});

test('handoff, cancellation and target changes stop an outstanding frame request from continuing', async t => {
  for (const change of ['handoff', 'cancel', 'switch']) await t.test(change, async t => {
    const w = await fixture(t), captures = []; let finishCapture;
    w.chrome.debugger.sendCommand = (target, method) => {
      if (method === 'Page.captureScreenshot') { captures.push(target.tabId); return new Promise(resolve => { finishCapture = resolve; }); }
      return Promise.resolve({});
    };
    await input(w); await input(w);
    if (change === 'handoff') await w.handle('control', { sessionId: 'one', action: 'handoff' });
    else if (change === 'cancel') w.chrome.debugger.onDetach.fire({ tabId: 8 }, 'canceled_by_user');
    else await w.handle('switch', { sessionId: 'one', tabId: 7 });
    finishCapture({ data: 'stale frame' }); await tick();
    assert.deepEqual(captures, [8]);
    if (change !== 'switch') await assert.rejects(input(w), /用户正在/);
    else { await input(w); assert.deepEqual(captures, [8, 7]); finishCapture({ data: 'new frame' }); }
  });
});

test('child-frame input keeps its debugger target and requests the shared root surface', async t => {
  const w = await fixture(t), calls = [];
  w.chrome.debugger.onEvent.fire({ tabId: 8 }, 'Target.attachedToTarget', { sessionId: 'child', targetInfo: { type: 'iframe' } });
  w.chrome.debugger.sendCommand = async (target, method) => { calls.push({ target, method }); return {}; };
  await input(w, 'Input.dispatchMouseEvent', { cdpSessionId: 'child' });
  assert.equal(calls[0].target.sessionId, 'child');
  assert.equal(calls[1].target.sessionId, undefined); assert.equal(calls[1].target.tabId, 8);
});

test('keyboard, touch and IME inputs draw frames, while ordinary reads and screenshots do not recurse', async t => {
  const w = await fixture(t), calls = [];
  w.chrome.debugger.sendCommand = async (_target, method) => { calls.push(method); return {}; };
  for (const method of ['Input.dispatchKeyEvent', 'Input.dispatchTouchEvent', 'Input.insertText', 'Input.imeSetComposition']) await input(w, method);
  assert.equal(calls.filter(m => m === 'Page.captureScreenshot').length, 4);
  calls.length = 0;
  await input(w, 'Runtime.evaluate'); await input(w, 'Page.captureScreenshot');
  assert.deepEqual(calls, ['Runtime.evaluate', 'Page.captureScreenshot']);
});
