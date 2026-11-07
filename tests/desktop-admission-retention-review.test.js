// Pure failure model: an injected provider ignores cancellation indefinitely.
// No real provider/OS/helper is called; this does not diagnose the actual App.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { loadCli } = require('./cli-test-build.cjs');
const { createRuntimeDesktopAdmission } = loadCli('src/main/desktop/runtime-admission.ts');
const { DesktopService } = loadCli('src/main/desktop/service.ts');
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const catalog = (at = 100) => ({ profiles: [], externalInstances: [], discovery: {
  snapshotId: 'pure-retention', capturedAt: at, complete: true, processPids: [41], scopedGaps: [] } });
const controls = { gateway: async () => ({ state: { profiles: [] }, ports: [] }), native: async () => ({ states: [] }) };

// Isolate the runtime provider adapter so individual caller signals/deadlines
// can be advanced without racing real timers. Production adapter code remains
// unchanged; only its outer collector factory is replaced with an identity.
function providerFactory() {
  const target = path.resolve(__dirname, '../src/main/desktop/runtime-admission.ts');
  const text = fs.readFileSync(process.env.PROFILEPILOT_RETENTION_TEST_SOURCE || target, 'utf8');
  let replaced = false;
  const contents = text.replace(/^import \{ createDesktopAdmission, (.*) \} from '\.\/admission';$/m, (_, types) => {
    replaced = true;
    return `import { ${types} } from './admission';\nconst createDesktopAdmission = (providers: unknown) => providers;`;
  });
  assert.ok(replaced, 'collector injection anchor');
  const built = buildSync({ stdin: { contents, sourcefile: target, resolveDir: path.dirname(target), loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], logLevel: 'silent' });
  const instance = new Module(target, module); instance.filename = target; instance.paths = Module._nodeModulePaths(path.dirname(target));
  instance._compile(built.outputFiles[0].text, target);
  return instance.exports.createRuntimeDesktopAdmission;
}
const providersFor = providerFactory();
function context(deadlineAt = 200, now = () => 100) {
  const controller = new AbortController(), signal = controller.signal, listeners = new Set();
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, listener, options) => { if (type === 'abort') listeners.add(listener); return add(type, listener, options); };
  signal.removeEventListener = (type, listener, options) => { if (type === 'abort') listeners.delete(listener); return remove(type, listener, options); };
  return { deadlineAt, now, signal, abort: () => controller.abort(), listeners };
}
function track(promise) {
  const state = { settled: false };
  state.done = promise.then(value => Object.assign(state, { settled: true, ok: true, value }), error => Object.assign(state, { settled: true, ok: false, error }));
  return state;
}

test('repeated expired callers add zero reactions to the indefinitely pending shared discovery promises', async t => {
  const a = deferred(), b = deferred(); let rounds = 0;
  const originalThen = Promise.prototype.then, seen = new WeakMap(), records = [];
  Promise.prototype.then = function (...args) {
    let record = seen.get(this);
    if (!record) {
      record = { subscriptions: 0, settled: false }; seen.set(this, record); records.push(record);
      originalThen.call(this, () => { record.settled = true; }, () => { record.settled = true; });
    }
    record.subscriptions++; return originalThen.apply(this, args);
  };
  try {
    const admit = createRuntimeDesktopAdmission({ ...controls, now: () => 100, timeoutMs: 2,
      discovery: () => { rounds++; return { catalog: a.promise, apps: b.promise }; } });
    for (let i = 0; i < 10; i++) assert.equal((await admit({ pid: 41 })).status, 'unknown');
    await turn(); const retained = records.filter(record => !record.settled), before = retained.map(record => record.subscriptions);
    for (let i = 0; i < 20; i++) assert.equal((await admit({ pid: 41 })).status, 'unknown');
    await turn();
    assert.equal(rounds, 1);
    const additional = retained.reduce((sum, record, index) => sum + record.subscriptions - before[index], 0);
    t.diagnostic(JSON.stringify({ model: 'never-settling injected source, not observed OS failure', rounds, laterCalls: 20, additionalRetainedSubscriptions: additional }));
    assert.equal(additional, 0, 'timed-out callers must detach rather than accumulate in shared Promise reactions');
  } finally {
    Promise.prototype.then = originalThen;
    a.resolve(catalog()); b.resolve({ applications: [] }); await turn();
  }
});

test('already-aborted callers never retain listeners or join an existing read', async () => {
  const pending = deferred(); let rounds = 0;
  const providers = providersFor({ ...controls, now: () => 100,
    discovery: () => { rounds++; return { catalog: pending.promise, apps: Promise.resolve({ applications: [] }) }; } });
  const first = context(), firstRead = track(providers.catalog(first)), refused = [];
  try {
    await turn();
    for (let i = 0; i < 40; i++) { const c = context(); c.abort(); refused.push([c, track(providers.catalog(c))]); }
    await turn();
    assert.equal(rounds, 1);
    assert.ok(refused.every(([c, read]) => c.listeners.size === 0 && read.settled && !read.ok && read.error.message === 'provider_timeout'));
    assert.equal(firstRead.settled, false);
  } finally { pending.resolve(catalog()); await firstRead.done; await Promise.all(refused.map(([, read]) => read.done)); }
  assert.equal(first.listeners.size, 0);
});

test('one cancelled waiter releases its listener without cancelling a live sibling or starting a second read', async () => {
  const pending = deferred(); let rounds = 0, originalContext;
  const providers = providersFor({ ...controls, now: () => 100,
    discovery: ctx => { rounds++; originalContext = ctx; return { catalog: pending.promise, apps: Promise.resolve({ applications: [] }) }; } });
  const a = context(), b = context(), first = track(providers.catalog(a)), second = track(providers.catalog(b));
  try {
    await turn(); a.abort(); await turn();
    assert.equal(first.settled, true); assert.equal(first.ok, false); assert.equal(first.error.message, 'provider_timeout');
    assert.equal(a.listeners.size, 0); assert.equal(b.listeners.size, 1); assert.equal(second.settled, false);
    assert.equal(rounds, 1); assert.equal(originalContext.catalog, a);
    pending.resolve(catalog()); await second.done;
    assert.equal(second.ok, true); assert.equal(second.value.capturedAt, 100); assert.equal(b.listeners.size, 0);
  } finally { pending.resolve(catalog()); await Promise.all([first.done, second.done]); }
});

test('settlement at the deadline rejects only that caller even before its abort timer has fired', async () => {
  const pending = deferred(); let time = 100;
  const providers = providersFor({ ...controls, now: () => 100,
    discovery: () => ({ catalog: pending.promise, apps: Promise.resolve({ applications: [] }) }) });
  const a = context(200, () => time), b = context(201, () => time);
  const first = track(providers.catalog(a)), second = track(providers.catalog(b));
  time = 200; pending.resolve(catalog()); await Promise.all([first.done, second.done]);
  assert.equal(a.signal.aborted, false); assert.equal(first.ok, false); assert.equal(first.error.message, 'provider_timeout');
  assert.equal(second.ok, true); assert.equal(second.value.capturedAt, 100);
  assert.equal(a.listeners.size, 0); assert.equal(b.listeners.size, 0);
});

test('provider rejection remains the original failure and removes every live caller listener', async () => {
  const pending = deferred(), sibling = deferred(), failure = new Error('PROFILE_FILE_PROCESS_CHANGED');
  const providers = providersFor({ ...controls, now: () => 100,
    discovery: () => ({ catalog: pending.promise, apps: sibling.promise }) });
  const a = context(), b = context(), first = track(providers.catalog(a)), second = track(providers.catalog(b));
  try {
    pending.reject(failure); await Promise.all([first.done, second.done]);
    assert.equal(first.error, failure); assert.equal(second.error, failure);
    assert.equal(a.listeners.size, 0); assert.equal(b.listeners.size, 0);
    let synchronous = true;
    const late = providers.catalog(context()).catch(error => { assert.equal(synchronous, false); assert.equal(error, failure); });
    synchronous = false; await late;
  } finally { sibling.resolve({ applications: [] }); await turn(); }
});

test('a settled sibling is delivered asynchronously with its original timestamp and cannot release a still-pending round', async () => {
  const pending = deferred(); let rounds = 0, now = 100;
  const providers = providersFor({ ...controls, now: () => now,
    discovery: () => { rounds++; return { catalog: pending.promise, apps: Promise.resolve({ applications: [] }) }; } });
  const a = context(500, () => now), b = context(500, () => now);
  const slow = track(providers.catalog(a)); const first = await providers.apps(b); now = 150;
  let synchronous = true;
  const repeat = providers.apps(context(500, () => now)).then(result => {
    assert.equal(synchronous, false); assert.equal(result, first); assert.equal(result.capturedAt, 100); return result;
  });
  synchronous = false; await repeat;
  assert.equal(rounds, 1); assert.equal(slow.settled, false);
  pending.resolve(catalog()); await slow.done; await turn();
  await providers.apps(context(500, () => now)); assert.equal(rounds, 2);
  assert.equal(a.listeners.size, 0); assert.equal(b.listeners.size, 0);
});

test('legacy sampled transports also remove cancelled callers while preserving their single in-flight read', async () => {
  const pending = deferred(); let reads = 0;
  const providers = providersFor({ catalog: async () => catalog(), apps: async () => [], native: controls.native,
    gateway: () => { reads++; return pending.promise; }, now: () => 100 });
  const a = context(), b = context(), first = track(providers.gateway(a)), second = track(providers.gateway(b));
  try {
    await turn(); a.abort(); await turn();
    assert.equal(first.settled, true); assert.equal(first.ok, false); assert.equal(a.listeners.size, 0);
    assert.equal(reads, 1); assert.equal(second.settled, false);
  } finally { pending.resolve({ state: { profiles: [] }, ports: [] }); await Promise.all([first.done, second.done]); }
  assert.equal(second.ok, true); assert.equal(b.listeners.size, 0);
});

test('a late real-adapter success cannot resume a taken-over DesktopService or dispatch its pending observation', async () => {
  const pending = deferred(); let slow = false, rounds = 0, observations = 0;
  const admission = createRuntimeDesktopAdmission({ ...controls, now: () => 100, timeoutMs: 1000,
    discovery: () => { rounds++; return { catalog: slow ? pending.promise : Promise.resolve(catalog()), apps: Promise.resolve({ applications: [] }) }; } });
  const window = { id: 'a'.repeat(32), pid: 41, title: 'Pure', process: 'fake', className: 'fake' };
  const service = new DesktopService({ platform: 'win32', available: () => true, allowUnobservedTestDriver: true, admission,
    driver: () => ({ close() {}, async request(operation) {
      if (operation === 'windows') return { windows: [window] };
      assert.equal(operation, 'window.observe'); observations++; return { windowId: window.id, version: 'b'.repeat(32), elements: [] };
    } }) });
  try {
    await service.execute({ action: 'desktop', method: 'claim', session: 'retention-owner', windowId: window.id });
    slow = true; const read = track(service.execute({ action: 'desktop', method: 'observe', session: 'retention-owner' }));
    await turn(); assert.equal(rounds, 2); service.control('takeover');
    pending.resolve(catalog()); await read.done;
    assert.equal(read.ok, false); assert.equal(read.error.code, 'DESKTOP_USER_IN_CONTROL');
    assert.equal(observations, 0); assert.equal(service.status().session.state, 'paused');
  } finally { pending.resolve(catalog()); await service.close(); }
});
