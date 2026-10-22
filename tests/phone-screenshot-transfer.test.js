const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const http = require('node:http');
const { loadCli } = require('./cli-test-build.cjs');
const { assembleScreenshot, captureReadyAt } = loadCli('src/main/phones/screenshot-transfer.ts');
const { phoneRequest, phoneRequestTimings } = loadCli('src/main/phones/adb.ts');
const owner = { instanceId: 'instance', sessionId: 'session', generation: 7 };
const state = { ...owner, phase: 'viewing' };
const CHUNK = 48 * 1024;
function fixture(bytes = 120000) {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(bytes)]), base64 = png.toString('base64');
  const transfer = { protocol: 1, id: randomUUID(), length: base64.length, chunkSize: CHUNK, ttlMs: 15000 };
  const initial = { state, result: { mime: 'image/png', width: 2772, height: 1240, transfer } };
  const page = offset => ({ state, result: { id: transfer.id, offset, base64: base64.slice(offset, offset + CHUNK), done: offset + CHUNK >= base64.length } });
  return { png, base64, initial, page };
}

test('small HTTP screenshot pages preserve every PNG byte and the original result shape', async t => {
  const f = fixture(1024 * 1024), offsets = [];
  const server = http.createServer(async (request, response) => {
    let data = ''; for await (const part of request) data += part;
    assert.equal(request.headers.authorization, 'Bearer local-test');
    assert.equal(request.url, '/screenshot-chunk');
    const body = JSON.parse(data); assert.deepEqual({ instanceId: body.instanceId, sessionId: body.sessionId, generation: body.generation }, owner);
    assert.equal(body.transferId, f.initial.result.transfer.id); offsets.push(body.offset);
    const payload = JSON.stringify(f.page(body.offset)); assert.ok(Buffer.byteLength(payload) < 50 * 1024);
    response.end(payload);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const output = await assembleScreenshot(f.initial, owner,
    body => phoneRequest(server.address().port, 'local-test', 'screenshot-chunk', body), () => true);
  assert.deepEqual(Buffer.from(output.result.base64, 'base64'), f.png);
  assert.deepEqual(output.result, { mime: 'image/png', width: 2772, height: 1240, base64: f.base64 });
  assert.equal(offsets.length, Math.ceil(f.base64.length / CHUNK));
  assert.ok(offsets.every((offset, i) => offset === i * CHUNK));
  const timings = phoneRequestTimings(0);
  assert.ok(timings.length > 0);
  assert.ok(timings.every(value => value.operation === 'screenshot-chunk' && value.responseBytes < 50 * 1024));
});

test('old companion full screenshots and rejected captures never request pages', async () => {
  for (const initial of [{ state, result: { mime: 'image/png', base64: 'old-full-image' } }, { state, result: null }]) {
    assert.equal(await assembleScreenshot(initial, owner, () => { throw new Error('unexpected page'); }, () => true), initial);
  }
});

test('chunked JPEG frames retain native screen dimensions and optional crop origin', async () => {
  for (const region of [undefined, { x: 120, y: 36, width: 425, height: 425 }]) {
    const f = fixture(400000); f.initial.result.mime = 'image/jpeg';
    if (region) f.initial.result.region = region;
    let pages = 0;
    const output = await assembleScreenshot(f.initial, owner, async ({ offset }) => {
      pages++; return f.page(offset);
    }, () => true);
    assert.deepEqual(output.result, { mime: 'image/jpeg', width: 2772, height: 1240,
      ...(region ? { region } : {}), base64: f.base64 });
    assert.equal(pages, Math.ceil(f.base64.length / CHUNK));
  }
});

test('capture readiness belongs only to the fully assembled host object and cannot be serialized or forged', async () => {
  const f = fixture(); let now = 40;
  const output = await assembleScreenshot(f.initial, owner, async ({ offset }) => {
    now += 25; return f.page(offset);
  }, () => true, () => now);
  assert.equal(captureReadyAt(output.result), 40);
  assert.equal(captureReadyAt(f.initial.result), undefined);
  assert.equal(captureReadyAt({ ...output.result, captureReadyAt: 40 }), undefined);
  assert.equal(captureReadyAt(JSON.parse(JSON.stringify(output.result))), undefined);
  assert.deepEqual(Object.keys(output.result).sort(), ['mime', 'width', 'height', 'base64'].sort());
  const old = { state, result: { mime: 'image/png', base64: 'old-full-image' } };
  await assembleScreenshot(old, owner, () => { throw Error('unexpected'); }, () => true);
  assert.equal(captureReadyAt(old.result), undefined);
});

test('invalid frame regions reject before downloading any chunk', async () => {
  for (const region of [
    { x: -1, y: 0, width: 425, height: 425 }, { x: 0.5, y: 0, width: 425, height: 425 },
    { x: 2600, y: 0, width: 425, height: 425 }, { x: 0, y: 1200, width: 425, height: 425 },
    { x: 0, y: 0, width: 0, height: 425 }, { x: 0, y: 0, width: 425, height: 425, extra: 1 }
  ]) {
    const f = fixture(); f.initial.result.region = region; let calls = 0;
    await assert.rejects(assembleScreenshot(f.initial, owner, async () => { calls++; }, () => true));
    assert.equal(calls, 0);
  }
});

test('a stop or route change during download rejects without publishing partial image or replaying capture', async () => {
  for (const mutation of ['generation', 'sessionId', 'instanceId', 'phase', 'route']) {
    const f = fixture(); let current = true, calls = 0;
    await assert.rejects(assembleScreenshot(f.initial, owner, async ({ offset }) => {
      calls++; const response = f.page(offset);
      if (calls === 2) {
        if (mutation === 'route') current = false;
        else response.state = { ...state, [mutation]: mutation === 'generation' ? 8 : mutation === 'phase' ? 'paused' : 'replacement' };
      }
      return response;
    }, () => current), /会话已改变/);
    assert.equal(calls, 2);
  }
});

test('each authoritative PNG page still requires a completed phone phase', async () => {
  for (const phase of ['executing', 'paused', 'stopped', 'disconnected']) {
    const f = fixture(); let calls = 0;
    await assert.rejects(assembleScreenshot(f.initial, owner, async ({ offset }) => {
      calls++; return { ...f.page(offset), state: { ...state, phase } };
    }, () => true), /会话已改变/);
    assert.equal(calls, 1);
  }
});

test('mismatched, truncated, oversized and incomplete pages fail closed', async () => {
  for (const mutate of [
    page => { page.result.id = randomUUID(); },
    page => { page.result.offset++; },
    page => { page.result.base64 = page.result.base64.slice(4); },
    page => { page.result.base64 += 'AAAA'; },
    page => { page.result.done = true; },
    page => { page.result.base64 = '=' + page.result.base64.slice(1); }
  ]) {
    const f = fixture(); let calls = 0;
    await assert.rejects(assembleScreenshot(f.initial, owner, async ({ offset }) => { calls++; const page = f.page(offset); mutate(page); return page; }, () => true));
    assert.equal(calls, 1);
  }
  const f = fixture();
  await assert.rejects(assembleScreenshot(f.initial, owner, async () => { throw new Error('link lost'); }, () => true), /link lost/);
});

test('total transfer expiry is bounded even if each individual page arrives', async () => {
  const f = fixture(); let now = 0, calls = 0;
  await assert.rejects(assembleScreenshot(f.initial, owner, async ({ offset }) => {
    calls++; now += 5000; return f.page(offset);
  }, () => true, () => now), /过期/);
  assert.equal(calls, 3);
});

test('invalid negotiated descriptors are rejected before any page', async () => {
  for (const patch of [{ length: 8 * 1024 * 1024 }, { length: 3 }, { chunkSize: 1024 * 1024 }, { ttlMs: 600000 }, { protocol: 2 }]) {
    const f = fixture(); Object.assign(f.initial.result.transfer, patch);
    await assert.rejects(assembleScreenshot(f.initial, owner, async () => { throw new Error('unexpected page'); }, () => true));
  }
});
