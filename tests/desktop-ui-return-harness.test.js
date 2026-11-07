const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadCli } = require('./cli-test-build.cjs');
const policy = loadCli('scripts/e2e/desktop-ui-return-main.ts');
const nonce = 'a'.repeat(32), documentNonce = 'a1234567-1234-4123-8123-123456789012';
const identity = { session: 'A', generation: 'desktop-first', revision: 1 };
const envelope = (action, extra = {}) => ({ action, nonce, id: documentNonce, expiresAt: 2000, ...extra });
const request = (operation = 'snapshot', extra = {}) => envelope('toolbar', { operation, expected: { ...identity }, webContentsId: 7, documentNonce, slot: null, ...extra });
function facts() {
  return { browserFactoryCalls: 0, target: { pid: 20, hwnd: '30' }, runtime: { browserPids: [], desktop: null, stopConfirmed: true },
    status: { session: { name: 'A', state: 'paused', revision: 1, window: { pid: 20, nativeHandle: '30' } },
      inputObservation: { generation: identity.generation, epoch: 'epoch', phase: 'paused', reason: 'user_takeover' } },
    toolbar: { exactOwnedFile: true, visible: true, destroyed: false, webContentsId: 7, documentNonce },
    spawnCount: 1, observers: [{ exited: true, closed: true }], drivers: [{ roles: ['catalog'], stopConfirmed: false }, { roles: ['owner'], stopConfirmed: true }] };
}
function renderer() {
  const calls = [], nodes = new Map(); let clicks = 0;
  for (const id of ['return', 'control-task', 'control-state', 'control-error']) nodes.set(id, { hidden: false, disabled: false, textContent: '', click() { clicks++; } });
  nodes.get('control-task').textContent = 'A · owned'; nodes.get('control-state').textContent = '已暂停';
  const context = vm.createContext({ returnExpectation: { ...identity }, setTimeout, document: { getElementById: id => nodes.get(id) },
    window: { desktopControl: { control: async (...args) => { calls.push(args); throw new Error('Expected stale return rejection'); } } } });
  const run = (operation, expected = identity, slot = null) => vm.runInContext(policy.uiReturnToolbarSource(operation, nonce, expected, slot), context);
  return { run, calls, nodes, context, get clicks() { return clicks; } };
}
test('UI return fixture imports only pure policy and preserves the actual production chain', () => {
  assert.equal(typeof policy.uiReturnToolbarSource, 'function');
  const source = fs.readFileSync(path.join(__dirname, '../scripts/e2e/desktop-ui-return-main.ts'), 'utf8');
  assert.match(source, /process\.versions\.electron && \(process as any\)\.type === 'browser'/);
  assert.match(source, /service = registerDesktop\(\{ inputObserver: runtime\.observeDesktop, admission:/);
  assert.doesNotMatch(source, /new DesktopService|new DesktopWorker|allowUnobservedTestDriver|startProfilePilotManagementServer|service\.resume\(|service\.control\(/);
  assert.match(source, /value\.observers\.every/);
});
test('runner defaults to compile-only and does not offer alternate routes or implicit resume', async () => {
  const { parseUiReturnArgs } = await import('../scripts/verify-desktop-ui-return.mjs');
  assert.deepEqual(parseUiReturnArgs([]), { run: false }); assert.deepEqual(parseUiReturnArgs(['--run']), { run: true });
  for (const args of [['--run', '--check'], ['--run', '--run'], ['--case', 'A'], ['--resume'], ['--assisted-foreground']]) assert.throws(() => parseUiReturnArgs(args));
  const source = fs.readFileSync(path.join(__dirname, '../scripts/verify-desktop-ui-return.mjs'), 'utf8');
  assert.ok(source.indexOf('if (!options.run)') < source.indexOf('await assertDesktopAcceptanceWindow()'));
  assert.ok(source.indexOf('await assertDesktopAcceptanceWindow()') < source.indexOf("await appPreflight()"));
  assert.match(source, /retireNoticeChainOwned/); assert.match(source, /Production toolbar has not yet adopted/);
});
test('private channel only permits owned discovery and bounded toolbar commands', () => {
  for (const value of [envelope('inspect'), envelope('close'), request(), envelope('desktop', { command: { action: 'desktop', method: 'status' } })]) policy.validateUiReturnRequest(value, nonce, 1000);
  for (const patch of [{ nonce: 'b'.repeat(32) }, { expiresAt: 1000 }, { expiresAt: 91001 }, { action: 'kill' }, { arbitrary: true }])
    assert.throws(() => policy.validateUiReturnRequest({ ...request(), ...patch }, nonce, 1000));
  for (const method of ['resume', 'handoff', 'action', 'screenshot', 'preview']) assert.throws(() => policy.validateUiReturnRequest(envelope('desktop', { command: { action: 'desktop', method } }), nonce, 1000));
  assert.throws(() => policy.validateUiReturnRequest(request('saved-return'), nonce, 1000));
  assert.throws(() => policy.validateUiReturnRequest(request('snapshot', { slot: 'A' }), nonce, 1000));
  policy.validateUiReturnRequest(request('saved-return', { slot: 'A' }), nonce, 1000);
});
test('return identity requires every bounded exact field', () => {
  policy.validateReturnIdentity(identity);
  for (const value of [null, {}, { ...identity, session: '' }, { ...identity, generation: '' }, { ...identity, revision: -1 },
    { ...identity, revision: 1.5 }, { ...identity, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...identity, extra: true }]) assert.throws(() => policy.validateReturnIdentity(value));
});
test('toolbar operations require pinned target, document, current identity and intentional pause', () => {
  policy.validateUiReturnToolbar(request(), facts());
  const changes = [v => v.browserFactoryCalls++, v => v.runtime.browserPids.push(99), v => v.target.pid++, v => v.status.session.revision++,
    v => v.status.inputObservation.generation = 'old', v => v.toolbar.webContentsId++, v => v.toolbar.documentNonce = 'foreign',
    v => v.toolbar.exactOwnedFile = false, v => v.toolbar.destroyed = true, v => v.toolbar.visible = false,
    v => v.status.inputObservation.reason = 'physical_input', v => v.status.inputObservation.reason = 'notice_unavailable'];
  for (const mutate of changes) { const value = facts(); mutate(value); assert.throws(() => policy.validateUiReturnToolbar(request(), value)); }
  const unexpected = facts(); unexpected.status.inputObservation.reason = 'disconnected';
  assert.throws(() => policy.validateUiReturnToolbar(request('takeover'), unexpected));
});
test('saved A identity comes from rendered state and survives later B updates without replacement', async () => {
  const f = renderer(), saved = await f.run('save', identity, 'A'); assert.equal(saved.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.saved)), identity);
  const next = { session: 'B', generation: 'desktop-second', revision: 2 }; f.context.returnExpectation = next;
  const reply = await f.run('saved-return', next, 'A'); assert.equal(reply.ok, true); assert.equal(reply.accepted, false);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [['return', identity]]);
  assert.equal(f.clicks, 0);
});
test('saved same-generation identity is not refreshed after another takeover revision', async () => {
  const f = renderer(); await f.run('save', identity, 'B');
  f.context.returnExpectation = { ...identity, revision: 2 };
  const reply = await f.run('saved-return', f.context.returnExpectation, 'B');
  assert.equal(reply.accepted, false); assert.equal(f.calls[0][1].revision, 1);
  assert.equal((await f.run('save', f.context.returnExpectation, 'B')).reason, 'already_saved');
});
test('missing or stale rendered identity never gets repaired by reading current status', async () => {
  for (const rendered of [undefined, { ...identity, revision: 0 }, { ...identity, session: 'other' }]) {
    const f = renderer(); f.context.returnExpectation = rendered;
    for (const operation of ['snapshot', 'save', 'current-click']) {
      const result = await f.run(operation, identity, operation === 'save' ? 'A' : null);
      assert.equal(result.ok, false); assert.equal(result.reason, 'render_not_current');
    }
    assert.equal(f.clicks, 0); assert.deepEqual(f.calls, []);
  }
});
test('raw return intentionally carries no identity and catches its rejection locally', async () => {
  const f = renderer(), result = await f.run('raw-return');
  assert.equal(result.ok, true); assert.equal(result.accepted, false); assert.match(result.message, /Expected stale/);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [['return']]);
});
test('the one positive path invokes the actual button, never a replacement control implementation', async () => {
  const f = renderer(), result = await f.run('current-click');
  assert.equal(result.issued, 'production-button-click'); assert.equal(f.clicks, 1); assert.deepEqual(f.calls, []);
  for (const property of ['hidden', 'disabled']) {
    const blocked = renderer(); blocked.nodes.get('return')[property] = true;
    assert.equal((await blocked.run('current-click')).ok, false); assert.equal(blocked.clicks, 0);
  }
});
test('positive click waits for the production handler to leave its pending state', async () => {
  const f = renderer(), button = f.nodes.get('return'); let finished = false;
  button.click = () => { button.disabled = true; setTimeout(() => { finished = true; button.disabled = false; }, 5); };
  const reply = await f.run('current-click'); assert.equal(finished, true); assert.equal(reply.handlerSettled, true); assert.equal(reply.completedError, '');
});
test('rejection evidence rejects hidden recovery, loss of notice, new driver and incomplete retirement', () => {
  policy.validateUiReturnRejected(facts(), facts());
  const changes = [v => v.spawnCount++, v => v.drivers.push({ roles: ['owner'], stopConfirmed: true }),
    v => v.status.session.revision++, v => v.status.session.state = 'active', v => v.runtime.desktop = { phase: 'ready' },
    v => v.runtime.stopConfirmed = false, v => v.observers[0].closed = false, v => v.observers[0].exited = false,
    v => v.toolbar.destroyed = true, v => v.toolbar.webContentsId++, v => v.runtime.browserPids.push(99),
    v => v.drivers[1].stopConfirmed = false];
  for (const mutate of changes) { const value = facts(); mutate(value); assert.throws(() => policy.validateUiReturnRejected(facts(), value)); }
});
test('source construction rejects unbounded identity or injected nonce syntax', () => {
  assert.throws(() => policy.uiReturnToolbarSource('current-click', "';throw Error()", identity, null));
  assert.throws(() => policy.uiReturnToolbarSource('resume', nonce, identity, null));
  assert.throws(() => policy.uiReturnToolbarSource('save', nonce, identity, null));
});
