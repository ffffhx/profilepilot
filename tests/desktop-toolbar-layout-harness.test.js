const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeState, layoutIssues, stages, isElectronFixtureEntry } = require('../scripts/e2e/desktop-toolbar-layout-main.cjs');
let harness;
test.before(async () => { harness = await import('../scripts/verify-desktop-toolbar-layout.mjs'); });

test('Electron ESM-loaded CJS entry is recognized while Node imports and other Electron entries stay inert', () => {
  const main = path.resolve('fixture.cjs'), argv = ['electron.exe', main, 'owned-home', 'a'.repeat(32), 'model.json'];
  assert.equal(isElectronFixtureEntry(argv, main, '42.3.3', 'browser'), true);
  assert.equal(isElectronFixtureEntry(argv, main, undefined, undefined), false);
  assert.equal(isElectronFixtureEntry(argv, main, '42.3.3', 'renderer'), false);
  assert.equal(isElectronFixtureEntry(['electron.exe', path.resolve('other.cjs')], main, '42.3.3', 'browser'), false);
  assert.equal(isElectronFixtureEntry([], main, '42.3.3', 'browser'), false);
});

function measure(stage = 'error') {
  const item = (text = '', visible = true, bottom = 190, height = 30) => ({ text, visible, centerHits: true,
    rect: { left: 15, top: bottom - height, right: 375, bottom, width: 360, height }, scrollHeight: height, clientHeight: height });
  return { viewport: { width: 390, height: 200 }, documentHeight: 200, nodes: {
    actions: item(), stop: item(), return: item(), takeover: item(),
    'control-state': item(stage === 'idle' ? '已结束' : ['paused', 'error'].includes(stage) ? '已暂停' : '正在控制'),
    'control-reason': item(['paused', 'error'].includes(stage) ? 'reason' : '', ['paused', 'error'].includes(stage), 100),
    'control-error': item(stage === 'error' ? 'long error' : '', stage === 'error', 155, stage === 'error' ? 48 : 0)
  } };
}
test('isolated model distinguishes fake paused/idle state without a real desktop service', () => {
  const common = { nonce: 'a'.repeat(32), reason: 'outcome_unknown', message: '真实文案' };
  const paused = makeState('paused', common); assert.equal(paused.session.state, 'paused'); assert.equal(paused.inputObservation.message, '真实文案');
  assert.equal(makeState('ready', common).inputObservation.message, undefined); assert.equal(makeState('idle', common).session, null);
  assert.deepEqual(stages, ['active', 'paused', 'error', 'recovered', 'new-owner', 'idle']);
});
test('model chooses the longest real message and a deliberately capped repeated error', () => {
  const messages = { one: '短', two: '这条更长' };
  const model = harness.selectMessageModel(Object.keys(messages), reason => messages[reason], '错误', 'a'.repeat(32));
  assert.equal(model.reason, 'two'); assert.equal(model.message, messages.two); assert.equal(model.error, '错误'.repeat(6));
  assert.equal(model.errorIsSyntheticRepetition, true);
});
test('fixture follows explicit production toolbar dimensions and fails if their contract changes', () => {
  assert.deepEqual(harness.toolbarViewport('new BrowserWindow({ width: 390, height: 200,'), { width: 390, height: 200 });
  assert.deepEqual(harness.toolbarViewport('new BrowserWindow({ width: 390, height: 220,'), { width: 390, height: 220 });
  assert.throws(() => harness.toolbarViewport('new BrowserWindow({ width: width, height: height,'));
  assert.throws(() => harness.toolbarViewport('new BrowserWindow({ width: 1, height: 200,'));
});
test('rect validation rejects clipped buttons, overflow and a covered click center', () => {
  assert.deepEqual(layoutIssues(measure(), 'error'), []);
  const clipped = measure(); clipped.nodes.stop.rect.bottom = 205.4; clipped.documentHeight = 205.4;
  assert.ok(layoutIssues(clipped, 'error').includes('stop_outside_viewport')); assert.ok(layoutIssues(clipped, 'error').includes('document_overflows_viewport'));
  const covered = measure(); covered.nodes.stop.centerHits = false; assert.ok(layoutIssues(covered, 'error').includes('stop_center_occluded'));
});
test('error cap and stale reason/error/state are checked independently of geometry', () => {
  const small = measure(); small.nodes['control-error'].rect.height = 20; assert.ok(layoutIssues(small, 'error').includes('max_error_not_exercised'));
  for (const stage of ['recovered', 'new-owner', 'idle']) {
    const current = measure(stage); assert.deepEqual(layoutIssues(current, stage), []);
    current.nodes['control-error'].text = 'old'; assert.ok(layoutIssues(current, stage).includes('stale_error'));
    current.nodes['control-reason'].text = 'old'; assert.ok(layoutIssues(current, stage).includes('stale_pause_reason'));
    current.nodes['control-state'].text = 'old'; assert.ok(layoutIssues(current, stage).includes('stale_state_label'));
  }
});

test('toolbar cleanup waits for normal exit and never invokes forced cleanup when confirmed', async () => {
  let cleanups = 0;
  const result = await harness.confirmToolbarExit(async () => ({ ok: true, originalExited: true }), async () => { cleanups++; throw new Error('must not kill'); });
  assert.equal(result.ok, true); assert.equal(result.forced, false); assert.equal(cleanups, 0);
});

test('forced fallback fails acceptance, while an exit racing the fallback remains normal', async () => {
  for (const forced of [true, false]) {
    const calls = [];
    const result = await harness.confirmToolbarExit(async () => { calls.push('wait'); return { ok: true, originalExited: false, timedOut: true }; },
      async () => { calls.push('cleanup-owned'); return { ok: true, originalExited: true, ...(forced ? { forced: true } : {}) }; });
    assert.deepEqual(calls, ['wait', 'cleanup-owned']); assert.equal(result.ok, !forced); assert.equal(result.forced, forced);
  }
});

test('wait failure is recorded, requires exact cleanup, and unconfirmed fallback is rejected', async () => {
  const failure = async () => { throw new Error('read unavailable'); };
  const result = await harness.confirmToolbarExit(failure, async () => ({ ok: true, originalExited: true, forced: true }));
  assert.equal(result.waitError, 'read unavailable'); assert.equal(result.ok, false);
  await assert.rejects(harness.confirmToolbarExit(failure, async () => ({ ok: true, originalExited: false })));
});
