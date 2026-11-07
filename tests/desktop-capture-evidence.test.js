const test = require('node:test');
const assert = require('node:assert/strict');
const clone = value => structuredClone(value);
const rect = (x = 80, width = 658) => ({ x, y: 80, width, height: 487 });
const start = '2026-10-29T18:00:00.000Z', middle = '2026-10-29T18:00:00.010Z', end = '2026-10-29T18:00:00.030Z';
const state = windowRect => ({ windowRect, clientRect: { x: windowRect.x + 9, y: 118, width: windowRect.width - 18, height: 440 } });
function fixture() {
  return { response: { ok: false, code: 'DESKTOP_WINDOW_CHANGED', cause: 'CAPTURE_WINDOW_CHANGED', geometryStressRunId: 'owned-run', captureStartedAt: start, captureFinishedAt: end,
    diagnostics: { capture: { source: 'window-state', status: 'window_changed', before: state(rect()), after: state(rect(81, 656)) } } },
    after: { geometryStress: { source: 'owned-ui-timer', runId: 'owned-run', historyTruncated: false,
      events: [{ startedAt: middle, finishedAt: middle, before: rect(), after: rect(81, 656) }] } } };
}
test('external geometry stress counts only real production rejection plus overlapping timer mutation evidence', async () => {
  const { classifyExternalGeometryCapture: classify } = await import('../scripts/e2e/desktop-capture-evidence.mjs');
  const value = fixture();
  assert.equal(classify(value.response, value.after).status, 'observed');
  assert.deepEqual(classify(value.response, value.after).before, value.response.diagnostics.capture.before);
  assert.equal(classify({ ok: true }, value.after).status, 'not_observed', 'successful read is not a guard failure');
  assert.equal(classify({ ok: false, code: 'DESKTOP_SCREENSHOT_UNAVAILABLE' }, value.after).status, 'unexpected_failure');
});
test('a WINDOW_CHANGED code without differing real rectangles cannot pass the stress case', async () => {
  const { classifyExternalGeometryCapture: classify } = await import('../scripts/e2e/desktop-capture-evidence.mjs');
  for (const mutate of [value => delete value.response.diagnostics, value => value.response.diagnostics.capture.source = 'fixture',
    value => value.response.diagnostics.capture.after = clone(value.response.diagnostics.capture.before),
    value => value.response.diagnostics.capture.after.windowRect.width = NaN]) {
    const value = fixture(); mutate(value); assert.equal(classify(value.response, value.after).status, 'not_observed');
  }
});
test('missing ordinary unchanged out-of-window or truncated mutation records cannot prove external overlap', async () => {
  const { classifyExternalGeometryCapture: classify } = await import('../scripts/e2e/desktop-capture-evidence.mjs');
  for (const mutate of [value => delete value.after.geometryStress, value => value.after.geometryStress.source = 'wm-print',
    value => value.response.geometryStressRunId = 'different-run',
    value => value.after.geometryStress.historyTruncated = true, value => value.after.geometryStress.events = [],
    value => value.after.geometryStress.events[0].after = clone(value.after.geometryStress.events[0].before),
    value => { value.after.geometryStress.events[0].startedAt = '2026-10-29T17:59:59Z'; value.after.geometryStress.events[0].finishedAt = start; },
    value => value.after.geometryStress.events[0].finishedAt = '2026-10-29T18:00:01Z',
    value => value.response.captureStartedAt = 'invalid']) {
    const value = fixture(); mutate(value); assert.equal(classify(value.response, value.after).status, 'not_observed');
  }
});
