const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { PhoneVideoPreview } = loadCli('src/renderer/phone-video.ts');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

function fixture(t) {
  const saved = new Map(['window', 'VideoDecoder', 'EncodedVideoChunk'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const starts = [], reads = [], stops = [], painted = [], closed = [], decoders = [];
  let supported = true, changes = 0;
  globalThis.window = { phones: {
    videoStart: id => { const call = deferred(); starts.push({ id, ...call }); return call.promise; },
    videoRead: id => { const call = deferred(); reads.push({ id, ...call }); return call.promise; },
    videoStop: async id => { stops.push(id); }
  } };
  globalThis.EncodedVideoChunk = class { constructor(data) { Object.assign(this, data); } };
  globalThis.VideoDecoder = class {
    static async isConfigSupported() { return { supported }; }
    constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; this.decodeQueueSize = 0; decoders.push(this); }
    configure() { this.state = 'configured'; }
    decode(packet) { this.callbacks.output({ timestamp: packet.timestamp, displayWidth: 352, displayHeight: 800, close: () => closed.push(packet.timestamp) }); }
    close() { this.state = 'closed'; }
  };
  const preview = new PhoneVideoPreview(frame => painted.push(frame), () => changes++);
  t.after(() => {
    preview.stop();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  return { preview, starts, reads, stops, painted, closed, decoders, unsupported() { supported = false; }, get changes() { return changes; } };
}
const packet = { key: true, codec: 'avc1.42001f', timestamp: 1234, data: new Uint8Array([1, 2, 3]) };

test('switching device while startup is pending disposes the stale stream without decoding it', async t => {
  const h = fixture(t);
  h.preview.setTarget('first'); h.preview.setTarget('second');
  h.starts[0].resolve({ streamId: 'first-stream' }); await flush();
  assert.ok(h.stops.includes('first-stream')); assert.equal(h.reads.length, 0);
  h.starts[1].resolve({ streamId: 'second-stream' }); await flush();
  assert.equal(h.reads[0].id, 'second-stream');
  h.preview.stop(); h.reads[0].resolve({ packets: [packet], error: '' }); await flush();
  assert.equal(h.closed.length, 0); assert.ok(h.stops.includes('second-stream'));
});

test('one decoder paints live frames and closes every VideoFrame; hiding stops capture', async t => {
  const h = fixture(t); h.preview.setTarget('phone');
  h.starts[0].resolve({ streamId: 'live' }); await flush();
  h.reads[0].resolve({ packets: [packet], error: '' }); await flush();
  assert.equal(h.decoders.length, 1); assert.equal(h.closed.length, 1); assert.ok(h.preview.lastFrame > 0);
  h.preview.setTarget('phone'); assert.equal(h.starts.length, 1, 'sidebar and enlarged view reuse the current stream');
  h.preview.setTarget(''); assert.equal(h.decoders[0].state, 'closed'); assert.ok(h.stops.includes('live'));
  h.reads[1].resolve({ packets: [packet], error: '' }); await flush();
  assert.equal(h.closed.length, 1, 'a late batch cannot repaint a hidden preview');
});

test('unsupported decoding falls back once rather than repeatedly starting encoders', async t => {
  const h = fixture(t); h.unsupported(); h.preview.setTarget('phone');
  h.starts[0].resolve({ streamId: 'unsupported' }); await flush();
  h.reads[0].resolve({ packets: [packet], error: '' }); await flush();
  assert.equal(h.preview.active, false); assert.equal(h.changes, 1); assert.ok(h.stops.includes('unsupported'));
  h.preview.setTarget('phone'); assert.equal(h.starts.length, 1);
  h.preview.retry(); h.preview.setTarget('phone'); assert.equal(h.starts.length, 2);
  h.preview.stop(); h.starts[1].resolve({ streamId: 'retry' }); await flush();
});
