const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { webcrypto, randomUUID } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { popupFixture } = require('./helpers/native-popup-fixture.cjs');
const { ExtensionConnectionJournal, readExtensionConnectionDiagnostics, parseExtensionConnectionEvent } = loadCli('src/main/extension-connection-diagnostics.ts');
const { createBrowserDoctor } = loadCli('src/main/control-doctor.ts');

function logger(storage = {}, source = 'worker', broken = false) {
  const listeners = {};
  const context = vm.createContext({ crypto: webcrypto, ...(source === 'popup' ? { document: {} } : {}),
    addEventListener: (event, handler) => { listeners[event] = handler; },
    chrome: { runtime: { getManifest: () => ({ version: '0.2.18' }) }, storage: { local: {
      get: async () => { if (broken) throw Error('storage unavailable'); return { ...storage }; },
      set: async values => { if (broken) throw Error('storage unavailable'); Object.assign(storage, values); },
      remove: async keys => { for (const key of keys) delete storage[key]; }
    } } }
  });
  vm.runInContext(fs.readFileSync('extensions/profilepilot/connection-diagnostics.js', 'utf8'), context);
  return { ...context.ProfilePilotConnectionDiagnostics, listeners, storage, context };
}

test('independent popup/worker records survive a new worker and contain no arbitrary data', async () => {
  const storage = { connection: { token: 'secret-pairing-token', port: 64109 }, arbitrary: 'private page content' };
  const worker = logger(storage), popup = logger(storage, 'popup');
  await Promise.all([
    worker.record('initialization-failed', { step: 'session-storage', token: 'secret-pairing-token', message: 'private page content', url: 'https://private.test' }),
    popup.record('popup-unreachable', popup.errorInfo(Error('Could not establish connection. Receiving end does not exist.')))
  ]);
  const restarted = logger(storage), report = await restarted.report();
  assert.equal(report.events.filter(row => row.event === 'worker-start').length, 2);
  assert.equal(report.events.filter(row => row.event === 'popup-unreachable').length, 1);
  assert.equal(report.events.find(row => row.event === 'initialization-failed').step, 'session-storage');
  assert.doesNotMatch(JSON.stringify(report), /secret-pairing|private page|private\.test/);
  assert.ok(report.events.every(row => parseExtensionConnectionEvent(row)));
});

test('early runtime failures retain safe source locations, storage failure keeps an exportable memory report', async () => {
  const log = logger({}, 'worker', true);
  const error = new TypeError('Cannot read properties of undefined (secret page text)');
  error.stack = 'TypeError: secret\n at chrome-extension://fixture/background.js:123:9\n at https://private.test:1:1';
  log.listeners.error({ error, lineno: 123, colno: 9 });
  log.listeners.unhandledrejection({ reason: error });
  const report = await log.report();
  assert.equal(report.storageAvailable, false);
  const row = report.events.find(row => row.event === 'runtime-error');
  assert.equal(row.errorKind, 'invalid-property-access'); assert.equal(row.line, 123); assert.equal(row.column, 9);
  assert.equal(row.script, 'background.js');
  assert.doesNotMatch(JSON.stringify(report), /secret|private\.test/);
});

test('the actual worker records the initialization stage without demanding a new pairing', async () => {
  const log = logger(), event = () => ({ addListener() {} }), chrome = log.context.chrome;
  chrome.alarms = { onAlarm: event(), create: async () => { throw new TypeError('failure'); } };
  chrome.debugger = { onEvent: event(), onDetach: event() };
  chrome.tabs = Object.fromEntries(['onUpdated', 'onReplaced', 'onCreated', 'onRemoved'].map(name => [name, event()]));
  chrome.runtime.onMessage = event();
  Object.assign(log.context, { setTimeout, clearTimeout, setInterval, clearInterval, URL });
  vm.runInContext(fs.readFileSync('extensions/profilepilot/background.js', 'utf8') + '\nglobalThis.readConnectionError = () => connectionError;', log.context, { filename: 'background.js' });
  await new Promise(resolve => setImmediate(resolve));
  const failure = (await log.report()).events.find(row => row.event === 'initialization-failed');
  assert.equal(failure.step, 'alarms'); assert.equal(failure.errorName, 'TypeError');
  assert.match(log.context.readConnectionError(), /配对已保留/);
});

test('extension retention is bounded and never removes pairing data', async () => {
  const log = logger({ connection: { port: 64109, token: 'preserve' } });
  for (let i = 0; i < 205; i++) await log.record('connect-attempt', { port: 64109 });
  assert.equal((await log.report()).events.length, 200);
  assert.equal(Object.keys(log.storage).filter(key => key.startsWith('profilepilotConnectionEvent:')).length, 200);
  assert.equal(log.storage.connection.token, 'preserve');
});

test('readable storage with rejected writes is reported as incomplete and still exports the new event', async () => {
  const log = logger({}, 'popup');
  log.context.chrome.storage.local.set = async () => { throw Error('QUOTA_BYTES quota exceeded'); };
  await log.record('popup-unreachable', { errorKind: 'receiver-missing' });
  const report = await log.report();
  assert.equal(report.storageAvailable, false);
  assert.equal(report.events.at(-1).event, 'popup-unreachable');
});

test('popup exports retained diagnostics without contacting an unavailable worker or leaking pairing', async () => {
  const f = await popupFixture([], { storage: { connection: { port: 64109, token: 'DO-NOT-EXPORT', profileId: 'native:Private' } },
    handlers: { state() { throw Error('Could not establish connection. Receiving end does not exist.'); } } });
  assert.match(f.element('#connection-note').textContent, /导出连接诊断/);
  await f.element('#export-diagnostics').listeners.click();
  const download = f.calls.find(call => call.method === 'downloads.download');
  const report = JSON.parse(decodeURIComponent(download.url.split(',')[1]));
  assert.equal(report.current.workerReadFailure, 'receiver-missing');
  assert.equal(report.current.port, 64109); assert.equal(report.current.paired, true);
  assert.equal(report.events.at(-1).event, 'popup-unreachable');
  assert.doesNotMatch(JSON.stringify(report), /DO-NOT-EXPORT|native:Private/);
  assert.deepEqual(f.calls.map(call => call.method), ['state', 'downloads.download']);
  f.setState({ connected: true }); delete f.handlers.state; await f.poll();
  await f.element('#export-diagnostics').listeners.click();
  const recovered = JSON.parse(decodeURIComponent(f.calls.at(-1).url.split(',')[1]));
  assert.ok(recovered.events.some(row => row.event === 'popup-recovered'));
  assert.ok(recovered.events.some(row => row.event === 'popup-unreachable'));
});

test('a hanging read probe times out, reports evidence and never repeats a mutation', async () => {
  const f = await popupFixture([], { deferInitial: true, handlers: { state: () => new Promise(() => {}) } });
  await f.flush(true); await f.ready;
  await f.element('#export-diagnostics').listeners.click();
  const report = JSON.parse(decodeURIComponent(f.calls.at(-1).url.split(',')[1]));
  assert.equal(report.current.workerReadFailure, 'response-timeout');
  assert.deepEqual(f.calls.map(call => call.method), ['state', 'downloads.download']);
});

function folder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-connection-diagnostics-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function row(event = 'socket-error') {
  return { id: randomUUID(), instance: randomUUID(), at: new Date().toISOString(), source: 'worker', event, port: 64109 };
}
test('service journal deduplicates uploads, survives service restart, scopes Profiles and remains readable offline', async t => {
  const root = folder(t), journal = new ExtensionConnectionJournal(root), event = row();
  journal.record('service-start', { port: 64109 });
  journal.ingest([{ ...event, token: 'SECRET', message: 'SECRET', stack: 'SECRET' }], 'native:first');
  journal.ingest([event], 'native:first'); journal.ingest([row()], 'native:second');
  new ExtensionConnectionJournal(root).record('service-stopping');
  const report = readExtensionConnectionDiagnostics(root, 'native:first');
  assert.equal(report.events.length, 3); assert.equal(report.readError, false);
  assert.doesNotMatch(JSON.stringify(report), /SECRET|native:first|native:second/);
  const doctor = await createBrowserDoctor({ root, profileId: 'native:first' });
  assert.equal(doctor.status, 'error'); assert.equal(doctor.connectionDiagnostics.events.length, 3);
  assert.equal(doctor.connectionDiagnostics.evidence, 'recorded');
});
test('service journal rejects malformed events, bounds history, and disk errors never break caller', t => {
  const root = folder(t), journal = new ExtensionConnectionJournal(root);
  journal.ingest([{ ...row(), event: 'secret' }, { ...row(), source: 'webpage' }, { ...row(), at: 'bad-date' }]);
  assert.equal(readExtensionConnectionDiagnostics(root).events.length, 0);
  for (let i = 0; i < 3; i++) journal.ingest(Array.from({ length: 200 }, () => row()));
  const report = readExtensionConnectionDiagnostics(root);
  assert.equal(JSON.parse(fs.readFileSync(report.path, 'utf8')).events.length, 500);
  assert.equal(report.events.length, 100);
  const blocked = path.join(root, 'file'); fs.writeFileSync(blocked, 'not a directory');
  assert.doesNotThrow(() => new ExtensionConnectionJournal(blocked).record('service-start'));
  assert.equal(readExtensionConnectionDiagnostics(blocked).readError, true);
});
