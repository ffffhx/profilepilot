const test = require('node:test');
const assert = require('node:assert/strict');
const { observeAfterBrowserAction, ACTION_SETTLE_MS } = require('../dist/main/browser-action-feedback');
const { BrowserEngine, commandNeedsObservation } = require('../dist/main/browser-engine/engine');

test('post-action read sees delayed rendering and returns usable observation', async () => {
  let text = 'saving', invalidated = false;
  const timer = setTimeout(() => { text = 'saved'; }, 20);
  try {
    const result = await observeAfterBrowserAction({
      observe: async () => ({ version: 'v2', snapshot: text }), invalidate: () => { invalidated = true; }
    });
    assert.equal(ACTION_SETTLE_MS, 500);
    assert.equal(result.observation.snapshot, 'saved');
    assert.equal(result.observationStatus, 'available');
    assert.equal(result.nextStep, 'use-observation');
    assert.equal(invalidated, false);
  } finally { clearTimeout(timer); }
});

test('observation failure preserves successful input and does not leak page error data', async () => {
  let invalidations = 0;
  const result = await observeAfterBrowserAction({ settleMs: 0,
    observe: async () => { throw Object.assign(new Error('secret page content'), { code: 'PAGE_CLOSED' }); },
    invalidate: () => { invalidations++; }
  });
  assert.equal(result.actionOutcome, 'completed');
  assert.equal(result.observationStatus, 'unavailable');
  assert.equal(result.observationError.code, 'PAGE_CLOSED');
  assert.equal(result.observation, undefined);
  assert.equal(invalidations, 1);
  assert.doesNotMatch(JSON.stringify(result), /secret page content/);
});

test('handoff during waiting or in-flight observation discards refs without further actions', async () => {
  for (const phase of ['wait', 'read']) {
    let controlled = true, reads = 0, invalidated = false;
    const timer = phase === 'wait' ? setTimeout(() => { controlled = false; }, 5) : undefined;
    try {
      const result = await observeAfterBrowserAction({ settleMs: 20,
        check: () => { if (!controlled) throw Object.assign(new Error('handoff'), { code: 'USER_IN_CONTROL' }); },
        observe: async () => { reads++; controlled = false; return { version: 'unsafe' }; },
        invalidate: () => { invalidated = true; }
      });
      assert.equal(result.actionOutcome, 'completed');
      assert.equal(result.observationStatus, 'unavailable');
      assert.equal(result.observation, undefined);
      assert.equal(result.observationError.code, 'USER_IN_CONTROL');
      assert.equal(reads, phase === 'wait' ? 0 : 1);
      assert.equal(invalidated, true);
    } finally { clearTimeout(timer); }
  }
});

test('Gateway observes completed interactions once, outside the input timeout', async () => {
  const engine = new BrowserEngine(); let inputs = 0, reads = 0;
  engine.executeCommand = async () => { inputs++; return { action: 'click' }; };
  engine.transport = { request: async () => ({}) };
  engine.observeCommon = async () => { reads++; return { version: 'new', snapshot: 'Saved' }; };
  const result = await engine.execute({ args: ['click', '#save'], timeout: 50 });
  assert.equal(inputs, 1); assert.equal(reads, 1);
  assert.equal(result.actionOutcome, 'completed');
  assert.equal(result.observation.version, 'new');
  await engine.execute({ args: ['scrollintoview', '@e1'], timeout: 50, observeAfterAction: false });
  assert.equal(reads, 1, 'internal preparation preserves the pending action refs');
  engine.observeCommon = async () => { reads++; throw new Error('tab closed after click'); };
  const unavailable = await engine.execute({ args: ['click', '#save'], timeout: 50 });
  assert.equal(inputs, 3); assert.equal(reads, 2);
  assert.equal(unavailable.actionOutcome, 'completed');
  assert.equal(unavailable.observationStatus, 'unavailable');
  engine.executeCommand = async () => { throw new Error('input failed'); };
  await assert.rejects(engine.execute({ args: ['click', '#save'], timeout: 50 }), /input failed/);
  assert.equal(reads, 2, 'failed input never triggers success feedback');
});

test('command classification covers interactions without delaying reads or partial key sequences', () => {
  for (const args of [['action'], ['open'], ['click'], ['fill'], ['press'], ['keyboard', 'type'], ['scroll'],
    ['find', 'role', 'button', 'dblclick'], ['find', 'nth', '2', 'button', 'click'], ['tab', 't2'], ['frame', 'main'], ['mouse', 'up']])
    assert.equal(commandNeedsObservation(args), true, args.join(' '));
  for (const args of [['snapshot'], ['observe'], ['get', 'text'], ['eval'], ['tabs'], ['tabs', 'list'], ['tab', 'close'],
    ['keydown'], ['keyup'], ['mouse', 'down'], ['handoff'], ['complete'], ['find', 'text', 'click', 'text']])
    assert.equal(commandNeedsObservation(args), false, args.join(' '));
});
