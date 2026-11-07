const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { loadCli } = require('./cli-test-build.cjs');
const { followDesktopStatus } = loadCli('src/renderer/desktop-status.ts');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const state = phase => ({ available: true, stopShortcutAvailable: true, inputObservation: { phase, ...(phase === 'idle' ? {} : { generation: 'g1' }) }, session: phase === 'idle' ? null : { name: 'owned-fixture', revision: 0, state: phase === 'ready' ? 'active' : 'paused', window: { title: 'Fixture' } } });
function fixture() {
  let notify, unsubscribed = 0; const reads = [], rendered = [], errors = [];
  const feed = followDesktopStatus({ status() { const read = deferred(); reads.push(read); return read.promise; },
    onChanged(listener) { notify = listener; return () => { unsubscribed++; }; } }, value => rendered.push(value), error => errors.push(error));
  return { feed, reads, rendered, errors, notify: value => notify(value), get unsubscribed() { return unsubscribed; } };
}

test('control changes render immediately without waiting for timers or reads', () => {
  const f = fixture(); f.notify(state('arming')); f.notify(state('ready')); f.notify(state('paused')); f.notify(state('idle'));
  assert.deepEqual(f.rendered.map(value => value.inputObservation.phase), ['arming', 'ready', 'paused', 'idle']);
  assert.equal(f.reads.length, 0); f.feed.dispose();
});

test('toolbar return sends the rendered owner and revision, without refreshing into an unseen successor', async () => {
  const nodes = new Map(); const element = id => { if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: false }); return nodes.get(id); };
  let notify, current = state('paused'); const actions = [];
  current.session.revision = 3;
  const api = { status: async () => current, onChanged(listener) { notify = listener; return () => {}; },
    control(...args) { actions.push(args); return Promise.resolve(); } };
  vm.runInNewContext(fs.readFileSync('public/desktop-control.js', 'utf8'), { document: { getElementById: element },
    window: { desktopControl: api, addEventListener() {} }, setInterval() { return 1; }, clearInterval() {} });
  await new Promise(resolve => setImmediate(resolve));
  current = state('paused'); current.session.name = 'unseen-successor'; current.inputObservation.generation = 'g2';
  await element('return').onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(actions)), [['return', { session: 'owned-fixture', generation: 'g1', revision: 3 }]]);
  current.session.revision = 4; notify(current); await element('return').onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(actions[1])), ['return', { session: 'unseen-successor', generation: 'g2', revision: 4 }]);
  current = { ...state('paused'), inputObservation: { phase: 'paused' } }; notify(current);
  assert.equal(element('return').hidden, true); await element('return').onclick(); assert.equal(actions.length, 2);
});
test('a pending active read cannot overwrite a later takeover notification', async () => {
  const f = fixture(), reading = f.feed.refresh(); f.notify(state('paused')); f.reads[0].resolve(state('ready')); await reading;
  assert.deepEqual(f.rendered.map(value => value.inputObservation.phase), ['paused']); f.feed.dispose();
});
test('out-of-order replies and stale read errors cannot replace newer state', async () => {
  const f = fixture(), first = f.feed.refresh(), second = f.feed.refresh();
  f.reads[1].resolve(state('idle')); await second; f.reads[0].reject(new Error('old connection')); await first;
  assert.deepEqual(f.rendered.map(value => value.inputObservation.phase), ['idle']); assert.equal(f.errors.length, 0);
  const third = f.feed.refresh(); f.reads[2].reject(new Error('current connection')); await third;
  assert.equal(f.errors[0].message, 'current connection'); f.feed.dispose();
});
test('disposed document cannot render late notifications or reads and unsubscribes once', async () => {
  const f = fixture(), reading = f.feed.refresh(); f.feed.dispose(); f.feed.dispose(); f.notify(state('ready'));
  f.reads[0].resolve(state('ready')); await reading; assert.equal(f.unsubscribed, 1); assert.equal(f.rendered.length, 0);
});
test('the sandboxed toolbar applies push takeover while its initial status read is pending', async () => {
  const nodes = new Map(); const element = id => { if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: false }); return nodes.get(id); };
  const initial = deferred(), events = {}; let notify, unsubscribed = 0, cleared = 0;
  const context = vm.createContext({ document: { getElementById: element }, window: {
    desktopControl: { status: () => initial.promise, onChanged(listener) { notify = listener; return () => { unsubscribed++; }; } },
    addEventListener(name, listener) { events[name] = listener; }
  }, setInterval() { return 1; }, clearInterval() { cleared++; } });
  vm.runInContext(fs.readFileSync('public/desktop-control.js', 'utf8'), context);
  notify(state('paused')); assert.equal(element('control-state').textContent, '已暂停');
  assert.equal(element('takeover').hidden, true); assert.equal(element('return').hidden, false);
  initial.resolve(state('ready')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('control-state').textContent, '已暂停');
  notify(state('arming')); assert.equal(element('return').hidden, true);
  notify(state('idle')); assert.equal(element('control-state').textContent, '已结束');
  events.pagehide(); notify(state('ready')); assert.equal(element('control-state').textContent, '已结束');
  assert.equal(unsubscribed, 1); assert.equal(cleared, 1);
});

test('toolbar errors belong to their control state and late failures cannot leak into a successor', async () => {
  const nodes = new Map(); const element = id => { if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: false }); return nodes.get(id); };
  let current = state('paused'), notify; const actions = [];
  current.inputObservation = { phase: 'paused', generation: 'g1', message: '输入观察连接中断' };
  const context = vm.createContext({ document: { getElementById: element }, window: {
    desktopControl: { status: async () => current, control() { const action = deferred(); actions.push(action); return action.promise; },
      onChanged(listener) { notify = listener; return () => {}; } }, addEventListener() {}
  }, setInterval() { return 1; }, clearInterval() {} });
  vm.runInContext(fs.readFileSync('public/desktop-control.js', 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('control-reason').hidden, false);
  const failed = element('return').onclick(); actions[0].reject(new Error("Error invoking remote method 'desktop:request': Error: first attempt failed")); await failed;
  assert.equal(element('control-error').textContent, 'first attempt failed');
  assert.equal(element('control-error').hidden, false, 'same-state refresh preserves the current failure');
  current = state('ready'); current.inputObservation.generation = 'g2'; notify(current);
  assert.equal(element('control-error').textContent, ''); assert.equal(element('control-error').hidden, true);
  assert.equal(element('control-reason').textContent, ''); assert.equal(element('control-reason').hidden, true);
  current = state('paused'); current.inputObservation.generation = 'g2'; notify(current);
  const late = element('return').onclick();
  current = state('idle'); notify(current);
  current = state('ready'); current.session.name = 'successor fixture'; current.inputObservation.generation = 'g3'; notify(current);
  actions[1].reject(new Error('old delayed failure')); await late;
  assert.equal(element('control-error').textContent, ''); assert.equal(element('control-error').hidden, true);
  assert.equal(element('control-state').textContent, '正在控制');
});

test('toolbar acknowledges only after controls and state render, and again for each successor generation', async () => {
  const nodes = new Map(), events = {}, acks = []; let notify, current = state('arming'), timer;
  current.inputObservation.generation = 'g1';
  const element = id => { if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: false }); return nodes.get(id); };
  const api = { status: async () => current, onChanged(listener) { notify = listener; return () => {}; },
    noticeReady(generation) {
      assert.equal(typeof element('stop').onclick, 'function'); assert.equal(typeof element('takeover').onclick, 'function');
      assert.equal(element('control-state').textContent, '正在准备控制'); acks.push(generation); return Promise.resolve();
    } };
  vm.runInNewContext(fs.readFileSync('public/desktop-control.js', 'utf8'), { document: { getElementById: element },
    window: { desktopControl: api, addEventListener: (name, listener) => { events[name] = listener; } },
    setInterval(callback) { timer = callback; return 1; }, clearInterval() {} });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(acks, ['g1']);
  notify(current); await timer(); assert.deepEqual(acks, ['g1']);
  current = { ...current, inputObservation: { phase: 'arming', generation: 'g2' } }; notify(current);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(acks, ['g1', 'g2']);
  events.pagehide(); current.inputObservation.generation = 'g3'; notify(current); await timer();
  assert.deepEqual(acks, ['g1', 'g2']);
});

test('a failed first render cannot acknowledge a nonfunctional toolbar', async () => {
  const acks = []; let notify;
  const nodes = new Map(), element = id => { if (id === 'control-task') return null; if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); };
  const current = state('arming'); current.inputObservation.generation = 'g1';
  vm.runInNewContext(fs.readFileSync('public/desktop-control.js', 'utf8'), { document: { getElementById: element }, window: {
    desktopControl: { status: async () => current, noticeReady: async generation => { acks.push(generation); }, onChanged(listener) { notify = listener; return () => {}; } }, addEventListener() {}
  }, setInterval() { return 1; }, clearInterval() {} });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(acks, []);
  assert.throws(() => notify(current)); assert.deepEqual(acks, []);
});

test('slow toolbar status IPC cannot be starved by later polling ticks', async () => {
  const nodes = new Map(), reads = [], acks = []; let timer;
  const element = id => { if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: false }); return nodes.get(id); };
  vm.runInNewContext(fs.readFileSync('public/desktop-control.js', 'utf8'), { document: { getElementById: element }, window: {
    desktopControl: { status() { const read = deferred(); reads.push(read); return read.promise; },
      noticeReady: async generation => { acks.push(generation); }, onChanged() { return () => {}; } }, addEventListener() {}
  }, setInterval(callback) { timer = callback; return 1; }, clearInterval() {} });
  // Model an IPC response slower than several 500 ms polling intervals.
  const ticks = [timer(), timer(), timer()];
  assert.equal(reads.length, 1, 'polling must share the in-flight request, not invalidate its reply');
  reads[0].resolve(state('arming')); await Promise.all(ticks);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(acks, ['g1']); assert.equal(element('control-state').textContent, '正在准备控制');
  const next = timer(); assert.equal(reads.length, 2);
  reads[1].resolve(state('ready')); await next;
  assert.equal(element('control-state').textContent, '正在控制');
});

test('a takeover push still supersedes a slow coalesced toolbar read', async () => {
  const nodes = new Map(), reads = [], acks = []; let timer, notify;
  const element = id => { if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: false }); return nodes.get(id); };
  vm.runInNewContext(fs.readFileSync('public/desktop-control.js', 'utf8'), { document: { getElementById: element }, window: {
    desktopControl: { status() { const read = deferred(); reads.push(read); return read.promise; },
      noticeReady: async generation => { acks.push(generation); }, onChanged(listener) { notify = listener; return () => {}; } }, addEventListener() {}
  }, setInterval(callback) { timer = callback; return 1; }, clearInterval() {} });
  const polling = timer(); notify(state('idle')); reads[0].resolve(state('arming')); await polling;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(acks, []); assert.equal(element('control-state').textContent, '已结束');
});

for (const event of ['error', 'unhandledrejection']) test('main-world ' + event + ' forwards only revocation after readiness; caught control errors do not', async () => {
  const nodes = new Map(), events = {}, trace = [];
  const current = state('ready'); current.inputObservation.generation = 'g1';
  const element = id => { if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: false }); return nodes.get(id); };
  const api = { status: async () => current, onChanged() { return () => {}; },
    noticeReady: async generation => { trace.push(['ready', generation]); }, noticeFailed: (...args) => { trace.push(['failed', ...args]); },
    control: async () => { throw new Error('Expected caught operation failure'); } };
  vm.runInNewContext(fs.readFileSync('public/desktop-control.js', 'utf8'), { document: { getElementById: element },
    window: { desktopControl: api, addEventListener: (name, listener) => { events[name] = listener; } },
    setInterval() { return 1; }, clearInterval() {} });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(trace, [['ready', 'g1']]);
  await element('stop').onclick(); assert.match(element('control-error').textContent, /Expected caught operation failure/);
  assert.deepEqual(trace, [['ready', 'g1']], 'Handled operation errors remain local UI feedback');
  assert.equal(typeof events[event], 'function'); events[event]({ message: 'Do not send exception content', reason: 'private' });
  assert.deepEqual(trace, [['ready', 'g1'], ['failed']], 'Failure bridge has no arbitrary payload');
});
