const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { cameraCaptureWindow, waitForCameraCapture } = loadCli('src/main/phones/game-follow-camera-cadence.ts');

const oldPoint = { x: 364, y: 315 }, newPoint = { x: 356, y: 315 };
function clock(start, onWait) {
  let now = start;
  const waits = [];
  return { waits, get nowValue() { return now; }, set nowValue(value) { now = value; },
    now: () => now,
    wait: async ms => { waits.push(ms); now += ms; onWait?.(now); } };
}

test('a completed full-frame download cannot bypass the post-recenter capture window', async () => {
  // The previous descriptor+350 cadence elapsed while its pages were assembled.
  // A recenter ACK must not immediately trigger a screenshot at that old time.
  const c = clock(700), window = cameraCaptureWindow(oldPoint, newPoint, 680, 700, 1200);
  assert.equal(await waitForCameraCapture(window, 500, () => true, c), 'ready');
  assert.equal(c.nowValue, 1130);
  assert.equal(window.expiresAt, 1880, 'deadline starts at plan creation, not ACK or wake-up');
  assert.ok(c.waits.every(ms => ms > 0 && ms <= 25));
});

test('initial DOWN, same-point renewal and camera release keep distinct scheduling semantics', () => {
  assert.deepEqual(cameraCaptureWindow(undefined, newPoint, 100, 130, 1500), { notBefore: 430, expiresAt: 1600 });
  assert.equal(cameraCaptureWindow(oldPoint, { ...oldPoint }, 100, 130, 1200), undefined);
  assert.equal(cameraCaptureWindow(oldPoint, null, 100, 130, 1200), undefined);
  assert.equal(cameraCaptureWindow(undefined, null, 100, 130, 1200), undefined);
});

test('the ordinary capture interval is still respected when it is later', async () => {
  const c = clock(700), window = cameraCaptureWindow(oldPoint, newPoint, 680, 700, 1200);
  assert.equal(await waitForCameraCapture(window, 1250, () => true, c), 'ready');
  assert.equal(c.nowValue, 1250);
  assert.equal(window.expiresAt, 1880);
});

test('an unavailable TTL slot releases immediately instead of waiting, capturing, or extending input', async () => {
  for (const ttl of [100, 430, 450]) {
    const c = clock(700), window = cameraCaptureWindow(oldPoint, newPoint, 680, 700, ttl);
    assert.equal(await waitForCameraCapture(window, 500, () => true, c), 'expired');
    assert.deepEqual(c.waits, []);
    assert.equal(window.expiresAt, 680 + ttl);
  }
  const c = clock(700), window = cameraCaptureWindow(oldPoint, newPoint, 680, 700, 1200);
  assert.equal(await waitForCameraCapture(window, 1880, () => true, c), 'expired');
  assert.deepEqual(c.waits, []);
});

test('stop, observed pause, or a new recovery epoch can interrupt before any next capture', async () => {
  for (const cause of ['stop', 'pause', 'recovery']) {
    let current = true;
    const c = clock(700, now => { if (now >= 775) current = false; });
    const window = cameraCaptureWindow(oldPoint, newPoint, 680, 700, 1200);
    assert.equal(await waitForCameraCapture(window, 500, () => current, c), 'cancelled', cause);
    assert.equal(c.nowValue, 775);
    assert.equal(window.expiresAt, 1880);
  }
});

test('host timer stalls past TTL and invalid clocks never produce readiness', async () => {
  const window = cameraCaptureWindow(oldPoint, newPoint, 680, 700, 1200);
  for (const wakeAt of [1880, 2000, 699, NaN]) {
    const c = clock(700); c.wait = async () => { c.nowValue = wakeAt; };
    assert.equal(await waitForCameraCapture(window, 500, () => true, c), 'expired');
  }
});

test('ACK latency consumes the original TTL and never shifts its end', async () => {
  const window = cameraCaptureWindow(oldPoint, newPoint, 100, 1100, 1200), c = clock(1100);
  assert.equal(window.expiresAt, 1300);
  assert.equal(await waitForCameraCapture(window, 500, () => true, c), 'expired');
  assert.equal(c.waits.length, 0);
  for (const args of [[100, 99, 1200], [NaN, 200, 1200], [100, 200, 99], [100, 200, 1501]])
    assert.throws(() => cameraCaptureWindow(oldPoint, newPoint, ...args), /scheduling/);
});
