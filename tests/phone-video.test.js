const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { AnnexBVideo, PhoneVideoStream } = loadCli('src/main/phones/screen-video.ts');
const nal = (...bytes) => Buffer.from([0, 0, 0, 1, ...bytes]);
const sps = nal(0x67, 0x42, 0, 0x1f, 0xa0), pps = nal(0x68, 0xce, 0x80);
const first = nal(0x65, 0x80, 0x12, 0x34), slice = nal(0x65, 0x40, 0x56);
const delta = nal(0x41, 0x80, 0x78), next = nal(0x41, 0x80, 0x90);
const sample = Buffer.concat([sps, pps, first, slice, delta, next]);

test('Annex B video preserves pictures and parameter sets across every transport split', () => {
  for (let size = 1; size <= sample.length; size++) {
    const packets = [], parser = new AnnexBVideo(packet => packets.push(packet));
    for (let offset = 0; offset < sample.length; offset += size) parser.push(sample.subarray(offset, offset + size));
    assert.equal(packets.length, 2, `chunk size ${size}`);
    assert.equal(packets[0].codec, 'avc1.42001f');
    assert.equal(packets[0].key, true);
    assert.deepEqual(Buffer.from(packets[0].data), Buffer.concat([sps, pps, first, slice]));
    assert.equal(packets[1].key, false);
    assert.deepEqual(Buffer.from(packets[1].data), delta);
  }
});

test('a partial NAL is never published as a complete frame and buffering is bounded', () => {
  const packets = [], parser = new AnnexBVideo(packet => packets.push(packet));
  parser.push(Buffer.concat([sps, pps, first]));
  assert.equal(packets.length, 0);
  parser.push(Buffer.from([0, 0])); assert.equal(packets.length, 0);
  parser.push(Buffer.from([0, 1, 0x41])); assert.equal(packets.length, 0);
  parser.push(Buffer.from([0x80])); assert.equal(packets.length, 1);
  assert.throws(() => parser.push(Buffer.alloc(2 * 1024 * 1024)), /缓冲区/);
});

function fixture(t) {
  let done, callbacks, ended = 0, killed = 0, allowed = true;
  const calls = [], abort = new AbortController();
  const child = { done: new Promise(resolve => done = resolve), async write() {}, end() { ended++; }, abort() { killed++; done({ code: 0 }); } };
  const adb = { run: async args => { calls.push(args); return 'Physical size: 1440x3200\nOverride size: 1080x2400'; },
    spawn(args, options) { calls.push(args); callbacks = options; return child; } };
  const stream = new PhoneVideoStream(adb, 'test-phone', () => { if (!allowed) throw Error('paused'); }, abort.signal, require('node:path').resolve(__dirname, '../public/phone-video/preview.dex'));
  t.after(() => { stream.stop(); done({ code: 0 }); });
  return { stream, abort, calls, push: bytes => callbacks.stdout(bytes), revoke() { allowed = false; }, done,
    get ended() { return ended; }, get killed() { return killed; } };
}

const wire = () => Buffer.from('PPV1 '+JSON.stringify({type:'frame',codec:'avc1.42001f',key:true,timestamp:1,width:352,height:800,screenWidth:1240,screenHeight:2772,data:Buffer.from([0,10,13,26,255]).toString('base64')})+'\r\n');
test('video capture deploys its component, preserves binary bytes over Windows CRLF and stops via stdin', async t => {
  const h = fixture(t); await h.stream.start();
  assert.deepEqual(h.calls[0].slice(0, 3), ['-s', 'test-phone', 'push']);
  assert.match(h.calls[1][4], /app_process/);
  for(const byte of wire())h.push(Buffer.from([byte]));
  const result = await h.stream.read(); assert.equal(result.packets.length, 1); assert.equal(result.error, '');
  assert.deepEqual([...result.packets[0].data],[0,10,13,26,255]);
  assert.equal(result.packets[0].screenWidth,1240);
  h.abort.abort(); assert.equal(h.ended, 1);
  assert.equal((await h.stream.read()).packets.length, 0);
  h.push(wire()); assert.equal((await h.stream.read()).packets.length, 0, 'late frames cannot cross revocation');
});

test('pausing while a read waits discards queued frames and ends the capture', async t => {
  const h = fixture(t); await h.stream.start();
  const reading = h.stream.read();
  h.revoke(); h.push(wire());
  const result = await reading; assert.equal(result.packets.length, 0); assert.equal(result.error, 'paused');
  assert.equal(h.ended, 1);
});

test('an abandoned renderer stops its encoder without waiting for another phone frame', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const h = fixture(t); await h.stream.start();
  t.mock.timers.tick(3250);
  assert.equal(h.ended, 1);
  t.mock.timers.tick(1500); assert.equal(h.killed, 1);
});

test('a slow renderer cannot accumulate unbounded encoded frames', async t => {
  const h = fixture(t); await h.stream.start();
  h.push(Buffer.concat(Array.from({length:100},wire)));
  assert.equal(h.ended, 1);
  const result = await h.stream.read(); assert.equal(result.packets.length, 0); assert.match(result.error, /处理跟不上/);
});
