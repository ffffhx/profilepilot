const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { DesktopService } = loadCli('src/main/desktop/service.ts');

// Fake driver retirement and observer callbacks only; no process or hook.
const target = { id: '1'.repeat(32), title: 'Pure fixture', pid: 12, process: 'fixture', className: 'Form' };
const command = (method, extra = {}) => ({ action: 'desktop', method, session: 'shutdown', ...extra });
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(options = {}) {
  const drivers = [], arms = [], changes = []; let service, desktop = null, detached = 0;
  service = new DesktopService({ platform: 'win32', available: () => true,
    onChanged(status) { changes.push(status); options.changed?.(status, service); },
    driver() {
      const stop = deferred(); let closePromise;
      const driver = { index: drivers.length, inputMarker: (drivers.length + 1).toString(16).padStart(16, '0'), started: false, stopped: false,
        stopConfirmed: false, closes: 0,
        close() { if (closePromise) return closePromise; this.closes++; this.stopped = true; closePromise = stop.promise;
          if (!this.started) { this.stopConfirmed = true; stop.resolve(); } return closePromise; },
        confirm() { this.stopConfirmed = true; stop.resolve(); }, fail(error) { stop.reject(error); },
        async request(operation) {
          assert.equal(this.stopped, false); this.started = true;
          if (options.request) { const value = options.request(operation, this); if (value !== undefined) return value; }
          if (operation === 'windows') return { windows: [target] };
          return { windowId: target.id, version: '2'.repeat(32), elements: [], truncated: false };
        } };
      drivers.push(driver); return driver;
    }, inputObserver(onPause) { return {
      async arm(generation, marker) { arms.push({ generation, marker }); desktop = { epoch: 'e1', generation, phase: 'ready', sequence: '0' }; return { ...desktop }; },
      disarm(generation) { if (desktop?.generation === generation) desktop = null; },
      snapshot() { return { connected: true, epoch: 'e1', desktop: desktop && { ...desktop } }; }, detach() { detached++; desktop = null; }
    }; }
  });
  return { service, drivers, arms, changes, get detached() { return detached; },
    claim: () => service.execute(command('claim', { windowId: target.id })), read: () => service.execute(command('observe')),
    async cleanup() { const closing = service.close(); drivers.forEach(driver => driver.confirm()); await closing.catch(() => {}); }
  };
}

test('replacement ARM waits for an old failed catalog and explicit resume waits for the retired owner', async () => {
  const f = fixture({ request(operation, driver) { if (operation === 'windows' && driver.index === 0) throw new Error('catalog read failed'); } });
  try {
    await assert.rejects(f.service.windows()); assert.equal(f.drivers[0].stopped, true);
    const claiming = f.claim(); await turn();
    assert.equal(f.arms.length, 0); assert.equal(f.service.status().session.state, 'paused');
    assert.equal(f.service.status().inputObservation.phase, 'arming');
    f.drivers[0].confirm(); await claiming; await f.read();
    f.service.control('takeover'); assert.equal(f.drivers[2].stopped, true);
    const resuming = f.service.resume(); await turn();
    assert.equal(f.arms.length, 1); assert.equal(f.service.status().session.state, 'paused');
    f.drivers[2].confirm(); await resuming; assert.equal(f.arms.length, 2);
  } finally { await f.cleanup(); }
});

test('shutdown waits for every retired catalog and owner even after both current references were replaced', async () => {
  let failCatalog = false;
  const f = fixture({ request(operation, driver) { if (failCatalog && operation === 'windows' && driver.index === 0) throw new Error('catalog failed later'); } });
  try {
    await f.claim(); await f.read();
    failCatalog = true; await assert.rejects(f.service.windows());
    f.service.control('takeover'); const closing = f.service.close();
    assert.equal(f.service.close(), closing); assert.equal(f.service.status().session, null); assert.equal(f.service.status().available, false);
    let settled = false; closing.then(() => { settled = true; });
    await turn(); assert.equal(settled, false); assert.equal(f.detached, 0);
    f.drivers[1].confirm(); await turn(); assert.equal(settled, false, 'retired catalog remains live');
    f.drivers[0].confirm(); await closing; assert.equal(settled, true); assert.equal(f.detached, 1);
    assert.equal(f.drivers.every(driver => driver.closes === 1), true);
  } finally { await f.cleanup(); }
});

test('a failed retirement blocks ARM until late exit, then explicit resume succeeds while shutdown reports the historic failure', async () => {
  const f = fixture();
  try {
    await f.claim(); await f.read(); f.service.control('takeover');
    f.drivers[1].fail(undefined); // An undefined rejection is still a failure.
    await assert.rejects(f.service.resume(), { code: 'DESKTOP_DRIVER_STOP_UNCONFIRMED' });
    assert.equal(f.arms.length, 1); assert.equal(f.service.status().session.state, 'paused');
    f.drivers[1].confirm(); await f.service.resume(); assert.equal(f.arms.length, 2);
    const closing = f.service.close(); f.drivers[0].confirm();
    await assert.rejects(closing, error => { assert.equal(error.code, 'DESKTOP_DRIVER_STOP_UNCONFIRMED'); assert.equal(error.details.failureCount, 1); return true; });
    assert.equal(f.detached, 1);
  } finally { await f.cleanup(); }
});

for (const control of ['takeover', 'stop', 'close']) test('waiting for old retirement cannot undo ' + control, async () => {
  const f = fixture();
  try {
    await f.claim(); await f.read(); f.service.control('takeover');
    const resuming = f.service.resume(); await turn();
    const rejectResume = assert.rejects(resuming, { code: 'DESKTOP_USER_IN_CONTROL' });
    if (control === 'close') f.service.close(); else f.service.control(control);
    f.drivers.forEach(driver => driver.confirm()); await rejectResume;
    assert.equal(f.arms.length, 1); assert.equal(f.service.status().session?.state === 'active', false);
  } finally { await f.cleanup(); }
});

test('reentrant and throwing close notifications cannot skip catalog cleanup or create a second close promise', async () => {
  let nested, entered = false;
  const f = fixture({ changed(status, service) { if (!status.available && !entered) { entered = true; nested = service.close(); throw new Error('notification failed'); } } });
  try {
    await f.claim(); await f.read(); const closing = f.service.close();
    assert.equal(nested, closing); assert.equal(f.drivers.every(driver => driver.stopped), true);
    f.drivers.forEach(driver => driver.confirm());
    await assert.rejects(closing, { code: 'DESKTOP_DRIVER_STOP_UNCONFIRMED' }); assert.equal(f.detached, 1);
    assert.equal(f.drivers.every(driver => driver.closes === 1), true);
  } finally { await f.cleanup(); }
});

test('repeated read-only catalog failures release confirmed references while retaining bounded failure evidence', async () => {
  const f = fixture({ request(operation) { if (operation === 'windows') throw new Error('fake catalog failure'); } });
  try {
    for (let index = 0; index < 40; index++) {
      await assert.rejects(f.service.windows());
      f.drivers[index].fail(new Error('fake stop failure')); await turn(); f.drivers[index].confirm();
    }
    assert.equal(f.service.stopFailureCount, 40); assert.equal(f.service.stopFailures.length, 32);
    // Another catalog read/retirement should prune obsolete process references
    // without requiring a control session or discarding the bounded history.
    await assert.rejects(f.service.windows());
    assert.equal([...f.service.retiringDrivers].filter(entry => entry.driver.stopConfirmed).length, 0);
    const closing = f.service.close(); f.drivers.forEach(driver => driver.confirm());
    await assert.rejects(closing, error => {
      assert.equal(error.code, 'DESKTOP_DRIVER_STOP_UNCONFIRMED');
      assert.equal(error.details.failureCount, 40); assert.equal(error.details.failures.length, 32); return true;
    });
    assert.equal(f.service.retiringDrivers.size, 0);
  } finally { await f.cleanup(); }
});
