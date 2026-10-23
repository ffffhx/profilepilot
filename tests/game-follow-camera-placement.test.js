const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { planCameraArm, planCameraRecenter } = loadCli('src/main/phones/game-follow-camera-placement.ts');

// Synthetic affine geometry exercises arithmetic; it is not device calibration.
const config = () => ({ width: 2772, height: 1240,
  map: { x: 100/2772, y: 40/1240, width: 425/2772, height: 425/1240 },
  cameraAssist: { referenceWidth: 2772, referenceHeight: 1240,
    matrix: [[.03, .001], [-.0005, .05], [-42, -21]],
    anchorBounds: { x: 1000, y: 330, width: 900, height: 240 } } });
const hold = { x: 316, y: 218 };
function project(c, anchor) {
  const m = c.cameraAssist.matrix;
  return { x: anchor.x*m[0][0]+anchor.y*m[1][0]+m[2][0], y: anchor.x*m[0][1]+anchor.y*m[1][1]+m[2][1] };
}
function frame(c = config(), anchor = { x: 1450, y: 450 }) {
  const delta = project(c, anchor);
  return { context: { point: { ...hold }, epoch: 6, sequence: 9 },
    proof: { version: 1, epoch: 6, sequence: 9, ...hold, heldSinceUptimeMs: 900000,
      capturedAtUptimeMs: 900500, expiresAtUptimeMs: 901200 },
    target: { x: hold.x+delta.x, y: hold.y+delta.y }, frameAgeMs: 200, holdRemainingMs: 700 };
}
const margin = (patch = {}) => ({ projectionErrorPx: .5, speedMapPxPerSecond: { x: 0, y: 0 }, horizonMs: 600, ...patch });
const near = (a,b,tolerance=1e-8) => assert.ok(Math.abs(a-b)<tolerance, `${a} != ${b}`);

test('initial arm offsets the full target by the calibrated anchor center, without authorizing movement', () => {
  const c = config(), target = { x: 316, y: 218 }, p = planCameraArm(c, { target, ageMs: 2500 });
  assert.equal(p.action, 'arm'); assert.deepEqual(p.center, { x: 1450, y: 450 });
  assert.deepEqual(p.point, { x: 315, y: 215 });
  assert.notDeepEqual(p.point, target);
  assert.equal(p.frameRemainingMs, 0);
  const delta = project(c, p.predictedAnchor);
  near(delta.x+p.point.x,target.x); near(delta.y+p.point.y,target.y);
  assert.equal(planCameraArm(c, { target, ageMs: 3001 }).action, 'reject');
  assert.equal(planCameraArm(c, { target, ageMs: -1 }).action, 'reject');
  assert.equal(planCameraArm(c, { ageMs: 10 }).action, 'reject');
});

test('current target safely inside the calibrated margin keeps the exact existing hold', () => {
  const c = config(), f = frame(c), p = planCameraRecenter(c, f, margin());
  assert.equal(p.action, 'keep'); assert.deepEqual(p.point, hold);
  near(p.anchor.x,1450); near(p.anchor.y,450);
  assert.equal(p.frameRemainingMs, 800);
  p.point.x = 999; assert.equal(f.context.point.x, 316, 'result cannot mutate current context');
});

test('one current proven edge frame recenters immediately, without extra temporal confirmation', () => {
  const c = config(), f = frame(c, { x: 1015, y: 450 }), p = planCameraRecenter(c, f, margin());
  assert.equal(p.action, 'recenter'); assert.equal(p.reason, 'calibrated-edge-margin');
  assert.deepEqual(p.point, { x: 303, y: 218 });
  assert.equal(p.frameRemainingMs, 800);
  const delta = project(c, p.predictedAnchor);
  near(delta.x+p.point.x,f.target.x); near(delta.y+p.point.y,f.target.y);
  assert.ok(Math.abs(p.predictedAnchor.x-p.center.x)<18);
  assert.ok(Math.abs(p.predictedAnchor.y-p.center.y)<11);
  assert.deepEqual(planCameraRecenter(c, f, margin()), p, 'pure planning has no implicit history');
});

test('a target outside the calibrated anchor region is rejected, never extrapolated into a camera move', () => {
  const c = config();
  for (const anchor of [{ x: 999, y: 450 }, { x: 1901, y: 450 }, { x: 1450, y: 329 }, { x: 1450, y: 571 }])
    assert.equal(planCameraRecenter(c, frame(c, anchor), margin()).reason, 'anchor-outside-calibration');
});

test('missing or stale current evidence, expired hold and mismatched proof reject without a point', () => {
  const changes = [f => { delete f.target; }, f => { delete f.context; }, f => { delete f.proof; },
    f => { f.frameAgeMs = 1000; }, f => { f.frameAgeMs = -1; }, f => { f.holdRemainingMs = 0; },
    f => { f.proof.epoch++; }, f => { f.proof.sequence++; }, f => { f.proof.x++; },
    f => { f.proof.capturedAtUptimeMs = f.proof.expiresAtUptimeMs; },
    f => { f.proof.capturedAtUptimeMs = f.proof.heldSinceUptimeMs+249; }, f => { f.target.x = NaN; }];
  for (const change of changes) {
    const c = config(), f = frame(c, { x: 1015, y: 450 }); change(f);
    const result = planCameraRecenter(c, f, margin());
    assert.equal(result.action, 'reject'); assert.equal(result.point, undefined); assert.equal(result.frameRemainingMs, 0);
  }
});

test('camera points outside the map are rejected instead of clamped on initial arm or recenter', () => {
  const c = config();
  const initial = planCameraArm(c, { target: { x: 100, y: 40 }, ageMs: 0 });
  assert.equal(initial.reason, 'camera-point-outside-map'); assert.equal(initial.point, undefined);
  const f = frame(c, { x: 1015, y: 450 });
  f.context.point.x = f.proof.x = 112; f.target.x -= 204;
  assert.ok(f.target.x >= 100, 'current target itself remains in map');
  const p = planCameraRecenter(c, f, margin());
  assert.equal(p.reason, 'camera-point-outside-map'); assert.equal(p.point, undefined);
});

test('motion and full inverse shear determine margin using frame age plus next-proof latency', () => {
  const c = config(), f = frame(c, { x: 1100, y: 450 });
  assert.equal(planCameraRecenter(c, f, margin()).action, 'keep');
  const p = planCameraRecenter(c, f, margin({ speedMapPxPerSecond: { x: 5, y: 2 } }));
  assert.equal(p.action, 'recenter');
  const det=.03*.05-(-.0005*.001), mx=1+5*.8, my=1+2*.8;
  near(p.margin.x,.05/det*mx+.0005/det*my);
  near(p.margin.y,.001/det*mx+.03/det*my);
  const reversed = planCameraRecenter(c, f, margin({ speedMapPxPerSecond: { x: -5, y: -2 } }));
  assert.deepEqual(reversed.margin, p.margin, 'motion envelope handles either direction without guessing acceleration');
});

test('margin exceeding the domain triggers current-evidence recenter with a coverage diagnostic', () => {
  const c = config();
  const fast = planCameraRecenter(c, frame(c, { x: 1450, y: 470 }), margin({ speedMapPxPerSecond: { x: 0, y: 20 } }));
  assert.equal(fast.action, 'recenter'); assert.equal(fast.coverageInsufficient, true);
  assert.equal(fast.reason, 'coverage-insufficient');
  c.cameraAssist.anchorBounds = { x: 1208, y: 369, width: 500, height: 95 };
  const narrow = planCameraRecenter(c, frame(c, { x: 1458, y: 430 }), margin({ projectionErrorPx: 3 }));
  assert.equal(narrow.action, 'recenter'); assert.equal(narrow.coverageInsufficient, true);
  const same = planCameraRecenter(c, frame(c, { x: 1458, y: 416.5 }), margin({ projectionErrorPx: 3 }));
  assert.equal(same.action, 'keep'); assert.equal(same.coverageInsufficient, true);
  assert.deepEqual(same.point, hold, 'same integer point must not fabricate a new camera transition');
  assert.deepEqual(c.cameraAssist.anchorBounds, { x: 1208, y: 369, width: 500, height: 95 });
});

test('missing adjacent velocity is explicit and does not delay a current edge placement', () => {
  const c = config(), f = frame(c, { x: 1015, y: 450 });
  const p = planCameraRecenter(c, f, margin({ speedMapPxPerSecond: null }));
  assert.equal(p.action, 'recenter'); assert.equal(p.speedKnown, false);
  assert.equal(planCameraRecenter(c, f, margin({ speedMapPxPerSecond: { x: 0, y: 0 } })).speedKnown, true);
});

test('invalid calibration and absent motion budgets cannot silently produce camera points', () => {
  for (const change of [c => { c.cameraAssist.matrix = [[1,2],[2,4],[0,0]]; },
    c => { c.cameraAssist.matrix[0][0] = Infinity; }, c => { c.cameraAssist.referenceWidth--; },
    c => { c.cameraAssist.anchorBounds.width = 9999; }, c => { c.map.width = 2; }]) {
    const c = config(); change(c);
    assert.equal(planCameraArm(c, { target: hold, ageMs: 0 }).reason, 'invalid-calibration');
  }
  for (const patch of [{ projectionErrorPx: -1 }, { speedMapPxPerSecond: { x: NaN, y: 0 } }, { horizonMs: 249 }, { horizonMs: 6001 }])
    assert.equal(planCameraRecenter(config(), frame(), margin(patch)).reason, 'invalid-motion-margin');
});

test('phone uptime origin cannot change placement and remaining frame time is diagnostic only', () => {
  const c = config(), first = frame(c, { x: 1015, y: 450 });
  const p = planCameraRecenter(c, first, margin());
  const shifted = structuredClone(first);
  for (const key of ['heldSinceUptimeMs','capturedAtUptimeMs','expiresAtUptimeMs']) shifted.proof[key] += 900000000000;
  assert.deepEqual(planCameraRecenter(c, shifted, margin()), p);
  shifted.frameAgeMs = 999;
  const late = planCameraRecenter(c, shifted, margin());
  assert.equal(late.frameRemainingMs, 1);
  assert.equal('ttlMs' in late, false, 'planner must not pretend a shared phone TTL is a per-pointer frame deadline');
  assert.equal('allowCameraMovement' in late, false, 'placement alone never grants movement');
});

test('initial camera lead includes full evidence age and latency but is bounded to one second', () => {
  const c = config(), full = { target: { x: 293.5, y: 169.5 }, ageMs: 550 };
  const lead = { speedMapPxPerSecond: { x: 14.4, y: 10.28 }, sampleIntervalMs: 500, intervalMs: 350, captureMs: 500 };
  const p = planCameraArm(c, full, lead);
  assert.equal(p.reason, 'calibrated-center-led'); assert.equal(p.prediction.applied, true);
  assert.equal(p.prediction.horizonMs, 1000);
  near(p.prediction.aimPoint.x, 307.9); near(p.prediction.aimPoint.y, 179.78);
  const shorter = planCameraArm(c, { ...full, ageMs: 100 }, { ...lead, captureMs: 50 });
  assert.equal(shorter.prediction.horizonMs, 450);
  const settling = planCameraArm(c, { ...full, ageMs: 100 }, { ...lead, intervalMs: 20, captureMs: 50 });
  assert.equal(settling.prediction.horizonMs, 350);
  assert.equal(p.frameRemainingMs, 0); assert.equal('ttlMs' in p, false);
});

test('old or unqualified speed uses the original arm, with an explicit rejected prediction', () => {
  const c = config(), full = { target: hold, ageMs: 200 };
  const lead = { speedMapPxPerSecond: { x: 14.4, y: 10.28 }, sampleIntervalMs: 500, intervalMs: 350, captureMs: 300 };
  for (const patch of [{ speedMapPxPerSecond: undefined }, { sampleIntervalMs: 0 }, { sampleIntervalMs: 1501 },
    { speedMapPxPerSecond: { x: Infinity, y: 0 } }, { captureMs: NaN }]) {
    const p = planCameraArm(c, full, { ...lead, ...patch });
    assert.equal(p.prediction.applied, false); assert.deepEqual(p.point, planCameraArm(c, full).point);
  }
  const old = planCameraArm(c, { ...full, ageMs: 1001 }, lead);
  assert.equal(old.prediction.reason, 'full-evidence-too-old'); assert.equal(old.prediction.applied, false);
  assert.equal(planCameraArm(c, { ...full, ageMs: 1000 }, lead).prediction.applied, true);
});

test('out-of-map prediction and rounded camera point both fall back without edge clamping', () => {
  const c = config(), full = { target: { x: 520, y: 218 }, ageMs: 600 };
  const lead = { speedMapPxPerSecond: { x: 10, y: 0 }, sampleIntervalMs: 500, intervalMs: 500, captureMs: 300 };
  const p = planCameraArm(c, full, lead);
  assert.equal(p.prediction.reason, 'predicted-target-outside-map'); assert.equal(p.prediction.applied, false);
  assert.deepEqual(p.point, planCameraArm(c, full).point); assert.notEqual(p.point.x, 524);
  const edge = { target: { x: 105, y: 218 }, ageMs: 600 };
  const cameraOutside = planCameraArm(c, edge, { ...lead, speedMapPxPerSecond: { x: -4.9, y: 0 } });
  assert.equal(cameraOutside.prediction.reason, 'predicted-camera-outside-map');
  assert.deepEqual(cameraOutside.point, planCameraArm(c, edge).point);
});
