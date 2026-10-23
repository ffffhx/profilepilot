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
  assert.ok(offsets.slice().sort((a, b) => a - b).every((offset, i) => offset === i * CHUNK));
  const timings = phoneRequestTimings(0);
  assert.ok(timings.length > 0);
  assert.ok(timings.every(value => value.operation === 'screenshot-chunk' && value.responseBytes < 50 * 1024));
});

test('old companion full screenshots and rejected captures never request pages', async () => {
  for (const initial of [{ state, result: { mime: 'image/png', base64: 'old-full-image' } }, { state, result: null }]) {
    assert.equal(await assembleScreenshot(initial, owner, () => { throw new Error('unexpected page'); }, () => true), initial);
  }
});

const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('two non-final pages overlap, preserve byte order, and the last page cannot clear an in-flight cache', async () => {
  const f = fixture(140000), last = Math.floor((f.base64.length - 1) / CHUNK) * CHUNK;
  const pending = new Map(), requested = [], completed = new Set();
  let active = 0, maximum = 0, cacheExists = true;
  const output = assembleScreenshot(f.initial, owner, async ({ offset }) => {
    requested.push(offset); active++; maximum = Math.max(maximum, active);
    assert.equal(cacheExists, true, 'the terminal page invalidates the immutable phone cache');
    if (offset === last) {
      assert.equal(active, 1, 'terminal read must be alone behind the completion barrier');
      assert.equal(completed.size, last / CHUNK);
      cacheExists = false; active--; return f.page(offset);
    }
    const gate = deferred(); pending.set(offset, gate); await gate.promise;
    assert.equal(cacheExists, true, 'a delayed earlier page must survive until its response is read');
    completed.add(offset); active--; return f.page(offset);
  }, () => true);
  assert.deepEqual(requested, [0, CHUNK]);
  pending.get(CHUNK).resolve(); await turn();
  assert.deepEqual(requested, [0, CHUNK, 2 * CHUNK]);
  pending.get(2 * CHUNK).resolve(); await turn();
  assert.equal(requested.includes(last), false, 'first page is still in flight');
  pending.get(0).resolve();
  const result = await output;
  assert.equal(maximum, 2); assert.equal(cacheExists, false);
  assert.deepEqual(Buffer.from(result.result.base64, 'base64'), f.png, 'completion order cannot change image byte order');
  assert.deepEqual(requested, [0, CHUNK, 2 * CHUNK, last]);
});

test('a failed parallel page stops scheduling and settles its peer without retrying or reading the terminal page', async () => {
  const f = fixture(400000), pending = new Map(), requested = []; let settled = false;
  const output = assembleScreenshot(f.initial, owner, async ({ offset }) => {
    requested.push(offset); const gate = deferred(); pending.set(offset, gate);
    await gate.promise; return f.page(offset);
  }, () => true).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  assert.deepEqual(requested, [0, CHUNK]);
  pending.get(0).reject(new Error('first page link failed')); await turn();
  assert.equal(settled, false, 'already-issued peer must finish before the transfer settles');
  assert.deepEqual(requested, [0, CHUNK], 'failure cannot schedule another page or replay capture');
  pending.get(CHUNK).resolve();
  const result = await output;
  assert.match(result.error.message, /first page link failed/); assert.equal(result.value, undefined);
  assert.deepEqual(requested, [0, CHUNK]);
});

test('pause, owner replacement, and TTL expiry while parallel pages are pending never issue a final read', async () => {
  for (const mutation of ['route', 'generation', 'phase', 'ttl']) {
    const f = fixture(140000), pending = new Map(), requested = []; let current = true, now = 0;
    const output = assembleScreenshot(f.initial, owner, async ({ offset }) => {
      requested.push(offset); const gate = deferred(); pending.set(offset, gate);
      return await gate.promise;
    }, () => current, () => now).then(value => ({ value }), error => ({ error }));
    assert.deepEqual(requested, [0, CHUNK]);
    if (mutation === 'route') current = false;
    if (mutation === 'ttl') now = 15000;
    const changed = f.page(CHUNK);
    if (mutation === 'generation') changed.state = { ...state, generation: 8 };
    if (mutation === 'phase') changed.state = { ...state, phase: 'paused' };
    pending.get(CHUNK).resolve(changed); await turn();
    assert.deepEqual(requested, [0, CHUNK]);
    pending.get(0).resolve(f.page(0));
    const result = await output;
    assert.ok(result.error, mutation); assert.equal(result.value, undefined);
    assert.deepEqual(requested, [0, CHUNK]);
  }
});

test('single-page and exact-boundary images use their terminal page exactly once', async () => {
  for (const bytes of [20, CHUNK * 3 / 4 - 8]) {
    const f = fixture(bytes), offsets = [];
    const output = await assembleScreenshot(f.initial, owner, async ({ offset }) => {
      offsets.push(offset); return f.page(offset);
    }, () => true);
    assert.deepEqual(offsets, [0]); assert.equal(output.result.base64, f.base64);
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

const cameraProof = () => ({ version: 1, epoch: 2, sequence: 4, x: 340, y: 210,
  heldSinceUptimeMs: 100, capturedAtUptimeMs: 300, expiresAtUptimeMs: 1300 });
test('camera proof belongs to the immutable frame and is not refreshed while pages arrive', async () => {
  const f = fixture(); f.initial.result.cameraProof = cameraProof(); let now = 10000;
  const result = await assembleScreenshot(f.initial, owner, async ({ offset }) => {
    // Later phone/host state cannot change the descriptor's original proof.
    f.initial.result.cameraProof.epoch = 99; now += 100;
    return f.page(offset);
  }, () => true, () => now);
  assert.deepEqual(result.result.cameraProof, cameraProof());
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)).cameraProof, cameraProof());
  assert.deepEqual(Buffer.from(result.result.base64, 'base64'), f.png);
});
test('invalid camera proof fails before any pages, including cropped or out-of-screen frames', async () => {
  for (const patch of [{ version: 2 }, { sequence: 0 }, { epoch: -1 }, { x: 2772 }, { y: 1240 },
    { heldSinceUptimeMs: 301 }, { expiresAtUptimeMs: 300 }, { capturedAtUptimeMs: NaN }, { extra: true }]) {
    const f = fixture(); f.initial.result.cameraProof = { ...cameraProof(), ...patch };
    let calls = 0;
    await assert.rejects(assembleScreenshot(f.initial, owner, async () => { calls++; }, () => true));
    assert.equal(calls, 0);
  }
  const f = fixture(); f.initial.result.cameraProof = cameraProof(); f.initial.result.region = { x: 0, y: 0, width: 425, height: 425 };
  await assert.rejects(assembleScreenshot(f.initial, owner, () => { throw Error('unexpected page'); }, () => true));
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
    assert.equal(calls, 2, 'only the two already-issued pages may complete after rejection');
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
    assert.equal(calls, 2, 'malformed data cannot schedule beyond the two already-issued pages');
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
