const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { desktopActionSchema, desktopWaitConditionSchema } = loadCli('src/main/desktop/schema.ts');
const { runDesktopCli, desktopHelp } = loadCli('src/main/desktop/cli.ts');
const { DesktopService } = loadCli('src/main/desktop/service.ts');

for (const kind of ['restore', 'minimize', 'maximize']) {
  test(kind + ' requires a strict reference action and is available to read-only capability waits', async () => {
    const params = { kind, ref: 'e0', version: 'a'.repeat(32) };
    assert.deepEqual(desktopActionSchema.parse(params), params);
    for (const extra of [{ ref: undefined }, { version: undefined }, { x: 0, y: 0 }, { keys: ['ALT'] }, { value: '' }, { button: 'left' }, { state: 'normal' }])
      assert.equal(desktopActionSchema.safeParse({ ...params, ...extra }).success, false);
    assert.equal(desktopWaitConditionSchema.safeParse({ hasAction: kind }).success, true);
    const commands = [], output = []; const stream = { write: text => output.push(text) };
    const code = await runDesktopCli(['action', '--session', 'owned', '--params-stdin', '--json'], async command => {
      commands.push(command); return { ok: true, data: { executed: true, requiresObservation: true, windowState: { requested: kind === 'restore' ? 'normal' : kind + 'd', confirmed: true } } };
    }, { stdout: stream, stderr: stream }, Readable.from([JSON.stringify(params)]));
    assert.equal(code, 0); assert.equal(commands.length, 1); assert.deepEqual(commands[0].params, params);
    assert.equal(JSON.parse(output.join('')).result.windowState.confirmed, true);
  });
}
test('CLI window state outcome unknown is not retried', async () => {
  let calls = 0; const output = []; const stream = { write: text => output.push(text) };
  const code = await runDesktopCli(['action', '--session', 'owned', '--params-stdin', '--json'], async () => {
    calls++; return { ok: false, error: { code: 'DESKTOP_OUTCOME_UNKNOWN', message: 'unconfirmed', details: { cause: 'DESKTOP_WINDOW_STATE_UNCONFIRMED' } } };
  }, { stdout: stream, stderr: stream }, Readable.from([JSON.stringify({ kind: 'restore', version: 'a'.repeat(32), ref: 'e0' })]));
  assert.equal(code, 75); assert.equal(calls, 1); assert.equal(JSON.parse(output.join('')).details.cause, 'DESKTOP_WINDOW_STATE_UNCONFIRMED');
  assert.match(desktopHelp, /restore.*minimize.*maximize/); assert.match(desktopHelp, /Normal/);
});
test('native window route has one UIA dispatch and no foreground or Win32 mutation fallback', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../native/desktop/windows.cs'), 'utf8');
  const branch = source.slice(source.indexOf('if(windowPattern!=null){\n                int desired='), source.indexOf('}else if(kind=="invoke"'));
  assert.equal((branch.match(/SetWindowVisualState\(/g) || []).length, 1);
  assert.doesNotMatch(branch, /Activate\(|ShowWindow|SetForegroundWindow|SendInput|AttachThreadInput/);
  const confirmation = source.slice(source.indexOf('void ConfirmWindowState('), source.indexOf('object Action('));
  assert.match(confirmation, /GetWindowPlacement/); assert.match(confirmation, /SequenceEqual/); assert.match(confirmation, /Valid\(target\)/);
  assert.match(confirmation, /AutomationElement.FromHandle\(target.Handle\)/);
  assert.doesNotMatch(confirmation, /\.SetWindowVisualState\(/);
});
test('window state actions retain generic ownership, unknown receipt, and no-replay protections', async () => {
  const target = { id: 'a'.repeat(32), pid: 42, title: 'owned', process: 'fixture', className: 'Form' }; let actions = 0;
  const service = new DesktopService({ platform: 'win32', allowUnobservedTestDriver: true, available: () => true, driver: () => ({ close() {},
    async request(operation) {
      if (operation === 'windows') return { windows: [target] };
      if (operation === 'window.action') { actions++; throw Object.assign(new Error('unconfirmed'), { code: 'DESKTOP_OUTCOME_UNKNOWN', details: { cause: 'DESKTOP_WINDOW_STATE_UNCONFIRMED', diagnostics: { windowState: { confirmed: false } } } }); }
      return { version: 'b'.repeat(32), windowId: target.id, elements: [] };
    } }) });
  const command = (method, extra = {}) => ({ action: 'desktop', method, session: 'window-state-pure', ...extra });
  try {
    await service.execute(command('claim', { windowId: target.id }));
    const pending = command('action', { requestId: randomUUID(), params: { kind: 'restore', ref: 'e0', version: 'b'.repeat(32) } });
    await assert.rejects(service.execute(pending), { code: 'DESKTOP_OUTCOME_UNKNOWN' });
    assert.equal(service.status().session.state, 'paused');
    const receipt = await service.execute(command('receipt', { requestId: pending.requestId }));
    assert.equal(receipt.state, 'failed'); assert.equal(receipt.error.code, 'DESKTOP_OUTCOME_UNKNOWN');
    await assert.rejects(service.execute(pending), { code: 'DESKTOP_OUTCOME_UNKNOWN' });
    for (const kind of ['restore', 'minimize', 'maximize']) await assert.rejects(service.execute(command('action', { requestId: randomUUID(), params: { ...pending.params, kind } })), { code: 'DESKTOP_USER_IN_CONTROL' });
    assert.equal(actions, 1);
  } finally { await service.close(); }
});
