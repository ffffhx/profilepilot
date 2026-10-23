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
  assert.equal(p.point, null); assert.equal(p.stopJoystick, false); assert.equal(p.reason, 'full-target-restored');
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

test('ACK renewals without current target evidence cannot extend six-second search', () => {
  const m = armed(); let sequence = 2;
  for (let now = 600; now < 6100; now += 500) {
    m.beforeAnalyze(undefined, now); const p = m.afterAnalyze(lost, 30, now);
    assert.deepEqual(p.point, target); assert.ok(p.ttlMs <= 6100 - now); m.commit(p, ++sequence, now + 5);
  }
  m.beforeAnalyze(undefined, 6100); const release = m.afterAnalyze(lost, 30, 6110);
  assert.equal(release.point, null); assert.equal(release.reason, 'search-expired');
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
  assert.equal(p.point, null); assert.equal(p.stopJoystick, true); assert.equal(p.reason, 'search-expired');
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

test('continuous matching current camera evidence tracks beyond six seconds without lengthening touch TTL', () => {
  const m = armed(); let sequence = 2, expires = 1300;
  for (let now = 600; now <= 18600; now += 600) {
    assert.ok(m.beforeAnalyze(proof({ sequence, heldSinceUptimeMs: 100180,
      capturedAtUptimeMs: 100000 + now - 100, expiresAtUptimeMs: 100000 + expires }), now));
    const p = m.afterAnalyze({ ...lost, cameraTarget: { x: 241, y: 299 } }, 400, now);
    assert.equal(p.allowCameraMovement, true); assert.equal(p.stopJoystick, false);
    assert.equal(p.ttlMs, 1200); assert.deepEqual(p.point, target, 'fixed point is unchanged');
    assert.ok(m.commit(p, ++sequence, now + 5)); expires = now + p.ttlMs;
    const status = m.status(now + 5);
    assert.equal(status.evidenceAgeMs, 405);
    assert.equal(status.searchRemainingMs, 5595);
    assert.equal(status.ttlRemainingMs, 1195);
  }
  assert.ok(m.status(18605).holdAgeMs > 18000);
  assert.equal(m.status(18605).releaseRequests, 0);
  assert.equal(m.status(18605).armAttempts, 1);
});

test('missing current target stops id0 immediately and proof alone cannot renew search after successful tracking', () => {
  const m = armed(); let sequence = 2, expires = 1300;
  for (let now = 600; now <= 7200; now += 600) {
    assert.ok(m.beforeAnalyze(proof({ sequence, heldSinceUptimeMs: 100180,
      capturedAtUptimeMs: 100000 + now - 100, expiresAtUptimeMs: 100000 + expires }), now));
    const p = m.afterAnalyze({ ...lost, cameraTarget: target }, 400, now);
    m.commit(p, ++sequence, now + 5); expires = now + p.ttlMs;
  }
  // Last evidence is conservatively dated to request start6800, search ends12800.
  for (let now = 7800; now < 12800; now += 600) {
    assert.ok(m.beforeAnalyze(proof({ sequence, heldSinceUptimeMs: 100180,
      capturedAtUptimeMs: 100000 + now - 100, expiresAtUptimeMs: 100000 + expires }), now));
    const p = m.afterAnalyze(lost, 400, now);
    assert.equal(p.stopJoystick, true); assert.equal(p.allowCameraMovement, false);
    assert.equal(p.reason, 'searching-current-target'); assert.deepEqual(p.point, target);
    assert.equal(p.ttlMs, Math.min(1200, 12800 - now));
    m.commit(p, ++sequence, now + 5); expires = now + p.ttlMs;
  }
  m.beforeAnalyze(undefined, 12800);
  const release = m.afterAnalyze({ ...lost, cameraTarget: target }, 400, 12800);
  assert.equal(release.point, null); assert.equal(release.reason, 'search-expired');
  assert.equal(release.stopJoystick, true); m.commit(release, ++sequence, 12805);
  const status = m.status(12805);
  assert.equal(status.state, 'idle'); assert.equal(status.releaseRequests, 1);
  assert.deepEqual(status.releaseReasons, { 'search-expired': 1 });
  m.beforeAnalyze(undefined, 13400);
  assert.equal(m.afterAnalyze(lost, 400, 13400).point, null, 'no camera history can rearm after loss');
});

test('unproven camera coordinates cannot extend search and snapshots cannot authorize or mutate it', () => {
  const m = armed(); let sequence = 2;
  for (let now = 600; now < 6100; now += 500) {
    m.beforeAnalyze(proof({ sequence: sequence - 1, capturedAtUptimeMs: 100000 + now,
      expiresAtUptimeMs: 102000 + now }), now);
    const p = m.afterAnalyze({ ...lost, cameraTarget: target }, 30, now);
    assert.equal(p.stopJoystick, true); assert.equal(p.allowCameraMovement, false);
    assert.equal(m.status(now).searchRemainingMs, 6100 - now);
    const snapshot = m.status(now); snapshot.point.x = 999; snapshot.releaseReasons.fake = 999;
    m.status(now + 999999); // Reading a future time cannot extend or expire input authority.
    assert.equal(m.status(now).point.x, target.x);
    assert.equal(m.status(now).releaseReasons.fake, undefined);
    m.commit(p, ++sequence, now + 5);
  }
  m.beforeAnalyze(undefined, 6100);
  assert.equal(m.afterAnalyze(lost, 30, 6100).reason, 'search-expired');
});

test('post-extension TTL expiry, stale input, recovery and cancel still revoke all camera evidence', () => {
  for (const failure of ['ttl', 'stale', 'recovery', 'cancel']) {
    const m = armed(); let sequence = 2, expires = 1300;
    for (let now = 600; now <= 7200; now += 600) {
      m.beforeAnalyze(proof({ sequence, heldSinceUptimeMs: 100180,
        capturedAtUptimeMs: 100000 + now - 100, expiresAtUptimeMs: 100000 + expires }), now);
      const p = m.afterAnalyze({ ...lost, cameraTarget: target }, 400, now);
      m.commit(p, ++sequence, now + 5); expires = now + p.ttlMs;
    }
    const now = failure === 'ttl' ? expires : 7800;
    if (failure === 'recovery' || failure === 'cancel') m.invalidate(failure);
    m.beforeAnalyze(proof({ sequence, heldSinceUptimeMs: 100180,
      capturedAtUptimeMs: 100000 + now - 100, expiresAtUptimeMs: 100000 + expires }), now);
    const p = m.afterAnalyze({ ...lost, cameraTarget: target }, failure === 'stale' ? 1000 : 400, now);
    assert.equal(p.point, null); assert.equal(p.stopJoystick, true); assert.equal(p.allowCameraMovement, false);
  }
});
const placement = { width: 1000, height: 500, map: { x: 0, y: 0, width: 1, height: 1 },
  cameraAssist: { referenceWidth: 1000, referenceHeight: 500,
    matrix: [[.02, 0], [0, .02], [-10, -5]], anchorBounds: { x: 0, y: 0, width: 1000, height: 500 } } };

function cameraFullPair(m, role = 'target', gap = 500) {
  const observe = point => role === 'self' ? { fullSelf: point, fullTarget: target, lost: false }
    : { fullTarget: point, lost: false };
  m.beforeAnalyze(undefined, 100);
  m.commit(m.afterAnalyze(observe({ x: 286.3, y: 164.36 }), 100, 100), 1, 105);
  m.beforeAnalyze(undefined, gap+100);
  m.commit(m.afterAnalyze(observe({ x: 293.5, y: 169.5 }), 100, gap+100), 2, gap+105);
}

test('dynamic2 full portrait pair leads the lost-frame camera only, with unchanged proof and TTL gates', () => {
  // Actual frame 14/15 displacement and calibrated affine; timestamps controlled
  // here exercise the bound and are not a claim of live camera recovery.
  const actual = { width: 2772, height: 1240, map: { x: 120/2772, y: 0, width: 425/2772, height: 425/1240 },
    cameraAssist: { referenceWidth: 2772, referenceHeight: 1240,
      matrix: [[.03134552196601158,-.000019410593445561446],[-.000562810361805513,.05202441025993644],[-45.38083595559168,-22.39426870327259]],
      anchorBounds: { x: 1000, y: 330, width: 900, height: 240 } } };
  const m = new GameFollowCamera({ ...options, placement: actual, intervalMs: 350 }); cameraFullPair(m);
  m.beforeAnalyze(undefined, 1050);
  const p = m.afterAnalyze({ ...lost, captureMs: 500, cameraTarget: { x: 400, y: 400 } }, 100, 1050);
  assert.deepEqual(p.point, { x: 308, y: 179 }, 'old arm was 294,169');
  assert.equal(p.stopJoystick, true); assert.equal(p.allowCameraMovement, false); assert.equal(p.ttlMs, 1200);
  const prediction = m.status(1050).placement.prediction;
  assert.equal(prediction.applied, true); assert.equal(prediction.horizonMs, 1000);
  assert.ok(Math.abs(prediction.speedMapPxPerSecond.x-14.4)<1e-8);
  assert.ok(Math.abs(prediction.speedMapPxPerSecond.y-10.28)<1e-8);
  assert.equal(m.status(1050).speedMapPxPerSecond, undefined, 'recenter speed still clears on a missing frame');
  m.commit(p, 3, 1055); assert.equal(m.status(1055).ttlRemainingMs, 1195);
  assert.equal(m.status(1055).searchRemainingMs, 5995);
  assert.equal(m.beforeAnalyze(proof({ sequence: 3, x: 294, y: 169 }), 1300), undefined);
  const waiting = m.afterAnalyze({ ...lost, cameraTarget: target }, 100, 1300);
  assert.equal(waiting.stopJoystick, true); assert.equal(waiting.allowCameraMovement, false);
  m.commit(waiting, 4, 1305);
  m.beforeAnalyze(undefined, 2500);
  assert.equal(m.afterAnalyze(lost, 100, 2500).reason, 'hold-expired');
});

test('single full, nonadjacent full, large gap and expired pair do not lead the camera', () => {
  for (const kind of ['single', 'nonadjacent', 'large-gap', 'expired']) {
    const m = new GameFollowCamera({ ...options, placement }); let sequence = 0, now;
    const full = (p, at) => { m.beforeAnalyze(undefined, at); m.commit(m.afterAnalyze({ fullTarget: p, lost: false }, 0, at), ++sequence, at); };
    full({ x: 230, y: 300 }, 0);
    if (kind === 'nonadjacent') {
      // A current partial is valid for other purposes, but cannot bridge the two full portraits.
      m.beforeAnalyze(undefined, 200);
      m.commit(m.afterAnalyze({ currentTarget: target, lost: false }, 0, 200), ++sequence, 200);
    }
    if (kind !== 'single') full(target, kind === 'large-gap' ? 1501 : 500);
    now = kind === 'large-gap' ? 1600 : kind === 'expired' ? 1501 : 600;
    m.beforeAnalyze(undefined, now);
    const p = m.afterAnalyze({ ...lost, captureMs: 400 }, 10, now);
    assert.equal(p.stopJoystick, true); assert.equal(p.allowCameraMovement, false);
    assert.deepEqual(p.point, kind === 'single' ? { x: 230, y: 300 } : target);
    assert.equal(m.status(now).placement.prediction.applied, false, kind);
  }
});

test('self camera lead uses only its own adjacent full pair and recovery discards both histories', () => {
  const m = new GameFollowCamera({ ...options, targetEnabled: false, selfPlacement: placement }); cameraFullPair(m, 'self');
  m.beforeAnalyze(undefined, 1050);
  const p = m.afterAnalyze({ fullTarget: target, lost: false, captureMs: 500 }, 100, 1050);
  assert.equal(p.reason, 'arm-self'); assert.deepEqual(p.point, { x: 308, y: 180 });
  assert.equal(p.stopJoystick, true); assert.equal(p.allowCameraMovement, false);
  m.commit(p, 3, 1055); m.invalidate('recovery');
  m.beforeAnalyze(undefined, 1100);
  m.commit(m.afterAnalyze({ fullTarget: target, lost: false }, 0, 1100), 4, 1100);
  m.beforeAnalyze(undefined, 1200);
  assert.equal(m.afterAnalyze({ fullTarget: target, lost: false }, 0, 1200).point, null);
});

test('dynamic3 frame145 full then146 current marker selects the newer self search point without leading or moving', () => {
  const m = new GameFollowCamera({ ...options, targetEnabled: false, selfPlacement: placement });
  const fullSelf = { x: 332.5, y: 298.5 }, marker = { x: 332.5, y: 289.5 };
  m.commit(m.afterAnalyze({ fullTarget: target, fullSelf, lost: false }, 600, 600), 1, 605);
  m.beforeAnalyze(undefined, 1200);
  m.commit(m.afterAnalyze({ fullTarget: target, currentSelf: marker, markerSelf: marker, lost: false }, 600, 1200), 2, 1205);
  m.beforeAnalyze(undefined, 1836);
  const arm = m.afterAnalyze({ fullTarget: target, lost: false }, 600, 1836);
  assert.equal(arm.reason, 'arm-self'); assert.deepEqual(arm.point, { x: 333, y: 290 });
  assert.equal(arm.stopJoystick, true); assert.equal(arm.allowCameraMovement, false); assert.equal(arm.ttlMs, 1200);
  assert.equal(m.status(1836).placement.seedSource, 'marker');
  assert.equal(m.status(1836).placement.prediction, undefined, 'marker seed does not reuse full speed');
  m.commit(arm, 3, 1841);
  assert.equal(m.beforeAnalyze(proof({ sequence: 3, x: 333, y: 299 }), 2200), undefined);
  const oldView = m.afterAnalyze({ fullTarget: target, cameraSelf: marker, lost: false }, 100, 2200);
  assert.equal(oldView.stopJoystick, true); assert.equal(oldView.allowCameraMovement, false);
  m.commit(oldView, 4, 2205);
  m.beforeAnalyze(undefined, 3400);
  const expired = m.afterAnalyze({ fullTarget: target, lost: false }, 100, 3400);
  assert.equal(expired.reason, 'hold-expired'); assert.equal(expired.point, null);
});

test('a self marker search seed must be explicitly typed, current and newer than its full anchor', () => {
  const old = { x: 180, y: 200 }, newer = { x: 190, y: 210 };
  for (const kind of ['untyped', 'no-current', 'mismatch', 'older']) {
    const m = new GameFollowCamera({ ...options, targetEnabled: false, selfPlacement: placement });
    m.commit(m.afterAnalyze({ fullTarget: target, fullSelf: old, lost: false }, 0, 600), 1, 600);
    m.beforeAnalyze(undefined, 700);
    m.commit(m.afterAnalyze({ fullTarget: target, lost: false,
      ...(kind === 'no-current' ? {} : { currentSelf: newer }),
      ...(kind === 'untyped' ? {} : { markerSelf: kind === 'mismatch' ? old : newer })
    }, kind === 'older' ? 500 : 0, 700), 2, 700);
    // no-current can already begin the old search; every path must retain it.
    m.beforeAnalyze(undefined, 800);
    const p = m.afterAnalyze({ fullTarget: target, lost: false }, 0, 800);
    assert.deepEqual(p.point, old, kind); assert.equal(p.stopJoystick, true);
    assert.equal(p.allowCameraMovement, false);
  }
});

test('marker-only validated self seed expires and recovery discards it; it cannot seed a target search', () => {
  const self = { x: 180, y: 200 };
  for (const kind of ['expired', 'recovery', 'cancel', 'stale-frame']) {
    const m = new GameFollowCamera({ ...options, placement, selfPlacement: placement });
    m.commit(m.afterAnalyze({ fullTarget: target, currentSelf: self, markerSelf: self, lost: false }, 0, 0), 1, 0);
    if (kind === 'recovery' || kind === 'cancel') m.invalidate(kind);
    const now = kind === 'expired' ? 3001 : 100;
    m.beforeAnalyze(undefined, now);
    const p = m.afterAnalyze({ fullTarget: target, lost: false }, kind === 'stale-frame' ? 1000 : 0, now);
    assert.equal(p.point, null, kind); assert.equal(p.stopJoystick, true); assert.equal(p.allowCameraMovement, false);
  }
  const m = new GameFollowCamera({ ...options, placement, selfPlacement: placement });
  m.commit(m.afterAnalyze({ currentTarget: target, currentSelf: self, markerSelf: self, lost: false }, 0, 0), 1, 0);
  m.beforeAnalyze(undefined, 100);
  assert.equal(m.afterAnalyze({ currentSelf: self, markerSelf: self, lost: true }, 0, 100).point, null);
});

test('target-to-self search switch prefers a newer current marker without renewing the search deadline', () => {
  const old = { x: 180, y: 200 }, marker = { x: 190, y: 210 };
  const m = new GameFollowCamera({ ...options, placement, selfPlacement: placement });
  m.commit(m.afterAnalyze({ fullTarget: target, fullSelf: old, lost: false }, 0, 0), 1, 0);
  m.beforeAnalyze(undefined, 100);
  m.commit(m.afterAnalyze({ currentSelf: marker, markerSelf: marker, lost: true }, 0, 100), 2, 100);
  assert.ok(m.beforeAnalyze(proof(), 400));
  const p = m.afterAnalyze({ fullTarget: target, lost: false }, 20, 410);
  assert.equal(p.reason, 'switch-search-self'); assert.deepEqual(p.point, marker);
  assert.equal(p.stopJoystick, true); assert.equal(p.allowCameraMovement, false);
  assert.equal(m.status(410).placement.seedSource, 'marker'); assert.equal(m.status(410).searchRemainingMs, 5690);
  m.commit(p, 3, 420); assert.equal(m.status(420).ttlRemainingMs, 1190);
  assert.equal(m.beforeAnalyze(proof({ sequence: 3, capturedAtUptimeMs: 100700 }), 700), undefined);
});

test('current edge evidence recenters now; old epoch and unsettled new point cannot authorize the next frame', () => {
  const m = new GameFollowCamera({ ...options, placement, intervalMs: 350 });
  m.commit(m.afterAnalyze({ fullTarget: target, lost: false }, 0, 0), 1, 5);
  m.beforeAnalyze(undefined, 100); m.commit(m.afterAnalyze(lost, 20, 100), 2, 105);
  assert.ok(m.beforeAnalyze(proof(), 400));
  const p = m.afterAnalyze({ ...lost, cameraTarget: { x: 248, y: 300 } }, 30, 410);
  assert.equal(p.reason, 'recenter-current-target'); assert.deepEqual(p.point, { x: 248, y: 300 });
  assert.equal(p.allowCameraMovement, true); assert.equal(p.stopJoystick, false); assert.equal(p.ttlMs, 1200);
  m.commit(p, 3, 420);
  assert.equal(m.state, 'arming');
  assert.equal(m.beforeAnalyze(proof({ sequence: 3, x: 248, capturedAtUptimeMs: 100600 }), 600), undefined, 'old epoch even with new coordinates');
  m.commit(m.afterAnalyze({ ...lost, cameraTarget: { x: 248, y: 300 } }, 20, 610), 4, 620);
  assert.equal(m.beforeAnalyze(proof({ sequence: 4, x: 248, epoch: 8, heldSinceUptimeMs: 100500, capturedAtUptimeMs: 100749 }), 800), undefined);
  const waiting = m.afterAnalyze({ ...lost, cameraTarget: { x: 248, y: 300 } }, 20, 810);
  assert.equal(waiting.stopJoystick, true); m.commit(waiting, 5, 820);
  assert.ok(m.beforeAnalyze(proof({ sequence: 5, x: 248, epoch: 8, heldSinceUptimeMs: 100500, capturedAtUptimeMs: 100850 }), 1000));
  const ready = m.afterAnalyze({ ...lost, cameraTarget: { x: 248, y: 300 } }, 20, 1010);
  assert.equal(ready.allowCameraMovement, true); assert.equal(ready.stopJoystick, false);
  assert.equal(m.status(1010).recenterAttempts, 1); assert.equal(m.status(1010).placement.action, 'keep');
});

function selfArmed() {
  const m = new GameFollowCamera({ ...options, targetEnabled: false, selfPlacement: placement });
  const self = { x: 180, y: 200 };
  m.commit(m.afterAnalyze({ fullTarget: target, fullSelf: self, lost: false }, 0, 0), 1, 5);
  m.beforeAnalyze(undefined, 100);
  const arm = m.afterAnalyze({ fullTarget: target, lost: false, selfLost: true }, 20, 100);
  assert.deepEqual(arm.point, self); assert.equal(arm.reason, 'arm-self'); assert.equal(arm.stopJoystick, true);
  m.commit(arm, 2, 105); return { m, self };
}

test('self camera needs current proof and a current target; target restoration alone cannot release it', () => {
  const { m, self } = selfArmed(); let sequence = 2;
  for (let now = 400; now <= 1600; now += 400) {
    assert.ok(m.beforeAnalyze(proof({ ...self, sequence, capturedAtUptimeMs: 100000+now,
      expiresAtUptimeMs: 101200+now }), now));
    const p = m.afterAnalyze({ fullTarget: target, cameraSelf: self, lost: false }, 20, now);
    assert.deepEqual(p.point, self); assert.equal(p.allowCameraMovement, true); assert.equal(p.stopJoystick, false);
    assert.equal(p.reason, 'held-current-self'); m.commit(p, ++sequence, now+5);
  }
  assert.equal(m.status(1605).role, 'self'); assert.equal(m.status(1605).releaseRequests, 0);
  m.beforeAnalyze(proof({ ...self, sequence, capturedAtUptimeMs: 102000, expiresAtUptimeMs: 103000 }), 2000);
  const noTarget = m.afterAnalyze({ cameraSelf: self, lost: true }, 20, 2000);
  assert.equal(noTarget.allowCameraMovement, false); assert.equal(noTarget.stopJoystick, true);
});

test('both current non-camera identities must return before release; untyped current self does not seed search history', () => {
  const { m, self } = selfArmed(); let sequence = 2;
  for (const now of [400, 700, 1000]) {
    m.beforeAnalyze(undefined, now);
    const p = m.afterAnalyze({ fullTarget: target, currentSelf: self, lost: false }, 20, now);
    assert.equal(p.stopJoystick, false); assert.equal(p.allowCameraMovement, false);
    assert.equal(p.point === null, now === 1000);
    if (now === 1000) assert.equal(p.reason, 'full-pair-restored');
    m.commit(p, ++sequence, now+5);
  }
  const fresh = new GameFollowCamera({ ...options, targetEnabled: false, selfPlacement: placement });
  fresh.commit(fresh.afterAnalyze({ fullTarget: target, currentSelf: self, lost: false }, 0, 0), 1, 0);
  fresh.beforeAnalyze(undefined, 100);
  assert.equal(fresh.afterAnalyze({ fullTarget: target, lost: false }, 0, 100).point, null);
});

test('full target and ACKs cannot extend a self search without current self evidence', () => {
  const { m } = selfArmed(); let sequence = 2;
  for (let now = 600; now < 6100; now += 500) {
    m.beforeAnalyze(undefined, now);
    const p = m.afterAnalyze({ fullTarget: target, lost: false }, 20, now);
    assert.equal(p.stopJoystick, true); assert.equal(p.allowCameraMovement, false);
    assert.equal(m.status(now).searchRemainingMs, 6100-now);
    m.commit(p, ++sequence, now+5);
  }
  m.beforeAnalyze(undefined, 6100);
  const release = m.afterAnalyze({ fullTarget: target, lost: false }, 20, 6100);
  assert.equal(release.point, null); assert.equal(release.reason, 'search-expired');
});

test('either role may use the same proof, and loss, expiry or recovery never supplies an old self coordinate', () => {
  for (const failure of ['missing-proof', 'missing-self', 'stale', 'recovery', 'ttl']) {
    const { m, self } = selfArmed();
    const now = failure === 'ttl' ? 1300 : 400;
    if (failure === 'recovery') m.invalidate('recovery');
    m.beforeAnalyze(failure === 'missing-proof' ? undefined : proof({ ...self }), now);
    const p = m.afterAnalyze({ fullTarget: target,
      ...(failure !== 'missing-self' ? { cameraSelf: self } : {}), lost: false }, failure === 'stale' ? 1000 : 20, now);
    assert.equal(p.stopJoystick, true); assert.equal(p.allowCameraMovement, false, failure);
  }
  const m = new GameFollowCamera({ ...options, placement, selfPlacement: placement });
  m.commit(m.afterAnalyze({ fullTarget: target, fullSelf: { x: 235, y: 300 }, lost: false }, 0, 0), 1, 0);
  m.beforeAnalyze(undefined, 100); m.commit(m.afterAnalyze(lost, 20, 100), 2, 105);
  assert.ok(m.beforeAnalyze(proof(), 400));
  const p = m.afterAnalyze({ cameraTarget: target, cameraSelf: { x: 235, y: 300 }, lost: true }, 20, 400);
  assert.equal(p.allowCameraMovement, true); assert.equal(p.stopJoystick, false, 'both current projected identities share this exact context');
});

test('a target hold switches to recent full-self search when target returns and self disappears', () => {
  const self = { x: 180, y: 200 }, m = new GameFollowCamera({ ...options, placement, selfPlacement: placement });
  m.commit(m.afterAnalyze({ fullTarget: target, fullSelf: self, lost: false }, 0, 0), 1, 5);
  m.beforeAnalyze(undefined, 100);
  m.commit(m.afterAnalyze({ fullSelf: self, lost: true }, 20, 100), 2, 105);
  assert.ok(m.beforeAnalyze(proof(), 400));
  const p = m.afterAnalyze({ fullTarget: target, lost: false }, 20, 410);
  assert.equal(p.reason, 'switch-search-self'); assert.deepEqual(p.point, self);
  assert.equal(p.stopJoystick, true); assert.equal(p.allowCameraMovement, false);
  assert.equal(m.status(410).searchRemainingMs, 5690, 'switch does not restart or extend search');
  m.commit(p, 3, 420); assert.equal(m.status(420).role, 'self'); assert.equal(m.state, 'arming');
  assert.equal(m.beforeAnalyze(proof({ sequence: 3, capturedAtUptimeMs: 100600 }), 600), undefined);
  const old = m.afterAnalyze({ fullTarget: target, cameraSelf: self, lost: false }, 20, 610);
  assert.equal(old.stopJoystick, true); assert.equal(old.allowCameraMovement, false); m.commit(old, 4, 620);
  assert.ok(m.beforeAnalyze(proof({ ...self, epoch: 8, sequence: 4, heldSinceUptimeMs: 100500,
    capturedAtUptimeMs: 100900, expiresAtUptimeMs: 102000 }), 900));
  const current = m.afterAnalyze({ fullTarget: target, cameraSelf: self, lost: false }, 20, 910);
  assert.equal(current.stopJoystick, false); assert.equal(current.allowCameraMovement, true);
  assert.deepEqual(current.point, self); assert.equal(m.status(910).releaseRequests, 0);
});

test('self-search switch cannot use expired, untyped-current-only, or out-of-map full-self history', () => {
  const self = { x: 180, y: 200 };
  for (const kind of ['expired', 'untyped-current-only', 'out-of-map']) {
    const selfPlacement = structuredClone(placement);
    if (kind === 'out-of-map') selfPlacement.cameraAssist.matrix[2] = [1000, 1000];
    const m = new GameFollowCamera({ ...options, placement, selfPlacement });
    m.commit(m.afterAnalyze({ fullTarget: target,
      ...(kind === 'untyped-current-only' ? { currentSelf: self } : { fullSelf: self }), lost: false }, 0, 0), 1, 0);
    m.beforeAnalyze(undefined, 100); m.commit(m.afterAnalyze(lost, 0, 100), 2, 100);
    let sequence = 2;
    if (kind === 'expired') for (const now of [1000, 2000, 3000]) {
      m.beforeAnalyze(undefined, now); m.commit(m.afterAnalyze(lost, 20, now), ++sequence, now+5);
    }
    const now = kind === 'expired' ? 3400 : 400;
    m.beforeAnalyze(undefined, now);
    const p = m.afterAnalyze({ fullTarget: target, lost: false }, 20, now);
    assert.deepEqual(p.point, target, kind); assert.equal(p.stopJoystick, true); assert.equal(p.allowCameraMovement, false);
    assert.notEqual(p.reason, 'switch-search-self'); assert.equal(m.status(now).role, 'target');
  }
});

test('switching search role at the same coordinate retains physical epoch but never supplies missing self input', () => {
  const m = new GameFollowCamera({ ...options, placement, selfPlacement: placement });
  m.commit(m.afterAnalyze({ fullTarget: target, fullSelf: target, lost: false }, 0, 0), 1, 0);
  m.beforeAnalyze(undefined, 100); m.commit(m.afterAnalyze({ fullSelf: target, lost: true }, 0, 100), 2, 100);
  assert.ok(m.beforeAnalyze(proof(), 400));
  const p = m.afterAnalyze({ fullTarget: target, lost: false }, 20, 410);
  assert.equal(p.reason, 'switch-search-self'); assert.equal(p.stopJoystick, true);
  m.commit(p, 3, 420); assert.equal(m.status(420).role, 'self'); assert.equal(m.state, 'held');
  assert.ok(m.beforeAnalyze(proof({ sequence: 3, capturedAtUptimeMs: 100700, expiresAtUptimeMs: 102000 }), 700));
  const ready = m.afterAnalyze({ fullTarget: target, cameraSelf: target, lost: false }, 20, 710);
  assert.equal(ready.allowCameraMovement, true); assert.equal(ready.stopJoystick, false);
});

test('game8 restored current self switches its hold to missing target search without extending budget or reusing proof', () => {
  // Reproduces the frame152-158 role state with controlled time: own minimap
  // identity returns while target is absent, and the old self hold is unhelpful.
  const self = { x: 180, y: 200 }, restored = { x: 190, y: 210 };
  const m = new GameFollowCamera({ ...options, placement, selfPlacement: placement });
  m.commit(m.afterAnalyze({ fullTarget: target, fullSelf: self, lost: false }, 0, 0), 1, 5);
  m.beforeAnalyze(undefined, 100);
  m.commit(m.afterAnalyze({ fullTarget: target, lost: false }, 20, 100), 2, 105);
  assert.equal(m.status(105).role, 'self');
  assert.ok(m.beforeAnalyze(proof({ ...self }), 400));
  const p = m.afterAnalyze({ currentSelf: restored, markerSelf: restored, lost: true }, 20, 410);
  assert.equal(p.reason, 'switch-search-target'); assert.deepEqual(p.point, target);
  assert.equal(p.stopJoystick, true); assert.equal(p.allowCameraMovement, false);
  assert.equal(m.status(410).searchRemainingMs, 5690); assert.equal(m.status(410).placement.seedSource, 'full');
  m.commit(p, 3, 420); assert.equal(m.status(420).role, 'target'); assert.equal(m.status(420).ttlRemainingMs, 1190);
  assert.equal(m.beforeAnalyze(proof({ ...self, sequence: 3, capturedAtUptimeMs: 100700 }), 700), undefined);
  const old = m.afterAnalyze({ currentSelf: restored, cameraTarget: target, lost: true }, 20, 710);
  assert.equal(old.stopJoystick, true); assert.equal(old.allowCameraMovement, false); m.commit(old, 4, 720);
  assert.ok(m.beforeAnalyze(proof({ sequence: 4, epoch: 8, heldSinceUptimeMs: 100500,
    capturedAtUptimeMs: 100900, expiresAtUptimeMs: 102000 }), 900));
  const valid = m.afterAnalyze({ currentSelf: restored, cameraTarget: target, lost: true }, 20, 910);
  assert.equal(valid.stopJoystick, false); assert.equal(valid.allowCameraMovement, true);
});

test('self-to-target switching requires enabled target, recent full history and independent current self', () => {
  const self = { x: 180, y: 200 };
  for (const kind of ['disabled-target', 'no-target-placement', 'camera-self-only', 'expired-target', 'out-of-map']) {
    const targetPlacement = structuredClone(placement);
    if (kind === 'out-of-map') targetPlacement.cameraAssist.matrix[2] = [1000, 1000];
    const m = new GameFollowCamera({ ...options, targetEnabled: kind !== 'disabled-target',
      ...(kind === 'no-target-placement' ? {} : { placement: targetPlacement }), selfPlacement: placement });
    m.commit(m.afterAnalyze({ fullTarget: target, fullSelf: self, lost: false }, 0, 0), 1, 0);
    m.beforeAnalyze(undefined, 100);
    m.commit(m.afterAnalyze({ fullTarget: target, lost: false }, 20, 100), 2, 100);
    let sequence = 2;
    if (kind === 'expired-target') for (const now of [1000,2000,3000]) {
      m.beforeAnalyze(undefined, now); m.commit(m.afterAnalyze({ lost: true }, 20, now), ++sequence, now);
    }
    const now = kind === 'expired-target' ? 3400 : 400;
    m.beforeAnalyze(proof({ ...self, sequence, capturedAtUptimeMs: 100000+now,
      expiresAtUptimeMs: 101200+now }), now);
    const p = m.afterAnalyze({ lost: true, ...(kind === 'camera-self-only' ? { cameraSelf: self } : { currentSelf: self }) }, 20, now);
    assert.deepEqual(p.point, self, kind); assert.notEqual(p.reason, 'switch-search-target');
    assert.equal(p.stopJoystick, true); assert.equal(p.allowCameraMovement, false);
    assert.equal(m.status(now).role, 'self');
  }
});

test('self-to-target role change cannot restart search or exceed its final TTL budget', () => {
  const self = { x: 180, y: 200 }, m = new GameFollowCamera({ ...options, placement, selfPlacement: placement });
  m.commit(m.afterAnalyze({ fullTarget: target, fullSelf: self, lost: false }, 0, 0), 1, 0);
  m.beforeAnalyze(undefined, 100); m.commit(m.afterAnalyze({ fullTarget: target, lost: false }, 0, 100), 2, 100);
  let sequence = 2;
  for (const now of [1000,2000,3000,4000,5000,5900]) {
    m.beforeAnalyze(undefined, now);
    // Full target alone can update its seed, but cannot renew a missing-self search.
    m.commit(m.afterAnalyze({ fullTarget: target, lost: false }, 0, now), ++sequence, now);
  }
  m.beforeAnalyze(undefined, 5990);
  const p = m.afterAnalyze({ currentSelf: self, lost: true }, 0, 5990);
  assert.equal(p.reason, 'switch-search-target'); assert.equal(p.ttlMs, 110);
  assert.equal(m.status(5990).searchRemainingMs, 110); m.commit(p, ++sequence, 5995);
  m.beforeAnalyze(undefined, 6100);
  const end = m.afterAnalyze({ currentSelf: self, lost: true }, 0, 6100);
  assert.equal(end.point, null); assert.equal(end.reason, 'search-expired'); assert.equal(end.stopJoystick, true);
});
