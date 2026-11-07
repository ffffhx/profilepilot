const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const source = transformSync(fs.readFileSync('src/desktop-preload.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code;
const nonce = '1cec77a4-1582-4ab7-a1d8-c972c6cda96b';
function fixture(options = {}) {
  const calls = [], events = new Map(); let api;
  vm.runInNewContext(source, { location: { search: '?notice=' + nonce }, URLSearchParams,
    window: { addEventListener(name, callback, options) { events.set(name, { callback, options }); } },
    require(name) { assert.equal(name, 'electron'); return {
      contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'desktopControl'); api = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); if (options.syncError) throw new Error('Transport gone');
        return options.reject ? Promise.reject(new Error('Transport gone')) : Promise.resolve(); }, on() {}, removeListener() {} }
    }; }
  });
  return { api, calls, events };
}

test('sandbox preload binds readiness to the loaded document nonce and exposes no arbitrary IPC', async () => {
  const f = fixture(); await f.api.noticeReady('generation-1');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [['desktop:request', 'notice-ready', { generation: 'generation-1', documentNonce: nonce }]]);
  assert.deepEqual(Object.keys(f.api).sort(), ['control', 'noticeFailed', 'noticeReady', 'onChanged', 'status']);
});

test('sandbox return carries only the displayed identity and never fills missing fields from current status', async () => {
  const f = fixture();
  await f.api.control('return', { session: 'old-owner', generation: 'old-generation', revision: 3, private: true });
  await f.api.control('takeover', { session: 'ignored' }); await f.api.control('stop'); await f.api.control('return');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [
    ['desktop:request', 'control', { action: 'return', session: 'old-owner', generation: 'old-generation', revision: 3 }],
    ['desktop:request', 'control', 'takeover'], ['desktop:request', 'control', 'stop'], ['desktop:request', 'control', { action: 'return' }]
  ]);
});

for (const event of ['pagehide', 'error', 'unhandledrejection']) test('preload revokes the document once and refuses late readiness after ' + event, async () => {
  const f = fixture(); await f.api.noticeReady('generation-1');
  f.events.get(event).callback(); f.events.get('pagehide').callback();
  await assert.rejects(f.api.noticeReady('generation-2'), /unavailable/);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [
    ['desktop:request', 'notice-ready', { generation: 'generation-1', documentNonce: nonce }],
    ['desktop:request', 'notice-unavailable', { documentNonce: nonce }]
  ]);
  assert.equal(f.events.get('error').options.capture, true, 'Missing script resource errors must also revoke readiness');
});

test('missing page script error is reported before any page readiness call', async () => {
  const f = fixture(); f.events.get('error').callback();
  await assert.rejects(f.api.noticeReady('generation-1'), /unavailable/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1], 'notice-unavailable');
});

test('main-world failure bridge only revokes its bound document once, ignoring caller arguments', async () => {
  const f = fixture(); await f.api.noticeReady('generation-1');
  assert.equal(typeof f.api.noticeFailed, 'function');
  f.api.noticeFailed({ documentNonce: 'foreign', channel: 'arbitrary', action: 'return' });
  f.api.noticeFailed(); f.events.get('error').callback(); f.events.get('pagehide').callback();
  await assert.rejects(f.api.noticeReady('generation-2'), /unavailable/);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [
    ['desktop:request', 'notice-ready', { generation: 'generation-1', documentNonce: nonce }],
    ['desktop:request', 'notice-unavailable', { documentNonce: nonce }]
  ]);
});

for (const option of ['syncError', 'reject']) test('failed revocation transport never clears the document failure latch: ' + option, async () => {
  const f = fixture({ [option]: true });
  assert.doesNotThrow(() => f.api.noticeFailed()); assert.doesNotThrow(() => f.api.noticeFailed());
  await assert.rejects(f.api.noticeReady('later-generation'), /unavailable/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1], 'notice-unavailable');
});
