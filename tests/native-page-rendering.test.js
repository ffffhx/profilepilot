require('./helpers/native-dom-source.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { NativePage } = require('../src/main/tasks/native-page.ts');
const { NativeBrowser } = require('../src/main/tasks/native-browser.ts');

function fixture(options = {}) {
  const f = { calls: [], reads: [], y: 0, revision: 0, records: 6, rendering: false, pending: false, scrolls: 0, captures: 0,
    frames: [{ id: 'root', url: 'https://fixture.test/first', loaderId: 'load-1' }], task: { profileId: 'native:test', sessionId: 'render-test' } };
  const visual = () => ({ url: f.frames[0].url, document: f.frames[0].loaderId, width: 800, height: 600, x: 0, y: f.y, scale: 1, scrollWidth: 800, scrollHeight: f.records * 200 });
  const observers = new Set(), callbacks = new Map(); let nextRaf = 0;
  const fireFrame = handle => {
    const callback = callbacks.get(handle); if (!callback) return; callbacks.delete(handle);
    if (f.pending) { f.pending = false; f.records += 6; f.revision++; for (const observer of observers) observer.callback(); }
    callback(Date.now());
  };
  const context = vm.createContext({
    document: { getAnimations: () => [] },
    MutationObserver: class { constructor(callback) { this.callback = callback; } observe() { observers.add(this); } disconnect() { observers.delete(this); } },
    requestAnimationFrame: callback => { const handle = ++nextRaf; callbacks.set(handle, callback); if (f.rendering && !options.singleFramePulse) setImmediate(() => fireFrame(handle)); return handle; },
    cancelAnimationFrame: handle => callbacks.delete(handle),
    setTimeout, clearTimeout
  });
  context.window = context;
  f.page = new NativePage(async (_task, method, params = {}, session) => {
    f.calls.push({ method, params, session });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: f.frames[0], childFrames: f.frames.slice(1).map(frame => ({ frame })) } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: params.frameId === 'root' ? 1 : 2 };
    if (method === 'Runtime.evaluate') {
      if (params.expression.includes('profilepilot-paint:')) {
        assert.notEqual(params.awaitPromise, true, 'a serialized extension queue cannot pump frames while awaiting a page Promise');
        await new Promise(resolve => setImmediate(resolve));
        return { result: { value: vm.runInContext(params.expression, context) } };
      }
      if (params.expression.includes('profilepilot-capture-state')) return { result: { value: { url: visual().url, document: visual().document, revision: f.revision, roots: [1] } } };
      if (params.expression.startsWith('({url:')) return { result: { value: visual() } };
      throw Error('Unexpected evaluate');
    }
    if (method === 'Page.captureScreenshot') {
      if (options.captureError) throw options.captureError;
      f.captures++;
      if (!options.neverPaint) {
        f.rendering = true;
        for (const handle of [...callbacks.keys()]) fireFrame(handle);
        if (!options.singleFramePulse) await new Promise(resolve => setImmediate(resolve));
      }
      if (params.format === 'jpeg' && options.pumpTimeout) { options.onPumpTimeout?.(); throw Error('截图无响应，已停止等待。'); }
      if (params.format === 'png' && options.candidateError) {
        const error = options.candidateError;
        if (options.failCandidateOnce) options.candidateError = undefined;
        throw error;
      }
      if (params.format === 'png' && (options.alwaysMutate || options.mutateFirstCapture && f.captures === 2)) { f.revision++; f.records++; }
      return { data: Buffer.from(`frame-${f.captures}`).toString('base64') };
    }
    return {};
  });
  // Exercise the native adapter's frame lifecycle and real serialized rAF
  // barrier. The FastBrowser action itself is a one-shot scroll boundary.
  f.page.scoped = (_task, frame) => ({
    observe: async (_task, readOptions = {}, range) => {
      const slice = range || readOptions;
      f.reads.push({ frameId: frame.id, query: slice.query, offset: slice.offset });
      const document = frame.loaderId || frame.url;
      return { version: `v-${f.reads.length}`, url: frame.url, snapshot: `${slice.query || 'all'}: ${f.records} records`,
        fast: { document, guard: JSON.stringify([frame.url, document, [], [], [], {}]), candidates: [], slice },
        page: { totalText: 100, totalControls: 0, offset: 0, textOffset: 0 } };
    },
    execute: async (_task, action, synchronize) => {
      if (action.kind === 'scroll') { f.scrolls++; f.y += 600; f.pending = true; }
      if (synchronize) await synchronize();
      return `scrolled:${f.y}`;
    }
  });
  return f;
}

test('background scroll dispatches once, wakes painting, then resolves after lazy content changes', async () => {
  const f = fixture(); f.task.observation = await f.page.observe(f.task);
  const result = await f.page.execute(f.task, { kind: 'scroll', value: 'down' });
  assert.equal(result, 'scrolled:600'); assert.equal(f.scrolls, 1); assert.equal(f.records, 12);
  assert.equal(f.captures, 1, 'only the compositor wake screenshot is needed');
  assert.ok(f.calls.some(call => call.method === 'Runtime.evaluate' && call.params.contextId === 1 && call.params.expression.includes('profilepilot-paint:start')));
  assert.equal(f.calls.some(call => call.method === 'Emulation.setFocusEmulationEnabled'), false);
  assert.equal(f.calls.some(call => /bringToFront|activateTarget|tabs.update/i.test(call.method)), false);
  assert.match((await f.page.reobserve(f.task)).snapshot, /^all: 12 records\n/);
});

test('unavailable rendering reports the already-sent scroll without replay or activation', async () => {
  const f = fixture({ neverPaint: true }); f.task.observation = await f.page.observe(f.task);
  await assert.rejects(f.page.execute(f.task, { kind: 'scroll', value: 'down' }), error => error.code === 'NATIVE_RENDER_UNAVAILABLE' && /滚动已执行.*勿直接重放/.test(error.message));
  assert.equal(f.scrolls, 1); assert.equal(f.captures, 8); assert.equal(f.y, 600);
});

test('a timed-out compositor pulse can still finish the same barrier without replaying scroll', async () => {
  const f = fixture({ pumpTimeout: true }); f.task.observation = await f.page.observe(f.task);
  assert.equal(await f.page.execute(f.task, { kind: 'scroll', value: 'down' }), 'scrolled:600');
  assert.equal(f.scrolls, 1); assert.equal(f.records, 12); assert.equal(f.captures, 1);
  const capture = f.calls.findIndex(call => call.method === 'Page.captureScreenshot');
  assert.match(f.calls[capture + 1].params.expression, /profilepilot-paint:poll/);
  assert.equal(f.calls.filter(call => call.params.expression?.includes('profilepilot-paint:start')).length, 1);
});

test('three slow one-frame pulses can settle within the bounded Windows rendering budget', async () => {
  const now = Date.now; let clock = 10000;
  Date.now = () => clock;
  try {
    const f = fixture({ singleFramePulse: true, pumpTimeout: true, onPumpTimeout: () => { clock += 2500; } });
    f.task.observation = await f.page.observe(f.task);
    assert.equal(await f.page.execute(f.task, { kind: 'scroll', value: 'down' }), 'scrolled:600');
    assert.equal(f.scrolls, 1); assert.equal(f.captures, 3); assert.equal(f.records, 12);
  } finally { Date.now = now; }
});

test('timed-out pulses without frames remain bounded by the paint deadline', async () => {
  const now = Date.now; let clock = 10000;
  Date.now = () => clock;
  try {
    const f = fixture({ neverPaint: true, pumpTimeout: true, onPumpTimeout: () => { clock += 2500; } });
    f.task.observation = await f.page.observe(f.task);
    await assert.rejects(f.page.execute(f.task, { kind: 'scroll', value: 'down' }), error => error.code === 'NATIVE_RENDER_UNAVAILABLE');
    assert.equal(f.scrolls, 1); assert.equal(f.captures, 4); assert.equal(clock, 20000);
  } finally { Date.now = now; }
});

test('an explicit ownership error is never swallowed even if its text resembles a visual timeout', async () => {
  const stopped = Object.assign(Error('截图无响应，已停止等待。'), { code: 'NATIVE_USER_IN_CONTROL' });
  const f = fixture({ captureError: stopped }); f.task.observation = await f.page.observe(f.task);
  await assert.rejects(f.page.execute(f.task, { kind: 'scroll', value: 'down' }), error => error.code === stopped.code);
  assert.equal(f.calls.filter(call => call.method === 'Page.captureScreenshot').length, 1);
});

test('the requested PNG still fails after three bounded visual read timeouts', async () => {
  const timeout = Error('截图无响应，已停止等待。'), f = fixture({ candidateError: timeout });
  await assert.rejects(f.page.captureScreenshot(f.task), error => error === timeout);
  assert.equal(f.calls.filter(call => call.method === 'Page.captureScreenshot' && call.params.format === 'png').length, 3);
});

test('a transient image timeout retries only the read with a fresh state check and real result', async () => {
  const f = fixture({ candidateError: Error('截图无响应，已停止等待。'), failCandidateOnce: true });
  const result = await f.page.captureScreenshot(f.task);
  assert.ok(result.result.data); assert.equal(f.scrolls, 0);
  assert.equal(f.calls.filter(call => call.method === 'Page.captureScreenshot' && call.params.format === 'png').length, 2);
  assert.ok(f.calls.filter(call => call.params.expression?.includes('profilepilot-capture-state')).length >= 3);
});

test('an image timeout-shaped ownership error never retries capture', async () => {
  const error = Object.assign(Error('截图无响应，已停止等待。'), { code: 'NATIVE_USER_IN_CONTROL' });
  const f = fixture({ candidateError: error });
  await assert.rejects(f.page.captureScreenshot(f.task), failure => failure === error);
  assert.equal(f.calls.filter(call => call.method === 'Page.captureScreenshot' && call.params.format === 'png').length, 1);
});

test('a takeover during post-scroll paint preserves the ownership error and sends no further command', async () => {
  const f = fixture({ captureError: Object.assign(Error('用户正在操作浏览器'), { code: 'NATIVE_USER_IN_CONTROL' }) });
  f.task.observation = await f.page.observe(f.task);
  await assert.rejects(f.page.execute(f.task, { kind: 'scroll', value: 'down' }), error => error.code === 'NATIVE_USER_IN_CONTROL');
  assert.equal(f.scrolls, 1); assert.equal(f.calls.filter(call => call.method === 'Page.captureScreenshot').length, 1);
  assert.match(f.calls.at(-1).params.expression, /profilepilot-paint:cleanup/);
});

test('one compositor frame per capture advances the same registered barrier until lazy content settles', async () => {
  const f = fixture({ singleFramePulse: true }); f.task.observation = await f.page.observe(f.task);
  await f.page.execute(f.task, { kind: 'scroll', value: 'down' });
  assert.equal(f.scrolls, 1); assert.equal(f.records, 12);
  assert.equal(f.captures, 3, 'three pulses advance the initial frame and two quiet follow-up frames');
  const starts = f.calls.filter(call => call.params.expression?.includes('profilepilot-paint:start'));
  assert.equal(starts.length, 1, 'the waiter must be registered before captures and retained between them');
  assert.match(f.calls.at(-1).params.expression, /profilepilot-paint:cleanup/);
});

test('stable screenshot discards a capture that changed DOM and returns a later matching frame', async () => {
  const f = fixture({ mutateFirstCapture: true });
  const capture = await f.page.captureScreenshot(f.task);
  const pngCalls = f.calls.filter(call => call.method === 'Page.captureScreenshot' && call.params.format === 'png');
  assert.equal(pngCalls.length, 2, 'discard the stale first PNG and accept the second one');
  assert.notEqual(Buffer.from(capture.result.data, 'base64').toString(), 'frame-2');
  assert.equal(capture.visual.scrollHeight, 1400);
  assert.equal(f.calls.some(call => call.method === 'Emulation.setFocusEmulationEnabled'), false);
});

test('continuous screenshot changes are bounded and blank task pages skip all captures', async () => {
  const f = fixture({ alwaysMutate: true });
  await assert.rejects(f.page.captureScreenshot(f.task), error => error.code === 'NATIVE_RENDER_UNAVAILABLE' && /持续变化/.test(error.message));
  assert.equal(f.calls.filter(call => call.method === 'Page.captureScreenshot' && call.params.format === 'png').length, 3, 'at most three candidate images, apart from bounded paint pulses');
  const blank = fixture(); blank.frames[0].url = 'about:blank';
  await assert.rejects(blank.page.captureScreenshot(blank.task), /空白任务页/);
  assert.equal(blank.captures, 0);
});

test('navigation clears a previous query even if the task still holds the old observation', async () => {
  for (const event of [false, true, 'same-document']) {
    const f = fixture(); f.task.observation = await f.page.observe(f.task, { query: 'old-specific-result', limit: 10 });
    f.frames[0] = { ...f.frames[0], url: 'https://fixture.test/second', loaderId: event === 'same-document' ? 'load-1' : 'load-2' };
    if (event) f.page.event({ type: 'cdp', profileId: f.task.profileId, sessionId: f.task.sessionId,
      method: event === 'same-document' ? 'Page.navigatedWithinDocument' : 'Page.frameNavigated',
      params: event === 'same-document' ? { frameId: 'root', url: f.frames[0].url } : { frame: f.frames[0] } });
    assert.match((await f.page.reobserve(f.task)).snapshot, /^all: 6 records\n/);
    assert.equal(f.reads.at(-1).query, undefined);
  }
});

test('a removed selected frame falls back to the root without its old query/range', async () => {
  const f = fixture(); f.frames.push({ id: 'child', parentId: 'root', url: 'https://child.test', loaderId: 'child-load' });
  f.task.observation = await f.page.observe(f.task, { frameId: 'child', query: 'child-only', textLimit: 100 });
  f.frames.pop();
  const observation = await f.page.reobserve(f.task);
  assert.equal(observation.page.frameId, 'root'); assert.match(observation.snapshot, /^all: 6 records\n/);
});

test('screenshot observation reads DOM again after capture and binds refs to the final frame', async () => {
  const state = { profileId: 'native:test', connected: true, taskTabs: true, ownership: 'agent', ownerSessionId: 'one' };
  const browser = new NativeBrowser({ states: () => [state], onEvent: () => () => {} }, 'unused-artifacts');
  const task = { profileId: state.profileId, sessionId: 'one' }, visual = { width: 800, height: 600, x: 0, y: 600 };
  let captured = false;
  browser.fast.reobserve = async () => ({ version: captured ? 'after' : 'before', url: 'https://fixture.test', snapshot: captured ? 'new records' : 'old records', fast: {} });
  browser.fast.captureScreenshot = async () => { captured = true; return { result: { data: 'cG5n' }, visual }; };
  browser.fast.visualState = async () => visual;
  const observation = await browser.observe(task, true, false);
  assert.equal(observation.version, 'after'); assert.equal(observation.snapshot, 'new records');
  assert.equal(observation.screenshotDataUrl, 'data:image/png;base64,cG5n');
  assert.deepEqual(observation.fast.visual, visual);
});

test('NativeBrowser screenshot uses the stable entry and resetObservation discards old selections', async () => {
  const browser = new NativeBrowser({ onEvent: () => () => {} }, 'unused-artifacts');
  const task = { observation: { version: 'old' } }; let reset = 0;
  browser.fast.resetSelection = selected => { assert.equal(selected, task); reset++; };
  browser.fast.captureScreenshot = async (selected, params) => { assert.equal(selected, task); assert.deepEqual(params, { format: 'jpeg' }); return { result: { data: 'final' } }; };
  assert.deepEqual(await browser.screenshot(task, { format: 'jpeg' }), { data: 'final' });
  browser.resetObservation(task); assert.equal(reset, 1); assert.equal(task.observation, undefined);
});

test('failed optional screenshots refresh readable DOM but never read after takeover', async () => {
  for (const takeover of [false, true]) {
    const state = { profileId: 'native:test', connected: true, taskTabs: true, ownership: 'agent', ownerSessionId: 'one' };
    const browser = new NativeBrowser({ states: () => [state], onEvent: () => () => {} }, 'unused-artifacts');
    const task = { profileId: state.profileId, sessionId: 'one' }; let reads = 0;
    browser.fast.reobserve = async () => ({ url: 'https://fixture.test', snapshot: `read-${++reads}`, fast: {} });
    browser.fast.captureScreenshot = async () => { if (takeover) state.ownership = 'user'; throw Error('Capture unavailable'); };
    if (takeover) { await assert.rejects(browser.observe(task, true, false), /Capture unavailable/); assert.equal(reads, 1); }
    else { const observation = await browser.observe(task, true, false); assert.match(observation.snapshot, /^read-2.*\n截图暂不可用/); assert.equal(observation.screenshotDataUrl, undefined); }
  }
});
