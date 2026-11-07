const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { waitForDesktopCondition } = loadCli('src/main/desktop/wait.ts');
const { DesktopService } = loadCli('src/main/desktop/service.ts');
const { desktopCommandSchema } = loadCli('src/main/desktop/schema.ts');
const { runDesktopCli } = loadCli('src/main/desktop/cli.ts');
const target = { id: 'a'.repeat(32), title: 'Fixture', process: 'fixture', pid: 1, className: 'Form' };
const version = 'b'.repeat(32);
const element = (patch = {}) => ({ reference: 'e1', name: 'Save', role: 'Button', automationId: 'save', text: '', actions: ['invoke'], password: false, ...patch });
const observation = elements => ({ windowId: target.id, version, truncated: false, image: null, elements });
const command = (method, extra = {}) => ({ action: 'desktop', method, session: 'wait-test', ...extra });
function serviceFixture(request, options = {}) {
  const drivers = [];
  const service = new DesktopService({ platform: 'win32', allowUnobservedTestDriver: true, available: () => true, ...options, driver: () => {
    const driver = { closed: false, close() { driver.closed = true; }, async request(op, params) {
      assert.equal(driver.closed, false);
      if (op === 'windows') return { windows: [target] };
      return request(op, params);
    } };
    drivers.push(driver); return driver;
  } });
  return { service, drivers };
}

test('wait repeats only reads until every exact condition matches', async () => {
  let reads = 0;
  const { result } = await waitForDesktopCondition({ condition: { name: 'Save', role: 'Button', automationId: 'save', hasAction: 'invoke' }, timeoutMs: 500, intervalMs: 1 }, async () => {
    reads++; return observation([element(reads === 1 ? { actions: [] } : {})]);
  }, new AbortController().signal);
  assert.equal(result.matched, true); assert.equal(result.timedOut, false);
  assert.equal(result.attempts, 2); assert.equal(result.requiresObservation, false);
  assert.deepEqual(result.matchedReferences, ['e1']);
  assert.equal(result.observation.version, version);
});

test('timeout retains the last observation as historical evidence and stops a pending read', async () => {
  let reads = 0;
  const observed = observation([element()]);
  const { result, pendingRead } = await waitForDesktopCondition({ condition: { name: 'Finished' }, timeoutMs: 35, intervalMs: 1 }, async () => {
    if (++reads === 1) return observed;
    return new Promise(() => {});
  }, new AbortController().signal);
  assert.equal(result.timedOut, true); assert.equal(result.matched, false); assert.equal(result.requiresObservation, true);
  assert.equal(result.observation, observed); assert.equal(result.attempts, 2); assert.equal(pendingRead, true);
});

test('a delayed event loop cannot accept a matching observation after the deadline', async () => {
  const late = observation([element()]);
  const { result, pendingRead } = await waitForDesktopCondition({ condition: { name: 'Save' }, timeoutMs: 10, intervalMs: 1 }, async () => {
    const end = performance.now() + 35;
    while (performance.now() < end) { /* emulate a blocked callback before timers can run */ }
    return late;
  }, new AbortController().signal);
  assert.equal(result.timedOut, true); assert.equal(result.matched, false);
  assert.equal(result.observation, late); assert.equal(result.requiresObservation, true); assert.equal(pendingRead, false);
});

test('cancellation interrupts a polling delay without dispatching another read', async () => {
  const controller = new AbortController(); let reads = 0;
  const waiting = waitForDesktopCondition({ condition: { text: 'saved' }, timeoutMs: 5000, intervalMs: 2000 }, async () => {
    reads++; setImmediate(() => controller.abort()); return observation([element()]);
  }, controller.signal);
  await assert.rejects(waiting, { code: 'DESKTOP_USER_IN_CONTROL' });
  assert.equal(reads, 1);
});

test('an already cancelled wait dispatches no read', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(waitForDesktopCondition({ condition: { name: 'Saved' }, timeoutMs: 100, intervalMs: 1 }, async () => {
    assert.fail('cancelled wait must not observe');
  }, controller.signal), { code: 'DESKTOP_USER_IN_CONTROL' });
  await new Promise(resolve => setImmediate(resolve));
});

test('password text never satisfies a content predicate and provider failures are not retried', async () => {
  const { result } = await waitForDesktopCondition({ condition: { text: '' }, timeoutMs: 15, intervalMs: 100 }, async () => observation([element({ password: true })]), new AbortController().signal);
  assert.equal(result.matched, false);
  let reads = 0;
  await assert.rejects(waitForDesktopCondition({ condition: { name: 'Save' }, timeoutMs: 100, intervalMs: 1 }, async () => {
    reads++; throw Object.assign(new Error('gone'), { code: 'DESKTOP_WINDOW_CHANGED' });
  }, new AbortController().signal), { code: 'DESKTOP_WINDOW_CHANGED' });
  assert.equal(reads, 1);
});

test('wait schema rejects unbounded, ambiguous or unused fields', () => {
  assert.equal(desktopCommandSchema.safeParse(command('wait', { condition: { name: 'Saved' } })).success, true);
  for (const extra of [{}, { condition: {} }, { condition: { regex: '.*' } }, { condition: { name: 'Saved' }, timeoutMs: 20001 }, { condition: { name: 'Saved' }, intervalMs: 0 }, { condition: { name: 'Saved' }, observeAfter: false }]) {
    assert.equal(desktopCommandSchema.safeParse(command('wait', extra)).success, false);
  }
});

test('TextPattern capability is waitable without adding a text input action', async () => {
  const parsed = desktopCommandSchema.safeParse(command('wait', { condition: { hasAction: 'text' } }));
  assert.equal(parsed.success, true);
  const { result } = await waitForDesktopCondition({ condition: parsed.data.condition, timeoutMs: 100, intervalMs: 10 },
    async () => observation([element({ role: 'Edit', actions: ['set_value', 'text'] })]), new AbortController().signal);
  assert.equal(result.matched, true); assert.deepEqual(result.matchedReferences, ['e1']);
  const calls = [];
  const io = { stdout: { write() {} }, stderr: { write() {} } };
  assert.equal(await runDesktopCli(['wait', '--session', 'task', '--has-action', 'text'], async input => {
    calls.push(input); return { ok: true, data: result };
  }, io), 0);
  assert.deepEqual(calls[0].condition, { hasAction: 'text' });
  assert.equal(desktopCommandSchema.safeParse(command('action', { requestId: '33333333-3333-4333-8333-333333333333',
    params: { version, ref: 'e1', kind: 'text', value: 'never dispatch' } })).success, false);
  assert.equal(desktopCommandSchema.safeParse(command('wait', { condition: { hasAction: 'unknown' } })).success, false);
  for (const hasAction of ['invoke', 'set_value', 'toggle', 'select', 'expand', 'collapse', 'scroll', 'focus', 'click', 'double_click', 'move', 'drag', 'wheel', 'type_text', 'press_key'])
    assert.equal(desktopCommandSchema.safeParse(command('wait', { condition: { hasAction } })).success, true, hasAction);
});

test('service retires a timed-out read and permits fresh reads without automatic user-control changes', async () => {
  let reads = 0;
  const f = serviceFixture(async op => {
    assert.equal(op, 'window.observe');
    if (++reads === 1) return new Promise(() => {});
    return observation([element()]);
  });
  try {
    await f.service.execute(command('claim', { windowId: target.id }));
    const driver = f.drivers[1];
    const result = await f.service.execute(command('wait', { condition: { name: 'Saved' }, timeoutMs: 100 }));
    assert.equal(result.timedOut, true); assert.equal(driver.closed, true);
    assert.equal(f.service.status().session.state, 'active');
    assert.equal(f.drivers.length, 3);
    assert.equal((await f.service.execute(command('observe'))).version, version);
  } finally { f.service.close(); }
});

test('user takeover cancels a stalled wait without creating a replacement driver', async () => {
  let readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  const f = serviceFixture(async () => { readStarted(); return new Promise(() => {}); });
  try {
    await f.service.execute(command('claim', { windowId: target.id }));
    const waiting = f.service.execute(command('wait', { condition: { name: 'Saved' }, timeoutMs: 20000 }));
    await started; f.service.control('takeover');
    await assert.rejects(waiting, { code: 'DESKTOP_USER_IN_CONTROL' });
    assert.equal(f.service.status().session.state, 'paused'); assert.equal(f.drivers.length, 2);
  } finally { f.service.close(); }
});

test('wait CLI sends exact conditions and exposes a timeout with exit 75', async () => {
  let output = ''; const calls = [];
  const io = { stdout: { write(value) { output += value; } }, stderr: { write() {} } };
  const request = async input => { calls.push(input); return { ok: true, data: { matched: false, timedOut: true } }; };
  assert.equal(await runDesktopCli(['wait', '--session', 'task', '--name', '保存完成', '--role', 'Text', '--timeout-ms', '1500'], request, io), 75);
  assert.deepEqual(calls[0].condition, { name: '保存完成', role: 'Text' }); assert.equal(calls[0].timeoutMs, 1500);
  assert.equal(JSON.parse(output).result.timedOut, true);
  for (const args of [['wait', '--session', 'task'], ['wait', '--session', 'task', '--name', 'Saved', '--timeout-ms', '1e3'], ['observe', '--session', 'task', '--name', 'Saved']]) assert.equal(await runDesktopCli(args, request, io), 2);
  assert.equal(calls.length, 1);
});

test('wait never treats unavailable, unsupported, redacted or truncated text as an exact value', async () => {
  const samples = [
    element({ textStatus: 'unavailable' }), element({ textStatus: 'unsupported' }),
    element({ textStatus: 'redacted' }), element({ textStatus: 'truncated' }),
    element({ state: { valueStatus: 'unavailable' }, stateGaps: ['value'] }),
    element({ state: { valueStatus: 'redacted' } }), element(),
    element({ text: 'prefix', textStatus: 'readable', state: { valueStatus: 'readable', valueEvidence: 'unconfirmed' } }),
    element({ text: 'prefix', textStatus: 'readable', stateGaps: ['value_evidence'] }),
    element({ text: 'prefix', textStatus: 'truncated', truncatedFields: ['text'] }),
    element({ text: 'prefix', textStatus: 'readable', truncatedFields: ['text'] })
  ];
  for (const sample of samples) {
    const { result } = await waitForDesktopCondition({ condition: { text: sample.text }, timeoutMs: 10, intervalMs: 50 },
      async () => observation([sample]), new AbortController().signal);
    assert.equal(result.matched, false, JSON.stringify(sample));
  }
});

test('wait uses per-node field completeness and falls back conservatively for older helpers', async () => {
  for (const [field, gap, value] of [['name', 'name_limit', 'prefix'], ['automationId', 'automation_id_limit', 'id'], ['text', 'text_limit', 'prefix']]) {
    const condition = { [field]: value };
    const sample = element({ [field]: value, textStatus: 'readable' });
    for (const exact of [false, true]) {
      const supplied = { ...sample, ...(exact ? { truncatedFields: [field] } : {}) };
      const observed = { ...observation([supplied]), truncated: true, gaps: exact ? [] : [gap] };
      const { result } = await waitForDesktopCondition({ condition, timeoutMs: 10, intervalMs: 50 }, async () => observed, new AbortController().signal);
      assert.equal(result.matched, false, `${field}: ${exact ? 'node gap' : 'legacy global gap'}`);
    }
    const complete = { ...sample, truncatedFields: [] };
    const observed = { ...observation([complete, element({ reference: 'e2', name: 'other', truncatedFields: [field] })]), truncated: true, gaps: [gap, 'children_limit'] };
    const { result } = await waitForDesktopCondition({ condition, timeoutMs: 100, intervalMs: 10 }, async () => observed, new AbortController().signal);
    assert.equal(result.matched, true, 'an unrelated node/global gap cannot erase positive complete evidence');
    assert.ok(result.matchedReferences.includes('e1'));
  }
});

test('wait accepts proven empty text and partial-tree positive matches without exposing password names', async () => {
  for (const sample of [element({ textStatus: 'readable', truncatedFields: [] }), element({ state: { valueStatus: 'readable' } }),
    element({ textStatus: 'readable', textSource: 'text_pattern', state: { valueStatus: 'unsupported', valueEvidence: 'unconfirmed' } }),
    element({ textStatus: 'readable', textSource: 'text_pattern', state: { valueStatus: 'readable', valueEvidence: 'value_and_text' } })]) {
    const { result } = await waitForDesktopCondition({ condition: { text: '' }, timeoutMs: 100, intervalMs: 10 },
      async () => ({ ...observation([sample]), truncated: true, gaps: ['children_limit'] }), new AbortController().signal);
    assert.equal(result.matched, true);
  }
  const password = element({ password: true, name: '', text: '', textStatus: 'redacted', truncatedFields: [] });
  const hidden = await waitForDesktopCondition({ condition: { name: '' }, timeoutMs: 10, intervalMs: 50 },
    async () => observation([password]), new AbortController().signal);
  assert.equal(hidden.result.matched, false);
  const identified = await waitForDesktopCondition({ condition: { role: 'Button', automationId: 'save' }, timeoutMs: 100, intervalMs: 10 },
    async () => observation([password]), new AbortController().signal);
  assert.equal(identified.result.matched, true, 'non-redacted identity remains usable');
});

test('every timeout requires a fresh observation even when the last read finished before the interval deadline', async () => {
  let inputs = 0, reads = 0;
  const f = serviceFixture(async op => {
    if (op === 'window.observe') { reads++; return observation([element()]); }
    assert.equal(op, 'window.action'); inputs++; return { executed: true };
  });
  try {
    await f.service.execute(command('claim', { windowId: target.id }));
    const result = await f.service.execute(command('wait', { condition: { name: 'Finished' }, timeoutMs: 100, intervalMs: 2000 }));
    assert.equal(result.timedOut, true); assert.equal(result.requiresObservation, true); assert.equal(reads, 1);
    await assert.rejects(f.service.execute(command('action', { requestId: '11111111-1111-4111-8111-111111111111',
      params: { kind: 'invoke', ref: 'e1', version: result.observation.version } })), { code: 'DESKTOP_FRESH_OBSERVATION_REQUIRED' });
    assert.equal(inputs, 0);
    const fresh = await f.service.execute(command('observe'));
    await f.service.execute(command('action', { requestId: '22222222-2222-4222-8222-222222222222',
      params: { kind: 'invoke', ref: 'e1', version: fresh.version } }));
    assert.equal(inputs, 1);
  } finally { await f.service.close(); }
});

test('late read completion after takeover cannot revive a wait or dispatch another read', async () => {
  let finishRead, startedRead, reads = 0;
  const started = new Promise(resolve => { startedRead = resolve; });
  const f = serviceFixture(async op => {
    assert.equal(op, 'window.observe'); reads++; startedRead();
    return new Promise(resolve => { finishRead = resolve; });
  });
  try {
    await f.service.execute(command('claim', { windowId: target.id }));
    const waiting = f.service.execute(command('wait', { condition: { name: 'Save' }, timeoutMs: 20000 }));
    await started; f.service.control('takeover');
    await assert.rejects(waiting, { code: 'DESKTOP_USER_IN_CONTROL' });
    finishRead(observation([element()])); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.service.status().session.state, 'paused'); assert.equal(reads, 1); assert.equal(f.drivers.length, 2);
  } finally { await f.service.close(); }
});

test('a late rejection after the deadline is handled without retrying an observation', async () => {
  let rejectRead, reads = 0;
  const { result, pendingRead } = await waitForDesktopCondition({ condition: { name: 'Save' }, timeoutMs: 10, intervalMs: 1 },
    () => { reads++; return new Promise((_resolve, reject) => { rejectRead = reject; }); }, new AbortController().signal);
  assert.equal(result.timedOut, true); assert.equal(pendingRead, true);
  rejectRead(Object.assign(new Error('retired'), { code: 'DESKTOP_READ_INTERRUPTED' }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 1);
});

test('wait CLI accepts an explicitly empty text predicate without accepting other missing values', async () => {
  const calls = [];
  const request = async command => { calls.push(command); return { ok: true, data: { matched: true, timedOut: false } }; };
  const io = { stdout: { write() {} }, stderr: { write() {} } };
  assert.equal(await runDesktopCli(['wait', '--session', 'task', '--text', ''], request, io), 0);
  assert.deepEqual(calls[0].condition, { text: '' });
  for (const args of [['wait', '--session', 'task', '--text'], ['wait', '--session', '', '--text', ''],
    ['wait', '--session', 'task', '--name', ''], ['wait', '--session', 'task', '--role', '']])
    assert.equal(await runDesktopCli(args, request, io), 2);
  assert.equal(calls.length, 1);
});

test('late admission after a deadline cannot dispatch an old read or change the recovered owner', async () => {
  for (const lateStatus of ['available', 'occupied', 'unknown']) {
    let finishAdmission, admissions = 0, reads = 0;
    const f = serviceFixture(async op => {
      assert.equal(op, 'window.observe'); reads++; return observation([element()]);
    }, { admission: async () => {
      if (++admissions === 2) return new Promise(resolve => { finishAdmission = resolve; });
      return { status: 'available', reasons: [] };
    } });
    try {
      await f.service.execute(command('claim', { windowId: target.id }));
      const waiting = await f.service.execute(command('wait', { condition: { name: 'Save' }, timeoutMs: 100 }));
      assert.equal(waiting.timedOut, true); assert.equal(waiting.attempts, 1); assert.equal(reads, 0);
      assert.equal(f.drivers[1].closed, true);
      const fresh = await f.service.execute(command('observe'));
      assert.equal(fresh.version, version); assert.equal(reads, 1);
      finishAdmission({ status: lateStatus, reasons: [] });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reads, 1, 'late admission cannot dispatch into the retired helper');
      assert.equal(f.service.status().session.state, 'active', 'late negative admission cannot pause a newer generation');
      assert.equal(f.drivers.length, 3);
    } finally { await f.service.close(); }
  }
});
