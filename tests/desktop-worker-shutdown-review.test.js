const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { DesktopWorker } = loadCli('src/main/desktop/worker.ts');
const { DesktopService } = loadCli('src/main/desktop/service.ts');
const { WindowsInputRuntime, closeInputControl } = loadCli('src/main/desktop/input-runtime.ts');
const { ShutdownCoordinator } = loadCli('src/main/shutdown-coordinator.ts');

// Executable bytes below are inert test data. Every spawn is injected and only
// creates EventEmitters; no native entry, GUI, hook or operating-system process
// is started. These assertions reproduce the original premature-clean report
// and verify actual desktop retirement now reaches the App shutdown result.
const turn = () => new Promise(resolve => setImmediate(resolve));
const target = { id: '1'.repeat(32), pid: 12, title: 'Pure fixture', process: 'fixture', className: 'Form' };
const command = method => ({ action: 'desktop', method, session: 'shutdown-review', ...(method === 'claim' ? { windowId: target.id } : {}) });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-worker-shutdown-review-'));
  const executable = path.join(directory, 'inert.exe'), runtimeFiles = new Set(), drivers = [], children = [], trace = [];
  fs.writeFileSync(executable, 'Inert fake child bytes ' + randomUUID());
  const observer = new EventEmitter(); observer.stdin = new PassThrough(); observer.stdout = new PassThrough(); observer.stderr = new PassThrough();
  observer.stdin.on('data', bytes => trace.push('observer:' + bytes.toString().trim())); observer.kill = () => true;
  const message = (...values) => observer.stdout.emit('data', Buffer.from(values.map(value => JSON.stringify(value)).join('\n') + '\n'));
  const runtime = new WindowsInputRuntime({ spawn: () => observer, createEpoch: () => 'shutdown-epoch' });
  const browser = runtime.browserGuard({ onClick() {} });
  const service = new DesktopService({ platform: 'win32', available: () => true, inputObserver: runtime.observeDesktop,
    driver() {
      const driver = new DesktopWorker(executable, file => {
        runtimeFiles.add(file); const child = new EventEmitter();
        child.pid = 1000 + children.length; child.exitCode = null; child.signalCode = null;
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new EventEmitter();
        child.stdin.write = text => {
          const request = JSON.parse(text);
          const result = request.operation === 'windows' ? { windows: [target] } : { version: '2'.repeat(32), windowId: target.id, elements: [], truncated: false };
          queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ id: request.id, ok: true, result }) + '\n')); return true;
        };
        child.stdin.end = text => { assert.equal(JSON.parse(text).operation, 'cancel'); trace.push('cancel:' + child.pid); };
        child.kill = () => { trace.push('kill:' + child.pid); return true; };
        child.exit = () => { if (child.exitCode !== null) return; child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null); };
        children.push(child); return child;
      }); drivers.push(driver); return driver;
    } });
  let coordinator;
  const cleanup = async () => {
    coordinator?.didQuit(); const serviceClosing = service.close();
    children.forEach(child => child.exit()); drivers.forEach(driver => driver.close());
    await serviceClosing.catch(() => {});
    browser.dispose(); const done = runtime.dispose(); observer.emit('close', 0); await done; await turn();
    for (const file of runtimeFiles) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.unlinkSync(executable); fs.rmdirSync(directory);
  };
  t.after(cleanup);
  return { children, trace, service, runtime,
    async start() {
      browser.sync([42]); message({ type: 'status', status: 'ready' }, { type: 'status', status: 'tap-active', pid: 42 }, { type: 'status', status: 'sync-complete', activeCount: 1 });
      const claim = service.execute(command('claim')); await turn();
      message({ type: 'desktop-armed', epoch: 'shutdown-epoch', generation: runtime.snapshot().desktop.generation, sequence: '0' });
      await claim; await service.execute(command('observe')); assert.equal(children.length, 2);
    },
    shutdown() {
      coordinator = new ShutdownCoordinator({ stages: [{ name: 'input-control', run: () => closeInputControl({
        closeDesktop: () => service.close(), closeOverlay: () => browser.dispose(), closeRuntime: () => runtime.dispose()
      }) }], log() {}, requestQuit() {}, forceExit() {} });
      coordinator.beforeQuit({ preventDefault() {} }, 'pure-review'); return coordinator;
    },
    closeObserver() { observer.emit('exit', 0); observer.emit('close', 0); }
  };
}

test('shutdown cannot report clean before the native desktop children confirm exit', async t => {
  const f = fixture(t); await f.start(); const shutdown = f.shutdown(); await turn();
  assert.equal(f.service.status().session, null); assert.equal(f.service.status().available, false);
  assert.equal(f.children.every(child => child.exitCode === null), true);
  f.closeObserver(); await turn();
  t.diagnostic('Actual cleanup state: ' + JSON.stringify({ clean: shutdown.clean, desktopChildrenAlive: f.children.filter(child => child.exitCode === null).length, observerStopped: f.runtime.snapshot().stopConfirmed }));
  assert.equal(shutdown.clean, false, 'observer exit alone cannot confirm DesktopWorker cleanup');
  f.children.forEach(child => child.exit()); await turn();
  assert.equal(shutdown.clean, true, 'confirmed native exits should complete cooperative shutdown');
});

test('live desktop retirement failure must reach the application shutdown result', async t => {
  const f = fixture(t); await f.start(); const shutdown = f.shutdown(); await turn();
  f.children[1].emit('error', Object.assign(new Error('fake live termination denied'), { code: 'EPERM' }));
  f.children[0].exit();
  await assert.rejects(f.service.close(), { code: 'DESKTOP_DRIVER_STOP_UNCONFIRMED' });
  await turn();
  f.closeObserver(); await turn();
  assert.equal(f.children[1].exitCode, null);
  t.diagnostic('Actual cleanup state after live error: ' + JSON.stringify({ clean: shutdown.clean, desktopChildrenAlive: f.children.filter(child => child.exitCode === null).length }));
  assert.equal(shutdown.clean, false, 'a rejected retirement must not be swallowed by application shutdown');
});

test('service shutdown shares one 1500ms retirement budget across its live catalog and owner', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); await f.start(); const shutdown = f.shutdown(); await turn();
  let settled = false; const closing = f.service.close(); closing.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(closing, { code: 'DESKTOP_DRIVER_STOP_UNCONFIRMED' });
  t.mock.timers.tick(749); await turn(); assert.equal(settled, false); assert.equal(f.trace.filter(value => value.startsWith('kill:')).length, 0);
  t.mock.timers.tick(1); await turn(); assert.equal(f.trace.filter(value => value.startsWith('kill:')).length, 2);
  t.mock.timers.tick(749); await turn(); assert.equal(settled, false); assert.equal(shutdown.clean, false);
  t.mock.timers.tick(1); await rejected; await turn(); assert.equal(settled, true);
  assert.equal(f.children.every(child => child.exitCode === null), true);
  f.closeObserver(); await turn(); assert.equal(shutdown.clean, false);
});
