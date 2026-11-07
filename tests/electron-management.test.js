const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { executeLocalAppManagementCommand } = loadCli('src/main/local-apps/management.ts');
const { runElectronCli } = loadCli('src/main/electron-cli.ts');
const { runProfilePilotCli } = loadCli('src/main/profilepilot-cli.ts');
const { executeProfilePilotManagementCommand } = loadCli('src/main/profilepilot-management-server.ts');

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const token = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const view = () => ({ id, name: '应用 中文', mode: 'launch', agentPort: 49337,
  cdpPort: 9337, inspectPort: 9338, environment: 'TOKEN=private-secret', command: 'secret-command', cwd: '/private',
  controls: { start: false, stop: false, restart: false }, managed: false,
  runtime: { status: 'running', pid: 42 }, debug: { renderer: true, main: false, targets: [{ url: 'private-url' }] },
  agent: { connected: true, sessionId: 'other-agent', ownership: 'user' }
});
function service(rows = [view()]) {
  const calls = [];
  return { calls, snapshot: () => rows, list: async () => rows,
    connect: async (...args) => { calls.push(args); return { status: 'restart-required', confirmationToken: token }; } };
}
function output() {
  let stdout = '', stderr = '';
  return { io: { stdout: { write: s => stdout += s }, stderr: { write: s => stderr += s } },
    stdout: () => stdout, stderr: () => stderr };
}

test('all-app inspection exposes readiness and ownership without launch credentials or raw ports', async () => {
  const host = service();
  const result = await executeLocalAppManagementCommand({ action: 'local-app', method: 'list' }, host);
  assert.equal(result.apps[0].agent.ownership, 'user');
  assert.equal(result.apps[0].port, 49337);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|:9337\b|:9338\b|command|environment|targets/);
  assert.deepEqual(host.calls, []);
});

test('connect resolves exact names and IDs and delegates consent once to the existing connector', async () => {
  for (const selector of ['应用 中文', id, `local-app:${id}`]) {
    const host = service();
    const result = await executeLocalAppManagementCommand({ action: 'local-app', method: 'connect', selector, confirmationToken: token }, host);
    assert.equal(result.status, 'restart-required');
    assert.equal(result.confirmationToken, token);
    assert.deepEqual(host.calls, [[id, token]]);
  }
});

test('ambiguous, missing and malformed targets cannot trigger an application connection', async () => {
  const host = service([view(), { ...view(), id: 'other' }]);
  for (const [selector, code] of [['应用 中文', 'LOCAL_APP_AMBIGUOUS'], ['9337', 'LOCAL_APP_NOT_FOUND']]) {
    await assert.rejects(executeLocalAppManagementCommand({ action: 'local-app', method: 'connect', selector }, host), e => e.code === code);
  }
  await assert.rejects(executeLocalAppManagementCommand({ action: 'local-app', method: 'connect', selector: id, force: true }, host), e => e.code === 'LOCAL_APP_INVALID_ARGUMENTS');
  assert.deepEqual(host.calls, []);
});

test('management server uses its live application service and propagates occupied-session failures', async () => {
  const host = service(); let changed = 0;
  const command = { action: 'local-app', method: 'connect', selector: id };
  await assert.rejects(executeProfilePilotManagementCommand(command, {}), e => e.code === 'LOCAL_APP_SERVICE_UNAVAILABLE');
  const options = { getLocalAppsService: () => host, onMutation: () => changed++ };
  const result = await executeProfilePilotManagementCommand(command, options);
  assert.equal(result.status, 'restart-required');
  host.connect = async () => { throw new Error('此应用仍有 Agent 会话'); };
  await assert.rejects(executeProfilePilotManagementCommand(command, options), /Agent 会话/);
  assert.equal(changed, 1);
});

test('configure preserves credentials and ports and refuses registrations owned by another session', async () => {
  const row = view(); row.agent = { connected: true };
  const host = service([row]), saves = [];
  host.get = () => row;
  host.save = async input => { saves.push(input); };
  host.syncAgents = async () => {};
  const command = { action: 'local-app', method: 'configure', selector: id, input: { command: 'new-command' } };
  const result = await executeLocalAppManagementCommand(command, host);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].command, 'new-command');
  assert.equal(saves[0].environment, row.environment);
  assert.equal(saves[0].agentPort, row.agentPort);
  assert.doesNotMatch(JSON.stringify(result), /private-secret|new-command/);
  row.agent.sessionId = 'other-agent'; row.agent.ownership = 'user';
  await assert.rejects(executeLocalAppManagementCommand(command, host), e => e.code === 'LOCAL_APP_BUSY');
  assert.equal(saves.length, 1);
  await assert.rejects(executeLocalAppManagementCommand({ ...command, input: { agentPort: 1234 } }, host), e => e.code === 'LOCAL_APP_INVALID_ARGUMENTS');
});

test('configure CLI reads a UTF-8 JSON file and rejects changes outside launch-path repair', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-electron-configure-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'input.json'), out = output(), calls = [];
  const request = async command => { calls.push(command); return { ok: true, data: {} }; };
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ command: '"C:\\应用\\应用.exe" --open-settings' }));
  assert.equal(await runElectronCli(['configure', id, '--params-file', file], out.io, {}, { request }), 0);
  assert.equal(calls[0].input.command, '"C:\\应用\\应用.exe" --open-settings');
  fs.writeFileSync(file, JSON.stringify({ agentPort: 9337 }));
  assert.equal(await runElectronCli(['configure', id, '--params-file', file], out.io, {}, { request }), 64);
  assert.equal(calls.length, 1);
});

test('CLI management commands use authenticated management transport and preserve restart-required', async () => {
  const cases = [
    [['list', '--all', '--json'], { action: 'local-app', method: 'list' }],
    [['inspect', '应用 中文'], { action: 'local-app', method: 'inspect', selector: '应用 中文' }],
    [['connect', id, '--confirmation-token', token], { action: 'local-app', method: 'connect', selector: id, confirmationToken: token }]
  ];
  for (const [args, command] of cases) {
    const out = output(), calls = [];
    const status = await runProfilePilotCli(['electron', ...args], out.io, { request: async c => {
      calls.push(c); return { ok: true, data: { status: 'restart-required', confirmationToken: token } };
    } });
    assert.equal(status, 75);
    assert.deepEqual(calls, [command]);
    assert.equal(JSON.parse(out.stdout()).result.confirmationToken, token);
  }
});

test('malformed CLI options and raw-port connection routes never invoke management', async () => {
  for (const args of [['connect'], ['connect', id, '--yes'], ['connect', id, '--confirmation-token', 'invalid'],
    ['inspect', id, '--confirmation-token', token], ['list', '--all', '--all'], ['--cdp', '49337', 'connect', id]]) {
    const out = output(); let called = false;
    assert.equal(await runElectronCli(args, out.io, {}, { request: async () => { called = true; } }), 64);
    assert.equal(called, false);
  }
});

test('connection failures and uncertain transport outcomes are reported without automatic retries', async () => {
  for (const transportFailure of [false, true]) {
    const out = output(); let calls = 0;
    const status = await runElectronCli(['connect', id], out.io, {}, { request: async () => {
      calls++;
      if (transportFailure) throw new Error('request timed out');
      return { ok: false, error: { code: 'OCCUPIED', message: '另一个 Agent 正在使用' } };
    } });
    assert.equal(status, transportFailure ? 69 : 1);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(out.stderr()).code, transportFailure ? 'LOCAL_APP_MANAGEMENT_UNAVAILABLE' : 'OCCUPIED');
  }
});
