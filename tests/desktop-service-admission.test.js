const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { DesktopService } = loadCli('src/main/desktop/service.ts');
const target = { id: 'a'.repeat(32), title: 'Fixture', process: 'fixture', pid: 10, className: 'Form' };
const other = { ...target, id: 'c'.repeat(32), pid: 20 };
const version = 'b'.repeat(32);
const command = (method, extra = {}) => ({ action: 'desktop', method, session: 'task', ...extra });
const claim = service => service.execute(command('claim', { windowId: target.id }));
const action = () => command('action', { requestId: randomUUID(), params: { version, ref: 'e1', kind: 'invoke' } });
const decision = status => ({ status, reason: 'fixture', matches: [], gaps: [] });
function fixture() {
  let admit = async () => decision('unmanaged');
  const calls = [];
  const checked = [];
  const service = new DesktopService({ platform: 'win32', allowUnobservedTestDriver: true, available: () => true,
    admission: async window => { checked.push(window.pid); return admit(window); },
    driver: () => ({ close() {}, async request(op) {
      calls.push(op);
      if (op === 'windows') return { windows: [target, other] };
      if (op === 'window.action') return { executed: true };
      return { windowId: target.id, version, elements: [], image: null };
    } })
  });
  return { service, calls, checked, setAdmission(fn) { admit = fn; } };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('occupied or unknown cross-entry ownership cannot claim a desktop session', async () => {
  for (const status of ['occupied', 'unknown']) {
    const f = fixture();
    try {
      f.setAdmission(async () => decision(status));
      await assert.rejects(claim(f.service), { code: status === 'occupied' ? 'DESKTOP_CONTROL_OCCUPIED' : 'DESKTOP_CONTROL_STATE_UNKNOWN' });
      assert.equal(f.service.status().session, null);
      assert.deepEqual(f.calls, ['windows']);
    } finally { f.service.close(); }
  }
});

test('user stop or service close while admission waits cannot be undone by a late success', async () => {
  for (const close of [false, true]) {
    const f = fixture(); let resolve;
    try {
      f.setAdmission(() => new Promise(done => { resolve = done; }));
      const pending = claim(f.service); await turn();
      if (close) f.service.close(); else f.service.control('stop');
      resolve(decision('available'));
      await assert.rejects(pending, { code: close ? 'DESKTOP_SERVICE_UNAVAILABLE' : 'DESKTOP_USER_IN_CONTROL' });
      assert.equal(f.service.status().session, null);
    } finally { f.service.close(); }
  }
});

test('semantic action admission denial pauses ownership and keeps a non-replayed receipt', async () => {
  const f = fixture();
  try {
    await claim(f.service); f.setAdmission(async () => decision('occupied'));
    const input = action();
    await assert.rejects(f.service.execute(input), { code: 'DESKTOP_CONTROL_OCCUPIED' });
    assert.equal(f.service.status().session.state, 'paused');
    assert.equal(f.calls.includes('window.action'), false);
    const checked = f.checked.length;
    await assert.rejects(f.service.execute(input), { code: 'DESKTOP_CONTROL_OCCUPIED' });
    assert.equal(f.checked.length, checked);
    const receipt = await f.service.execute(command('receipt', { requestId: input.requestId }));
    assert.equal(receipt.state, 'failed'); assert.equal(receipt.error.code, 'DESKTOP_CONTROL_OCCUPIED');
  } finally { f.service.close(); }
});

test('all action kinds use admission before dispatch, including focus and UIA edits', async () => {
  for (const params of [
    { kind: 'focus', ref: 'e1' }, { kind: 'set_value', ref: 'e1', value: 'new' },
    { kind: 'press_key', keys: ['A'] }, { kind: 'click', x: 1, y: 1 }
  ]) {
    const f = fixture();
    try {
      await claim(f.service); f.setAdmission(async () => decision('occupied'));
      await assert.rejects(f.service.execute(command('action', { requestId: randomUUID(), params: { ...params, version } })), { code: 'DESKTOP_CONTROL_OCCUPIED' });
      assert.equal(f.calls.includes('window.action'), false);
    } finally { f.service.close(); }
  }
});

test('takeover during pre-action admission prevents dispatch even if ownership snapshot succeeds', async () => {
  const f = fixture(); let resolve;
  try {
    await claim(f.service); f.setAdmission(() => new Promise(done => { resolve = done; }));
    const pending = f.service.execute(action()); await turn();
    f.service.control('takeover'); resolve(decision('available'));
    await assert.rejects(pending, { code: 'DESKTOP_USER_IN_CONTROL' });
    assert.equal(f.calls.includes('window.action'), false);
    assert.equal(f.service.status().session.state, 'paused');
  } finally { f.service.close(); }
});

test('select verifies the new target and retains the prior window when it is occupied', async () => {
  const f = fixture();
  try {
    await claim(f.service); f.setAdmission(async window => decision(window.pid === other.pid ? 'occupied' : 'available'));
    await assert.rejects(f.service.execute(command('select', { windowId: other.id })), { code: 'DESKTOP_CONTROL_OCCUPIED' });
    assert.equal(f.service.status().session.window.id, target.id);
    assert.equal(f.service.status().session.state, 'paused');
    assert.deepEqual(f.checked, [target.pid, other.pid]);
  } finally { f.service.close(); }
});

test('resume remains paused on denial and cannot override a new user stop while checking', async () => {
  const f = fixture(); let resolve;
  try {
    await claim(f.service); f.service.control('takeover');
    f.setAdmission(async () => decision('occupied'));
    await assert.rejects(f.service.execute(command('resume')), { code: 'DESKTOP_CONTROL_OCCUPIED' });
    assert.equal(f.service.status().session.state, 'paused');
    f.setAdmission(() => new Promise(done => { resolve = done; }));
    const pending = f.service.resume(); await turn();
    f.service.control('stop'); resolve(decision('available'));
    await assert.rejects(pending, { code: 'DESKTOP_USER_IN_CONTROL' });
    assert.equal(f.service.status().session, null);
  } finally { f.service.close(); }
});

test('a throwing admission provider fails closed before observation and pauses the session', async () => {
  const f = fixture();
  try {
    await claim(f.service); f.setAdmission(async () => { throw new Error('transport failure'); });
    await assert.rejects(f.service.execute(command('observe')), { code: 'DESKTOP_CONTROL_STATE_UNKNOWN' });
    assert.deepEqual(f.calls, ['windows']);
    assert.equal(f.service.status().session.state, 'paused');
  } finally { f.service.close(); }
});

test('resume cannot interleave a transition while an action waits for admission', async () => {
  const f = fixture(); let resolve;
  try {
    await claim(f.service); f.setAdmission(() => new Promise(done => { resolve = done; }));
    const pending = f.service.execute(action()); await turn();
    const checks = f.checked.length;
    await assert.rejects(f.service.execute(command('resume')), { code: 'DESKTOP_BUSY' });
    assert.equal(f.checked.length, checks);
    resolve(decision('available'));
    assert.equal((await pending).executed, true);
    assert.equal(f.calls.filter(op => op === 'window.action').length, 1);
  } finally { f.service.close(); }
});

test('post-action admission change keeps executed success and reports the observation failure', async () => {
  const f = fixture(); let checks = 0;
  try {
    await claim(f.service); f.setAdmission(async () => decision(++checks === 1 ? 'available' : 'occupied'));
    const input = { ...action(), observeAfter: true };
    const result = await f.service.execute(input);
    assert.equal(result.executed, true); assert.equal(result.requiresObservation, true);
    assert.equal(result.observationError.code, 'DESKTOP_CONTROL_OCCUPIED');
    assert.equal(f.service.status().session.state, 'paused');
    assert.equal((await f.service.execute(input)).executed, true);
    assert.equal(f.calls.filter(op => op === 'window.action').length, 1);
  } finally { f.service.close(); }
});

test('target doctor reports cross-entry occupancy without acquiring or pausing a session', async () => {
  const f = fixture();
  try {
    f.setAdmission(async () => decision('occupied'));
    const unowned = await f.service.execute({ action: 'desktop', method: 'doctor', windowId: target.id });
    assert.equal(unowned.admission.status, 'occupied'); assert.equal(unowned.status.session, null);
    f.setAdmission(async () => decision('available')); await claim(f.service);
    const expiry = f.service.status().session.expiresAt;
    f.setAdmission(async () => decision('occupied'));
    const owned = await f.service.execute({ action: 'desktop', method: 'doctor', windowId: target.id });
    assert.equal(owned.admission.status, 'occupied');
    assert.equal(owned.status.session.state, 'active'); assert.equal(owned.status.session.expiresAt, expiry);
    assert.equal(f.calls.includes('window.action'), false);
  } finally { f.service.close(); }
});

test('target doctor keeps provider faults explicit and never forwards their raw messages', async () => {
  const f = fixture();
  try {
    f.setAdmission(async () => { throw new Error('sensitive provider transport detail'); });
    const result = await f.service.execute({ action: 'desktop', method: 'doctor', windowId: target.id });
    assert.equal(result.admission.status, 'unknown');
    assert.deepEqual(result.admission.gaps, ['admission:provider_failed']);
    assert.equal(JSON.stringify(result).includes('sensitive'), false);
    assert.equal(f.service.status().session, null);
  } finally { f.service.close(); }
});
