const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { runWithControlTrace, parseTraceOptions, describeTraceCommand } = loadCli('src/main/control-trace-cli.ts');
const { summarizeControlTraces, readControlTraceSamples } = loadCli('src/main/control-trace-report.ts');
const { controlRecovery } = loadCli('src/shared/control-recovery.ts');
const { profilePilotManagementRoot } = loadCli('src/main/profilepilot-management-protocol.ts');

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-trace-usage-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const env = {}, runtime = { homeDir, env };
  let stdout = '', stderr = '';
  return { runtime, root: profilePilotManagementRoot(homeDir, env), io: {
    stdout: { write: chunk => { stdout += chunk; return true; } }, stderr: { write: chunk => { stderr += chunk; return true; } }
  }, output: () => ({ stdout, stderr }) };
}

test('CLI records phone action metadata and recovery without private content or changing I/O', async t => {
  const f = fixture(t);
  const response = { id: '12345678-1234-1234-1234-123456789abc', ok: false,
    error: { code: 'PHONE_SESSION_CONFLICT', message: 'secret-page-content', details: { recovery: controlRecovery('PHONE_SESSION_CONFLICT') } } };
  const runtime = { ...f.runtime, request: async () => response };
  const args = ['--task-kind', 'verification', '--task-id', 'private task name', '--operation-id', 'private operation', 'phone', 'action', '--params-stdin'];
  const code = await runWithControlTrace(args, f.io, runtime, async (forwarded, io, r) => {
    assert.deepEqual(forwarded, ['phone', 'action', '--params-stdin']);
    const result = await r.request({ action: 'phone', method: 'action', params: { id: 'private-device', sessionId: 'private-session',
      requestId: 'private-action-id', action: { kind: 'tap', text: 'secret-password' } } });
    io.stdout.write(JSON.stringify(result) + '\n'); return 75;
  });
  assert.equal(code, 75); assert.equal(f.output().stdout, JSON.stringify(response) + '\n'); assert.equal(f.output().stderr, '');
  const raw = fs.readFileSync(path.join(f.root, 'control-diagnostics', 'cli-phone.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /private|secret|password|message/);
  const event = JSON.parse(raw);
  assert.equal(event.actionKind, 'tap'); assert.match(event.actionRequestId, /^[a-f0-9]{16}$/);
  assert.equal(event.requestId, response.id); assert.equal(event.taskKind, 'verification');
  assert.equal(event.ok, false); assert.equal(event.exitCode, 75); assert.equal(event.actionOutcome, 'not-executed');
  assert.equal(event.nextStep, 'wait-for-owner'); assert.equal(event.automaticReplay, false);
});

test('every control route is traced, no task category is inferred, and invalid flags never dispatch', async t => {
  const f = fixture(t);
  for (const [args, route] of [
    [['browser', '--session', 't', 'observe'], 'extension'],
    [['browser', '--cdp', '45678', 'snapshot'], 'gateway'],
    [['electron', 'inspect', 'local-app:a'], 'electron'],
    [['desktop', 'windows'], 'desktop'], [['gpui', 'list'], 'gpui'], [['phone', 'list'], 'phone'], [['remote', 'list'], 'remote']
  ]) {
    assert.equal(await runWithControlTrace(args, f.io, f.runtime, async (_, io) => { io.stdout.write('{"ok":true}\n'); return 0; }), 0);
    const row = JSON.parse(fs.readFileSync(path.join(f.root, 'control-diagnostics', `cli-${route}.jsonl`), 'utf8'));
    assert.equal(row.route, route); assert.equal(row.taskKind, 'unspecified');
  }
  let calls = 0;
  assert.equal(await runWithControlTrace(['--task-kind', 'invented', 'phone', 'list'], f.io, f.runtime, async () => { calls++; return 0; }), 2);
  assert.equal(calls, 0);
  assert.throws(() => parseTraceOptions(['--task-id', 'one', '--task-id', 'two', 'phone', 'list']), /重复/);
  assert.deepEqual(parseTraceOptions(['phone', 'wrap', '--', 'tool', '--task-id', 'literal']).args, ['phone', 'wrap', '--', 'tool', '--task-id', 'literal']);
  assert.equal(describeTraceCommand(['browser', '--connection=gateway', '--session=t', 'observe']).route, 'gateway');
  for (const literal of ['--task-id', '--task-kind', '--operation-id', '--recovery-of']) {
    const payload = ['browser', '--cdp', '45678', 'fill', '@e1', literal, 'literal value'];
    assert.deepEqual(parseTraceOptions(payload).args, payload);
  }
  const described = describeTraceCommand(['browser', '--root', 'private root', '--timeout', '2000', '--session', 's', '--cdp', '45678', 'fill', '@e1', '--task-id']);
  assert.equal(described.method, 'fill'); assert.equal(described.route, 'gateway'); assert.equal(described.sessionId, 's');
});

test('trace failure cannot alter success, throw, or replay the command', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.root, { recursive: true }); fs.writeFileSync(path.join(f.root, 'control-diagnostics'), 'blocked');
  let calls = 0;
  assert.equal(await runWithControlTrace(['desktop', 'action'], f.io, f.runtime, async () => { calls++; return 0; }), 0);
  assert.equal(calls, 1);
});

test('usage metrics distinguish explicit first attempts, preparation and recovery, without service duplication', async t => {
  const f = fixture(t), directory = path.join(f.root, 'control-diagnostics'); fs.mkdirSync(directory, { recursive: true });
  const taskHash = 'a'.repeat(16), operationHash = 'b'.repeat(16);
  const row = (second, method, ok, extra = {}) => ({ at: `2026-11-04T01:00:0${second}.000Z`, route: 'phone', scope: 'cli', requestId: `request-${second}`,
    taskKind: 'verification', durationMs: 20, taskHash, method, ok, ...extra });
  const records = [row(0, 'list', true), row(1, 'start', true), row(2, 'action', false, { operationHash, requiresUser: true, code: 'PHONE_DEVICE_LOCKED' }),
    row(5, 'action', true, { operationHash, recoveryOfHash: operationHash }), row(6, 'snapshot', true, { operationHash: 'c'.repeat(16) })];
  fs.writeFileSync(path.join(directory, 'cli-phone.jsonl'), records.map(x => JSON.stringify(x)).join('\n') + '\n{partial\n');
  fs.writeFileSync(path.join(directory, 'phone-123.jsonl'), JSON.stringify({ ...records[0], scope: 'service' }) + '\n');
  const sampled = readControlTraceSamples(f.root, 0, Date.parse('2026-11-05T00:00:00Z'));
  assert.equal(sampled.rows.length, 5); assert.equal(sampled.skippedLines, 1);
  const report = summarizeControlTraces(sampled.rows);
  assert.equal(report.recordedCalls, 5); assert.equal(report.failedCalls, 1);
  assert.equal(report.firstAttempt.explicitlyCorrelatedOperations, 2); assert.equal(report.firstAttempt.successRate, .5);
  assert.equal(report.commandsBeforeFirstEffectiveOperation.median, 3);
  assert.equal(report.recovery.explicitlyLinkedAttempts, 1); assert.equal(report.recovery.recoveredOperations, 1);
  assert.equal(report.recovery.durationMs.median, 3000); assert.deepEqual(report.userIntervention.reasons, { PHONE_DEVICE_LOCKED: 1 });
  assert.equal(summarizeControlTraces([row(0, 'observe', true)]).firstAttempt.successRate, null);
});

test('report command is local, filters task type, and never dispatches control', async t => {
  const f = fixture(t);
  await runWithControlTrace(['--task-kind', 'verification', 'gpui', 'list'], f.io, f.runtime, async () => 0);
  let reports = '';
  const io = { stdout: { write: value => { reports += value; return true; } }, stderr: f.io.stderr };
  const code = await runWithControlTrace(['trace', 'report', '--task-kind', 'real', '--json'], io, f.runtime, async () => { throw Error('must not dispatch'); });
  assert.equal(code, 0); const report = JSON.parse(reports); assert.equal(report.recordedCalls, 0); assert.equal(report.firstAttempt.successRate, null);
});

test('real top-level CLI preserves encoded Windows args, stdin and request correlation', async t => {
  const { runProfilePilotCli } = loadCli('src/main/profilepilot-cli.ts');
  const { Readable } = require('node:stream');
  const f = fixture(t); let requests = 0;
  const runtime = { ...f.runtime, stdin: Readable.from(['\uFEFF' + JSON.stringify({ args: ['shell', 'id'] })]),
    request: async () => { requests++; throw Error('invalid device must fail before transport'); } };
  const command = ['--task-kind', 'verification', '--task-id', 'stdin-check', 'phone', 'exec', '--params-stdin'];
  runtime.env.PROFILEPILOT_LAUNCHER_ARGV = Buffer.from(JSON.stringify(command)).toString('base64');
  const code = await runProfilePilotCli(['--profilepilot-argv-env'], f.io, runtime);
  assert.equal(code, 2); assert.equal(requests, 0); assert.equal(runtime.env.PROFILEPILOT_LAUNCHER_ARGV, undefined);
  const records = readControlTraceSamples(f.root).rows;
  assert.equal(records.length, 1); assert.equal(records[0].taskKind, 'verification'); assert.equal(records[0].ok, false);
  const serialized = fs.readFileSync(path.join(f.root, 'control-diagnostics', 'cli-phone.jsonl'), 'utf8');
  assert.equal(JSON.parse(serialized).actionOutcome, 'not-executed');
});

test('operation IDs reused in different tasks cannot count each other as recovery', () => {
  const base = { route: 'phone', scope: 'cli', requestId: 'id', taskKind: 'real', durationMs: 10, method: 'action', operationHash: 'a'.repeat(16) };
  const report = summarizeControlTraces([
    { ...base, at: '2026-11-04T00:00:00Z', taskHash: 'b'.repeat(16), ok: false },
    { ...base, at: '2026-11-04T00:00:01Z', taskHash: 'c'.repeat(16), ok: true }
  ]);
  assert.equal(report.firstAttempt.explicitlyCorrelatedOperations, 2); assert.equal(report.recovery.recoveredOperations, 0);
});

test('unknown GPUI tools are hashed through the real CLI and service trace writer', async t => {
  const { runProfilePilotCli } = loadCli('src/main/profilepilot-cli.ts');
  const { writeControlTrace } = loadCli('src/main/control-trace.ts');
  const f = fixture(t), privateTool = 'private-tool-password123'; let requests = 0;
  const code = await runProfilePilotCli(['--task-kind', 'verification', 'gpui', 'call', '--session', 'privacy-check', '--tool', privateTool], f.io, {
    ...f.runtime, request: async command => {
      requests++; assert.equal(command.tool, privateTool);
      return { id: 'privacy-request', ok: false, error: { code: 'GPUI_TOOL_NOT_ALLOWED', message: `Unknown tool ${privateTool}` } };
    }
  });
  assert.equal(code, 1); assert.equal(requests, 1);
  writeControlTrace(f.root, 'gpui', { requestId: 'service-privacy', method: 'call', actionKind: privateTool, durationMs: 1, ok: false });
  writeControlTrace(f.root, 'gpui', { requestId: 'service-known', method: 'call', actionKind: 'get_element', durationMs: 1, ok: true });
  const directory = path.join(f.root, 'control-diagnostics');
  const serialized = fs.readdirSync(directory).filter(name => name.endsWith('.jsonl')).map(name => fs.readFileSync(path.join(directory, name), 'utf8')).join('');
  assert.ok(!serialized.includes(privateTool)); assert.ok(!serialized.includes('Unknown tool'));
  const rows = serialized.trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => /^unknown:[a-f0-9]{16}$/.test(row.actionKind)).length, 2);
  assert.equal(rows.find(row => row.actionKind === 'get_element').ok, true);
});
