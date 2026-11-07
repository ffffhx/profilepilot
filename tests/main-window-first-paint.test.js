const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { loadCli } = require('./cli-test-build.cjs');
const { mainWindowInitialVisibility, waitForMainWindowFirstPaint } = loadCli('src/main/main-window-first-paint.ts');

function fixture() {
  const window = new EventEmitter();
  const state = { destroyed: false, minimized: false, visible: false, current: true, quitting: false };
  const settled = [];
  let elapsed = 0, shows = 0, timer, timerCleared = false;
  window.isDestroyed = () => state.destroyed;
  window.isMinimized = () => { assert.equal(state.destroyed, false); return state.minimized; };
  window.isVisible = () => { assert.equal(state.destroyed, false); return state.visible; };
  window.show = () => { shows++; state.visible = true; window.emit('show'); };
  const controller = waitForMainWindowFirstPaint({ window,
    isCurrent: () => state.current, isQuitting: () => state.quitting,
    onSettled: result => settled.push(result), now: () => elapsed,
    schedule: (callback, delay) => {
      assert.equal(delay, 5000); timer = () => { elapsed = delay; callback(); };
      return () => { timerCleared = true; };
    }
  });
  // Retain callbacks to simulate callbacks already queued before removal.
  const lateReady = window.listeners('ready-to-show')[0];
  return { window, state, settled, controller, lateReady, timeout: () => timer(),
    shows: () => shows, timerCleared: () => timerCleared };
}

test('Windows visible startup waits; macOS, Linux, background and smoke visibility keep their original conditions', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const background of [false, true]) for (const backgroundE2e of [false, true]) {
      for (const smokeTest of [false, true]) for (const driverTest of [false, true]) {
        const visible = !background && !backgroundE2e && (!smokeTest || driverTest);
        assert.deepEqual(mainWindowInitialVisibility({ platform, background, backgroundE2e, smokeTest, driverTest }),
          { show: visible && platform !== 'win32', waitForFirstPaint: visible && platform === 'win32' });
      }
    }
  }
});

test('ready shows once and removes the timer and every listener before the show event', () => {
  const f = fixture();
  f.window.emit('ready-to-show'); f.lateReady(); f.timeout();
  assert.equal(f.shows(), 1); assert.equal(f.timerCleared(), true);
  assert.deepEqual(f.window.eventNames(), []);
  assert.equal(f.settled.length, 1);
  assert.equal(f.settled[0].trigger, 'ready-to-show');
  assert.equal(f.settled[0].showRequested, true); assert.equal(f.settled[0].visible, true);
});

test('timeout follows the original visible intent once and does not claim readiness', () => {
  const f = fixture();
  f.timeout(); f.lateReady(); f.timeout();
  assert.equal(f.shows(), 1); assert.equal(f.settled.length, 1);
  assert.equal(f.settled[0].trigger, 'timeout'); assert.equal(f.settled[0].elapsedMs, 5000);
  assert.equal(f.settled[0].showRequested, true);
});

for (const event of ['show', 'hide', 'minimize', 'close', 'closed']) {
  test(`${event} cancels both late ready and timeout without showing again`, () => {
    const f = fixture();
    if (event === 'show') f.state.visible = true;
    if (event === 'minimize') f.state.minimized = true;
    if (event === 'closed') f.state.destroyed = true;
    f.window.emit(event); f.lateReady(); f.timeout();
    assert.equal(f.shows(), 0); assert.equal(f.timerCleared(), true);
    assert.deepEqual(f.window.eventNames(), []);
    assert.equal(f.settled.length, 1); assert.equal(f.settled[0].cancellation, event);
  });
}

for (const reason of ['explicit-show', 'mini-request', 'quit', 'window-replaced']) {
  test(`${reason} revokes the pending show before asynchronous work starts`, () => {
    const f = fixture();
    f.controller.cancel(reason); f.lateReady(); f.timeout();
    assert.equal(f.shows(), 0); assert.equal(f.settled.length, 1);
    assert.equal(f.settled[0].cancellation, reason);
  });
}

test('callbacks recheck current owner, quitting, destruction, visibility and minimization', () => {
  for (const state of [{ current: false }, { quitting: true }, { destroyed: true }, { visible: true }, { minimized: true }]) {
    for (const trigger of ['lateReady', 'timeout']) {
      const f = fixture(); Object.assign(f.state, state); f[trigger]();
      assert.equal(f.shows(), 0, JSON.stringify({ state, trigger }));
      assert.equal(f.settled[0].showRequested, false);
      assert.equal(f.timerCleared(), true);
    }
  }
});

test('late events from a replaced window cannot settle or show its successor', () => {
  const old = fixture(), replacement = fixture();
  old.state.current = false;
  old.lateReady(); old.window.emit('closed'); old.timeout();
  assert.equal(old.shows(), 0); assert.equal(replacement.shows(), 0);
  assert.equal(replacement.settled.length, 0);
  replacement.lateReady();
  assert.equal(replacement.shows(), 1);
});
