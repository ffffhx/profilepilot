const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsModule } = require('./helpers/load-ts-module');
const { ShutdownCoordinator } = loadTsModule('src/main/shutdown-coordinator.ts');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(stages, options = {}) {
  const logs = [], calls = [];
  const coordinator = new ShutdownCoordinator({ stages, cleanupTimeoutMs: 1000, quitTimeoutMs: 1000,
    log: (level, event, message, details) => logs.push({ level, event, message, details }),
    requestQuit: () => calls.push('quit'), forceExit: () => calls.push('forced'), ...options });
  const request = () => { let prevented = false; coordinator.beforeQuit({ preventDefault() { prevented = true; } }, 'main-window-close'); return prevented; };
  return { coordinator, logs, calls, request };
}

test('repeated quit waits for every cleanup, then allows a separately scheduled second quit', async t => {
  const tasks = deferred(), overlay = deferred(), management = deferred();
  const f = fixture([
    { name: 'tasks-save-and-handoff', run: () => tasks.promise },
    { name: 'agent-overlay', run: () => overlay.promise },
    { name: 'management-server', run: () => management.promise }
  ]);
  t.after(() => f.coordinator.didQuit());
  assert.equal(f.request(), true);
  assert.equal(f.request(), true, 'another quit must not bypass unfinished task cleanup');
  tasks.resolve(); management.resolve(); await flush();
  assert.deepEqual(f.calls, []);
  assert.equal(f.coordinator.clean, false);
  overlay.resolve(); await flush(); await flush();
  assert.deepEqual(f.calls, ['quit']);
  assert.equal(f.request(), false);
  assert.equal(f.coordinator.clean, true);
  assert.equal(f.logs.filter(log => log.event === 'app.quit_requested').length, 1);
  assert.equal(f.logs.filter(log => log.event === 'app.shutdown.stage.begin').length, 3);
  assert.equal(f.logs.filter(log => log.event === 'app.shutdown.stage.done').length, 3);
  assert.ok(f.logs.find(log => log.event === 'app.shutdown.quit_again'));
});

test('synchronous and asynchronous cleanup errors are recorded without skipping other stages', async t => {
  const tasks = deferred();
  const f = fixture([
    { name: 'tasks', run: () => tasks.promise },
    { name: 'overlay', run: () => { throw Error('overlay failure'); } },
    { name: 'management', run: async () => { throw Error('socket failure'); } }
  ]);
  t.after(() => f.coordinator.didQuit());
  f.request(); await flush();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.logs.filter(log => log.event === 'app.shutdown.stage.error').map(log => log.details.stage).sort(), ['management', 'overlay']);
  tasks.resolve(); await flush(); await flush();
  assert.deepEqual(f.calls, ['quit']);
  assert.equal(f.coordinator.clean, false, 'errors must not mark runtime-state clean');
});

test('a stuck cleanup logs its exact pending stage and forces exit; late rejection is consumed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tasks = deferred();
  const f = fixture([{ name: 'tasks-save-and-handoff', run: () => tasks.promise }, { name: 'management-server', run: () => {} }], { cleanupTimeoutMs: 20 });
  f.request(); await flush();
  t.mock.timers.tick(19);
  assert.deepEqual(f.calls, []);
  t.mock.timers.tick(1);
  assert.deepEqual(f.calls, ['forced']);
  assert.equal(f.coordinator.clean, false);
  assert.deepEqual(f.logs.filter(log => log.event === 'app.shutdown.stage.timeout').map(log => log.details.stage), ['tasks-save-and-handoff']);
  const forced = f.logs.find(log => log.event === 'app.shutdown.forced_exit');
  assert.equal(forced.details.reason, 'cleanup');
  assert.equal(forced.details.stages['management-server'], 'done');
  tasks.reject(Error('late cleanup error')); await flush();
  assert.deepEqual(f.calls, ['forced']);
});

test('finished cleanup cannot leave a headless process indefinitely if Electron quit is prevented', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture([{ name: 'tasks', run: () => {} }], { quitTimeoutMs: 20 });
  f.request(); await flush(); await flush();
  f.coordinator.willQuit();
  t.mock.timers.tick(19);
  assert.deepEqual(f.calls, ['quit']);
  t.mock.timers.tick(1);
  assert.deepEqual(f.calls, ['quit', 'forced']);
  assert.equal(f.logs.find(log => log.event === 'app.shutdown.forced_exit').details.reason, 'electron-quit');
  assert.equal(f.coordinator.clean, false);
});

test('only actual quit cancels the final watchdog', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture([{ name: 'tasks', run: () => {} }], { quitTimeoutMs: 20 });
  f.request(); await flush(); await flush();
  f.coordinator.willQuit(); f.coordinator.didQuit();
  t.mock.timers.tick(50);
  assert.deepEqual(f.calls, ['quit']);
  assert.equal(f.coordinator.clean, true);
});

test('an exception from the second quit attempt is recorded and cannot escape the shutdown bound', async () => {
  const f = fixture([], { requestQuit: () => { throw Error('Electron quit failed'); } });
  f.request(); await flush(); await flush();
  assert.deepEqual(f.calls, ['forced']);
  assert.ok(f.logs.find(log => log.event === 'app.shutdown.quit_error'));
  assert.equal(f.logs.find(log => log.event === 'app.shutdown.forced_exit').details.reason, 'electron-quit-error');
});
