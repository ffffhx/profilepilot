const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { DesktopService } = loadCli('src/main/desktop/service.ts');
const { DesktopInputObserver } = loadCli('src/main/desktop/input-observer.ts');
const { runDesktopCli } = loadCli('src/main/desktop/cli.ts');
const first = { id: 'a'.repeat(32), title: 'Background fixture', process: 'fixture', pid: 42, nativeHandle: '8765', className: 'Form' };
const second = { ...first, id: 'b'.repeat(32), pid: 43, nativeHandle: '8766' };
const version = 'c'.repeat(32);
const command = (method, extra = {}) => ({ action: 'desktop', method, session: 'background-test', ...extra });
function fixture({ oldAck = false, platform = 'win32' } = {}) {
  const calls = [], arms = [];
  let observer, failRead = false;
  const service = new DesktopService({ platform, available: () => true,
    inputObserver(onPause) {
      observer = new DesktopInputObserver({ onPause, send(message) {
        if (!['desktop-arm', 'desktop-rearm'].includes(message.type)) return;
        arms.push(message);
        observer.receive('epoch', { type: 'desktop-armed', epoch: 'epoch', generation: message.generation, sequence: '0',
          ...(!oldAck && message.backgroundTarget ? { backgroundTarget: message.backgroundTarget } : {}) });
      } });
      observer.connect('epoch');
      return { arm: async (generation, marker, target) => { observer.observeDesktop(generation, marker, target); return observer.snapshot().desktop; },
        disarm: generation => observer.stopDesktop(generation), snapshot: () => observer.snapshot(), detach() {} };
    },
    driver: () => ({ inputMarker: '1234', close() {}, async request(operation, params) {
      calls.push({ operation, params });
      if (operation === 'windows') return { windows: [first, second] };
      if (operation === 'control.background') { const target = params.windowId === first.id ? first : second;
        return { mode: 'background', backgroundTarget: { pid: target.pid, window: target.nativeHandle } }; }
      if (operation === 'window.observe' || operation === 'window.screenshot') {
        if (failRead) { failRead = false; throw Object.assign(new Error('read failed'), { code: 'DESKTOP_READ_INTERRUPTED' }); }
        return { windowId: params.windowId, version, elements: [], image: operation === 'window.screenshot' ? { coordinateInputAvailable: true } : null };
      }
      if (operation === 'window.action') return { executed: true, requiresObservation: true };
      throw new Error(operation);
    } }) });
  return { service, calls, arms, observer: () => observer,
    claim: (mode = 'background') => service.execute(command('claim', { windowId: first.id, mode })),
    read: () => service.execute(command('observe')),
    failRead: () => { failRead = true; },
    action: params => service.execute(command('action', { requestId: randomUUID(), params: { version, ref: 'e1', ...params } })) };
}
test('background CLI reaches the service and rejects mode on non-claim commands', async () => {
  let received, output = '';
  const io = { stdout: { write: text => { output += text; } }, stderr: { write() {} } };
  assert.equal(await runDesktopCli(['claim', '--window', first.id, '--session', 's', '--mode', 'background'], async value => { received = value; return { ok: true, data: {} }; }, io), 0);
  assert.equal(received.mode, 'background');
  for (const args of [['claim', '--window', first.id, '--session', 's', '--mode', 'other'], ['resume', '--session', 's', '--mode', 'interactive']]) {
    output = ''; assert.equal(await runDesktopCli(args, async () => { throw new Error('must not dispatch'); }, io), 2);
    assert.equal(JSON.parse(output).code, 'DESKTOP_INVALID_ARGUMENTS');
  }
});
test('background binds native policy and scoped observer; physical and focus commands never dispatch', async () => {
  const f = fixture();
  try {
    assert.equal((await f.claim()).session.mode, 'background');
    assert.deepEqual(f.arms[0].backgroundTarget, { pid: 42, window: '8765' });
    await f.read();
    for (const params of [{ kind: 'click' }, { kind: 'double_click' }, { kind: 'move' }, { kind: 'drag', toX: 1, toY: 2 },
      { kind: 'wheel', deltaY: 120 }, { kind: 'type_text', value: 'x' }, { kind: 'press_key', keys: ['CTRL', 'A'] },
      { kind: 'focus' }, { kind: 'minimize' }, { kind: 'maximize' }, { kind: 'restore' }]) {
      await assert.rejects(f.action(params), { code: 'DESKTOP_BACKGROUND_ACTION_DENIED' });
    }
    assert.equal(f.calls.filter(c => c.operation === 'window.action').length, 0);
    assert.equal((await f.action({ kind: 'set_value', value: 'background value' })).executed, true);
    const shot = await f.service.execute(command('screenshot'));
    assert.equal(shot.image.coordinateInputAvailable, false);
  } finally { await f.service.close(); }
});
test('mode survives recovery, target change and explicit return without allowing downgrade', async () => {
  const f = fixture();
  try {
    await f.claim(); await f.read();
    await assert.rejects(f.claim('interactive'), { code: 'DESKTOP_MODE_CONFLICT' });
    f.failRead(); await assert.rejects(f.read(), { code: 'DESKTOP_READ_INTERRUPTED' });
    await f.read();
    assert.equal(f.calls.filter(c => c.operation === 'control.background').length, 2);
    await f.service.execute(command('select', { windowId: second.id }));
    assert.deepEqual(f.arms.at(-1).backgroundTarget, { pid: 43, window: '8766' });
    f.service.control('takeover');
    await assert.rejects(f.read(), { code: 'DESKTOP_USER_IN_CONTROL' });
    await f.service.resume(); await f.read();
    assert.equal(f.service.status().session.mode, 'background');
    assert.deepEqual(f.arms.at(-1).backgroundTarget, { pid: 43, window: '8766' });
  } finally { await f.service.close(); }
});
test('unscoped acknowledgement cannot authorize background work', async () => {
  const f = fixture({ oldAck: true });
  try {
    await assert.rejects(f.claim());
    assert.equal(f.service.status().session.state, 'paused');
    assert.equal(f.calls.filter(c => c.operation === 'window.action').length, 0);
  } finally { await f.service.close(); }
});
test('target activation pauses background and requires explicit return', async () => {
  const f = fixture();
  try {
    const state = await f.claim();
    f.observer().receive('epoch', { type: 'observer-fault', epoch: 'epoch', generation: state.inputObservation.generation, reason: 'target_active' });
    assert.equal(f.service.status().session.state, 'paused');
    assert.equal(f.service.status().inputObservation.reason, 'target_active');
    await assert.rejects(f.read(), { code: 'DESKTOP_USER_IN_CONTROL' });
  } finally { await f.service.close(); }
});
test('interactive remains the default and macOS never advertises an available native mode', async () => {
  const f = fixture();
  try { assert.equal((await f.service.execute(command('claim', { windowId: first.id }))).session.mode, 'interactive'); assert.equal(f.arms[0].backgroundTarget, undefined); }
  finally { await f.service.close(); }
  const mac = fixture({ platform: 'darwin' });
  try { assert.equal(mac.service.status().supported, false); await assert.rejects(mac.claim(), { code: 'DESKTOP_PLATFORM_UNAVAILABLE' }); }
  finally { await mac.service.close(); }
});
