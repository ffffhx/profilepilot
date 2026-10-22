const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { GameFollowCamera } = loadCli('src/main/phones/game-follow-camera.ts');
const options = { enabled: true, mode: 'control', backend: 'app', provenanceVersion: 1 };
const target = { x: 240, y: 300 };
const lost = { lost: true };
const proof = (patch = {}) => ({ version: 1, epoch: 7, sequence: 2, ...target,
  heldSinceUptimeMs: 100000, capturedAtUptimeMs: 100300, expiresAtUptimeMs: 101200, ...patch });
function armed() {
  const machine = new GameFollowCamera(options);
  machine.beforeAnalyze(undefined, 0);
  const idle = machine.afterAnalyze({ fullTarget: target, lost: false }, 0, 0);
  assert.equal(machine.commit(idle, 1, 5), true);
  machine.beforeAnalyze(undefined, 100);
  const plan = machine.afterAnalyze(lost, 20, 100);
  assert.deepEqual(plan.point, target); assert.equal(plan.stopJoystick, true);
  assert.equal(machine.commit(plan, 2, 105), true);
  return machine;
}

test('camera is opt-in, App control only and requires provenance capability', () => {
  for (const patch of [{ enabled: false }, { mode: 'observe' }, { backend: 'basic' }, { provenanceVersion: undefined }, { provenanceVersion: 2 }]) {
    const m = new GameFollowCamera({ ...options, ...patch });
    m.beforeAnalyze(undefined, 0);
    let p = m.afterAnalyze({ lost: false, fullTarget: target }, 0, 0); m.commit(p, 1, 0);
    m.beforeAnalyze(proof(), 100); p = m.afterAnalyze(lost, 0, 100);
    assert.equal(p.point, null); assert.equal(p.allowCameraMovement, false); assert.equal(p.reason, 'disabled');
  }
});

test('lost without recent full evidence cannot hold or move from camera/partial history', () => {
  const m = new GameFollowCamera(options);
  m.beforeAnalyze(proof(), 0);
  const p = m.afterAnalyze({ ...lost, cameraTarget: target }, 0, 0);
  assert.equal(p.point, null); assert.equal(p.allowCameraMovement, false); assert.equal(p.stopJoystick, true);
  m.commit(p, 1, 0);
  m.beforeAnalyze(undefined, 1); m.commit(m.afterAnalyze({ fullTarget: target, lost: false }, 0, 1), 2, 1);
  m.beforeAnalyze(undefined, 3002);
  assert.equal(m.afterAnalyze(lost, 0, 3002).point, null);
});

test('arming requires ACK then matching applied proof stable for 250 ms', () => {
  const m = armed();
  assert.equal(m.beforeAnalyze(proof({ capturedAtUptimeMs: 100249 }), 300), undefined);
  const waiting = m.afterAnalyze({ ...lost, cameraTarget: target }, 30, 305);
  assert.equal(waiting.stopJoystick, true); assert.equal(waiting.allowCameraMovement, false); m.commit(waiting, 3, 310);
  const context = m.beforeAnalyze(proof({ sequence: 3, capturedAtUptimeMs: 100250 }), 400);
  assert.deepEqual(context, { point: target, epoch: 7, sequence: 3 });
  const current = m.afterAnalyze({ ...lost, cameraTarget: { x: 241.25, y: 298.5 } }, 40, 420);
  assert.equal(current.stopJoystick, false); assert.equal(current.allowCameraMovement, true);
  assert.deepEqual(current.point, target, 'a current projected target does not turn into an unbounded camera search');
});

test('proof clocks are phone-local and never compared with the host monotonic origin', () => {
  for (const origin of [0, 900000000000]) {
    const m = armed();
    const p = proof({ heldSinceUptimeMs: origin, capturedAtUptimeMs: origin + 300, expiresAtUptimeMs: origin + 1200 });
    assert.ok(m.beforeAnalyze(p, 400));
    assert.equal(m.afterAnalyze({ ...lost, cameraTarget: target }, 50, 430).allowCameraMovement, true);
  }
});

test('same-point renewals retain epoch/held-since but require the latest ACK sequence', () => {
  const m = armed(); assert.ok(m.beforeAnalyze(proof(), 400));
  const p = m.afterAnalyze({ ...lost, cameraTarget: target }, 40, 420); m.commit(p, 3, 430);
  assert.equal(m.beforeAnalyze(proof({ capturedAtUptimeMs: 100600 }), 700), undefined, 'older sequence');
  const retry = m.afterAnalyze({ ...lost, cameraTarget: target }, 40, 710); assert.equal(retry.allowCameraMovement, false); m.commit(retry, 4, 720);
  assert.ok(m.beforeAnalyze(proof({ sequence: 4, capturedAtUptimeMs: 100900, expiresAtUptimeMs: 102000 }), 900));
  assert.equal(m.afterAnalyze({ ...lost, cameraTarget: target }, 30, 910).allowCameraMovement, true);
});

test('missing, wrong-coordinate, future-sequence and malformed proofs never authorize parsing', () => {
  for (const bad of [undefined, proof({ x: 241 }), proof({ sequence: 3 }), proof({ version: 2 }),
    proof({ epoch: NaN }), proof({ sequence: 1.5 }), proof({ heldSinceUptimeMs: 100400 })]) {
    const m = armed(); assert.equal(m.beforeAnalyze(bad, 400), undefined);
    const p = m.afterAnalyze({ ...lost, cameraTarget: target }, 30, 410);
    assert.equal(p.allowCameraMovement, false); assert.equal(p.stopJoystick, true);
  }
});

test('replayed capture, changed epoch or held-since cannot reuse camera evidence', () => {
  for (const patch of [{ capturedAtUptimeMs: 100300 }, { epoch: 8, capturedAtUptimeMs: 100600 },
    { heldSinceUptimeMs: 100001, capturedAtUptimeMs: 100600 }]) {
    const m = armed(); assert.ok(m.beforeAnalyze(proof(), 400));
    m.commit(m.afterAnalyze(lost, 30, 410), 3, 420);
    assert.equal(m.beforeAnalyze(proof({ sequence: 3, ...patch }), 700), undefined);
    const p = m.afterAnalyze({ ...lost, cameraTarget: target }, 30, 710);
    assert.equal(p.allowCameraMovement, false); assert.equal(p.stopJoystick, true);
    if (patch.epoch || patch.heldSinceUptimeMs) assert.equal(p.point, null);
  }
});

test('a current proof alone cannot drive movement without a current target signal', () => {
  const m = armed(); assert.ok(m.beforeAnalyze(proof(), 400));
  const p = m.afterAnalyze(lost, 40, 420);
  assert.deepEqual(p.point, target); assert.equal(p.stopJoystick, true); assert.equal(p.allowCameraMovement, false);
});

test('one current context is consumed once; an uncommitted input is never replayed', () => {
  const m = armed(); assert.ok(m.beforeAnalyze(proof(), 400));
  const sent = m.afterAnalyze({ ...lost, cameraTarget: target }, 40, 420);
  assert.equal(sent.allowCameraMovement, true);
  assert.equal(m.beforeAnalyze(proof({ capturedAtUptimeMs: 100500 }), 500), undefined);
  assert.equal(m.commit(sent, 3, 510), false, 'late unknown-result ACK cannot resurrect discarded hold');
  const release = m.afterAnalyze({ ...lost, cameraTarget: target }, 30, 520);
  assert.equal(release.point, null); assert.equal(release.stopJoystick, true);
});

test('full target must remain reliable across multiple frames for delayed release', () => {
  const m = armed();
  m.beforeAnalyze(proof(), 400); let p = m.afterAnalyze({ fullTarget: target, lost: false }, 30, 410);
  assert.deepEqual(p.point, target); assert.equal(p.reason, 'full-target-confirming'); m.commit(p, 3, 420);
  m.beforeAnalyze(undefined, 700); p = m.afterAnalyze(lost, 30, 710); m.commit(p, 4, 720);
  m.beforeAnalyze(undefined, 900); p = m.afterAnalyze({ fullTarget: target, lost: false }, 30, 910); m.commit(p, 5, 920);
  m.beforeAnalyze(undefined, 1200); p = m.afterAnalyze({ fullTarget: target, lost: false }, 30, 1210);
  assert.deepEqual(p.point, target, 'one intervening loss resets release confirmation'); m.commit(p, 6, 1220);
  m.beforeAnalyze(undefined, 1500); p = m.afterAnalyze({ fullTarget: target, lost: false }, 30, 1510);
  assert.equal(p.point, null); assert.equal(p.stopJoystick, true); assert.equal(p.reason, 'full-target-restored');
  m.commit(p, 7, 1520); assert.equal(m.state, 'idle');
});

test('a changed camera point requires new proof and cannot inherit the previous context', () => {
  const m = armed(), next = { x: 260, y: 310 };
  m.beforeAnalyze(proof(), 400); m.commit(m.afterAnalyze({ fullTarget: next, lost: false }, 30, 410), 3, 420);
  m.beforeAnalyze(undefined, 1000); m.commit(m.afterAnalyze({ fullTarget: next, lost: false }, 30, 1010), 4, 1020);
  m.beforeAnalyze(undefined, 1100); const arm = m.afterAnalyze(lost, 30, 1110); assert.deepEqual(arm.point, next); m.commit(arm, 5, 1120);
  assert.equal(m.beforeAnalyze(proof({ sequence: 5 }), 1400), undefined);
  m.commit(m.afterAnalyze(lost, 30, 1410), 6, 1420);
  assert.ok(m.beforeAnalyze(proof({ ...next, epoch: 9, sequence: 6, heldSinceUptimeMs: 101000, capturedAtUptimeMs: 101300, expiresAtUptimeMs: 102000 }), 1500));
});

test('host TTL, phone capture expiry and host expiry during analysis release instead of renewing', () => {
  const host = armed(); assert.equal(host.beforeAnalyze(proof(), 1300), undefined);
  assert.equal(host.afterAnalyze(lost, 30, 1310).point, null);
  const phone = armed(); assert.equal(phone.beforeAnalyze(proof({ capturedAtUptimeMs: 101200 }), 400), undefined);
  assert.equal(phone.afterAnalyze(lost, 30, 410).point, null);
  const analysis = armed(); assert.ok(analysis.beforeAnalyze(proof(), 1200));
  const p = analysis.afterAnalyze({ ...lost, cameraTarget: target }, 500, 1300);
  assert.equal(p.point, null); assert.equal(p.stopJoystick, true); assert.equal(p.reason, 'hold-expired');
});

test('pre-capture wait is not double-counted against the remaining phone lease', () => {
  const m = armed(); // plan at host100, ACK at105, conservative host expiry1300.
  // Phone receipt at102 and application at180, with uptime offset100000.
  // Frame request begins450; capture750; pixels arrive1000; decision1050.
  // Capture-to-expiry552 is shorter than total request age600, but the capture
  // is valid and decision still precedes host1300 and actual phone expiry1302.
  assert.ok(m.beforeAnalyze(proof({ heldSinceUptimeMs: 100180,
    capturedAtUptimeMs: 100750, expiresAtUptimeMs: 101302 }), 1000));
  const p = m.afterAnalyze({ ...lost, cameraTarget: target }, 600, 1050);
  assert.equal(p.allowCameraMovement, true); assert.equal(p.stopJoystick, false);
  assert.equal(p.ttlMs, 1200, 'no TTL limit was extended');
});

test('stale frames at one second release and cannot refresh the recent reliable position', () => {
  for (const age of [1000, 1400, NaN, -1]) {
    const m = armed(); m.beforeAnalyze(proof(), 400);
    const p = m.afterAnalyze({ fullTarget: target, lost: false, cameraTarget: target }, age, 410);
    assert.equal(p.point, null); assert.equal(p.stopJoystick, true); assert.equal(p.allowCameraMovement, false);
    m.commit(p, 3, 420); m.beforeAnalyze(undefined, 500);
    assert.equal(m.afterAnalyze(lost, 20, 510).point, null);
  }
});

test('renewals cannot extend the six-second camera hold budget', () => {
  const m = armed(); let sequence = 2;
  for (let now = 600; now < 6100; now += 500) {
    m.beforeAnalyze(undefined, now); const p = m.afterAnalyze(lost, 30, now);
    assert.deepEqual(p.point, target); assert.ok(p.ttlMs <= 6100 - now); m.commit(p, ++sequence, now + 5);
  }
  m.beforeAnalyze(undefined, 6100); const release = m.afterAnalyze(lost, 30, 6110);
  assert.equal(release.point, null); assert.ok(['hold-budget', 'hold-expired'].includes(release.reason));
  m.commit(release, ++sequence, 6120); m.beforeAnalyze(undefined, 6200);
  assert.equal(m.afterAnalyze(lost, 30, 6210).point, null, 'exhausted history cannot immediately restart another budget');
});

test('last renewal TTL is shortened and caller cannot ACK a longer TTL than planned', () => {
  const m = armed(); let sequence = 2;
  for (let now = 1000; now <= 5000; now += 1000) {
    m.beforeAnalyze(undefined, now); m.commit(m.afterAnalyze(lost, 30, now), ++sequence, now + 5);
  }
  m.beforeAnalyze(undefined, 5900); const p = m.afterAnalyze(lost, 30, 5900);
  assert.equal(p.ttlMs, 200);
  assert.equal(m.commit(p, ++sequence, 5910, 1200), false);
  assert.equal(m.state, 'releasing');
});

test('less than Android minimum 100 ms of budget releases instead of sending an invalid TTL', () => {
  const m = armed(); let sequence = 2;
  for (let now = 1000; now <= 6000; now += 1000) {
    m.beforeAnalyze(undefined, now); m.commit(m.afterAnalyze(lost, 30, now), ++sequence, now + 5);
  }
  m.beforeAnalyze(undefined, 6050); const p = m.afterAnalyze(lost, 0, 6050);
  assert.equal(p.point, null); assert.equal(p.stopJoystick, true); assert.equal(p.reason, 'hold-budget');
  assert.equal(p.ttlMs, 1200);
});

test('cancel, recovery and uncertain input invalidate in-flight plans and all historical evidence', () => {
  for (const reason of ['cancel', 'recovery', 'input-failed']) {
    const m = armed(); m.beforeAnalyze(proof(), 400); const old = m.afterAnalyze(lost, 30, 410);
    m.invalidate(reason); assert.equal(m.commit(old, 3, 420), false);
    assert.equal(m.beforeAnalyze(proof(), 500), undefined);
    const release = m.afterAnalyze({ ...lost, cameraTarget: target }, 30, 510);
    assert.equal(release.point, null); assert.equal(release.stopJoystick, true);
    m.commit(release, 4, 520); m.beforeAnalyze(undefined, 600);
    assert.equal(m.afterAnalyze(lost, 30, 610).point, null);
  }
});

test('late or invalid ACK cannot grant a hold; immutable plans prevent coordinate substitution', () => {
  const m = new GameFollowCamera(options);
  m.commit(m.afterAnalyze({ fullTarget: target, lost: false }, 0, 0), 1, 1);
  m.beforeAnalyze(undefined, 100); const p = m.afterAnalyze(lost, 20, 100);
  assert.ok(Object.isFrozen(p)); assert.ok(Object.isFrozen(p.point));
  assert.equal(m.commit({ ...p }, 2, 200), false);
  assert.equal(m.commit(p, 2, 1300), false); assert.equal(m.state, 'releasing');
  const regressed = armed(); assert.throws(() => regressed.beforeAnalyze(proof(), 1), /monotonic/);
  const badSequence = armed(); badSequence.beforeAnalyze(undefined, 400);
  assert.equal(badSequence.commit(badSequence.afterAnalyze(lost, 30, 410), 2, 420), false);
});
