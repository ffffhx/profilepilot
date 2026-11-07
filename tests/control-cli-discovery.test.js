const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { runElectronCli } = loadCli('src/main/electron-cli.ts');
const { runDesktopCli } = loadCli('src/main/desktop/cli.ts');
const { runGpuiCli } = loadCli('src/main/gpui/cli.ts');
const { GpuiService } = loadCli('src/main/gpui/service.ts');
const { executeLocalAppManagementCommand } = loadCli('src/main/local-apps/management.ts');
const { runProfilePilotCli, parseProfilePilotCliArgs } = loadCli('src/main/profilepilot-cli.ts');

function capture() {
  let out = '', err = '';
  return { io: { stdout: { write: value => { out += value; } }, stderr: { write: value => { err += value; } } },
    out: () => out, err: () => err, json: () => JSON.parse(out || err) };
}
const ok = data => ({ version: 1, id: 'test', ok: true, data });
const noRequest = async () => { throw new Error('Discovery must not call transport'); };
const windowId = 'a'.repeat(32);
const app = { id: "local-app:app'1", name: '测试应用', port: 49337, runtime: { status: 'running' },
  debug: { renderer: true }, agent: { connected: true, sessionId: 'task', ownership: 'agent' } };

test('command schema and narrow help are local through real CLI entries', async () => {
  for (const [run, group, command] of [[runDesktopCli, 'desktop', 'action'], [runGpuiCli, 'gpui', 'call']]) {
    const schema = capture();
    assert.equal(await run(['schema', command], noRequest, schema.io), 0);
    const result = schema.json().result;
    assert.equal(result.runtimeVerified, false);
    assert.deepEqual(Object.keys(result.commands), [command]);
    assert.ok(result.commands[command].allowedOptions.includes('--params-file'));
    const help = capture();
    assert.equal(await run([command, '--help'], noRequest, help.io), 0);
    assert.match(help.out(), new RegExp('ppilot ' + group + ' ' + command));
    assert.match(help.out(), /PowerShell:/); assert.match(help.out(), /POSIX:/);
    assert.doesNotMatch(help.out(), /无线配对|查找全部登记/);
  }
  const electron = capture();
  assert.equal(await runElectronCli(['schema', 'register'], electron.io, {}, { request: noRequest }), 0);
  assert.deepEqual(Object.keys(electron.json().result.commands), ['register']);
});

test('invalid command parameters return actionable help before transport', async () => {
  for (const [run, args] of [[runDesktopCli, ['action', '--wrong']], [runGpuiCli, ['call', '--wrong']]]) {
    const f = capture(); assert.equal(await run(args, noRequest, f.io), 2);
    const result = f.json(); assert.ok(result.guidance.allowedOptions.includes('--params-file'));
    assert.ok(result.guidance.example.argv.includes('--params-file'));
  }
  const f = capture(); assert.equal(await runElectronCli(['configure', 'app', '--wrong'], f.io, {}, { request: noRequest }), 64);
  assert.ok(f.json().guidance.allowedOptions.includes('--params-file'));
});

test('Electron page schema delegates to the current Gateway contract without selecting a target', async () => {
  const f = capture();
  assert.equal(await runElectronCli(['schema', 'action'], f.io, {}, { request: noRequest, targets: () => { throw new Error('No catalog read needed'); } }), 0);
  const result = f.json().result;
  assert.equal(result.connection, 'gateway'); assert.equal(result.command, 'action');
  assert.equal(result.runtimeVerified, false);
  assert.ok(result.operation.input);
  const help = capture();
  assert.equal(await runElectronCli(['observe', '--help'], help.io, {}, { request: noRequest }), 0);
  assert.match(help.out(), /ppilot electron/); assert.doesNotMatch(help.out(), /ppilot browser/);
});

test('Electron inspect recommends actual logical port while preserving owner and target route', async () => {
  for (const [agent, session, expected] of [
    [app.agent, 'task', 'ready'],
    [{ ...app.agent, ownership: 'user' }, 'task', 'return-control'],
    [app.agent, 'other', 'wait-for-owner']
  ]) {
    const f = capture(), calls = [];
    assert.equal(await runElectronCli(['inspect', app.id, '--session', session], f.io, {}, {
      request: async command => { calls.push(command); return ok({ app: { ...app, agent } }); }
    }), 0);
    const route = f.json().routing;
    assert.equal(route.recommendedRoute, 'electron'); assert.equal(route.state, expected);
    assert.equal(calls.length, 1); assert.equal(calls[0].method, 'inspect');
    assert.equal(route.automaticResume, false);
    if (expected === 'ready') assert.deepEqual(route.nextCommand.argv, ['ppilot', 'electron', '--session', 'task', '--cdp', '49337', 'observe']);
    else assert.equal(route.readyToAct, false);
  }
  const missing = capture();
  await runElectronCli(['inspect', 'new-app'], missing.io, {}, { request: async () => ({ ok: false, error: { code: 'LOCAL_APP_NOT_FOUND', message: 'missing' } }) });
  assert.equal(missing.json().routing.recommendedRoute, 'electron');
  assert.deepEqual(missing.json().routing.nextCommand.argv, ['ppilot', 'electron', 'register', '--help']);
  assert.doesNotMatch(missing.err(), /ppilot desktop/);
});

test('Electron registration follows management save without launch, connect or ownership changes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-discovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = { name: 'New Electron', mode: 'attach', cwd: '', command: '', cdpPort: 43121, agentPort: 43122 };
  const file = path.join(directory, 'app.json'); fs.writeFileSync(file, '\uFEFF' + JSON.stringify(input));
  const f = capture(), calls = [], saved = [];
  const service = { snapshot: () => [], save: async value => { saved.push(value); return 'new-id'; },
    connect: noRequest, syncAgents: noRequest, list: noRequest, get: noRequest };
  assert.equal(await runElectronCli(['register', '--params-file', file], f.io, {}, { request: async command => {
    calls.push(command); return ok(await executeLocalAppManagementCommand(command, service));
  } }), 0);
  assert.equal(calls[0].method, 'register'); assert.equal(saved.length, 1);
  assert.equal(f.json().result.connected, false);
  assert.equal(f.json().result.app.id, 'local-app:new-id');
  await assert.rejects(executeLocalAppManagementCommand(calls[0], { ...service, snapshot: () => [{ name: input.name }] }), { code: 'LOCAL_APP_ALREADY_REGISTERED' });
});

test('desktop diagnostic keeps paused reservation and reports macOS unsupported', async () => {
  for (const [status, state] of [
    [{ supported: false, available: false, platform: 'darwin', reason: 'macOS unsupported' }, 'unsupported'],
    [{ supported: true, available: true, session: { name: 'task', state: 'paused' }, inputObservation: { available: true, phase: 'paused' } }, 'return-control'],
    [{ supported: true, available: true, session: { name: 'task', state: 'active' }, inputObservation: { available: true, phase: 'pending' } }, 'repair-required']
  ]) {
    const f = capture(), calls = [];
    assert.equal(await runDesktopCli(['doctor', '--window', windowId, '--session', 'task'], async command => {
      calls.push(command); return ok({ status });
    }, f.io), 0);
    assert.equal(f.json().routing.state, state); assert.equal(f.json().routing.readyToAct, false);
    assert.deepEqual(calls.map(c => c.method), ['doctor']);
    assert.notEqual(f.json().routing.nextCommand.argv[2], 'claim');
  }
});

test('GPUI doctor never uses CDP, reclaims or resumes an occupied target', async () => {
  const f = capture(), calls = [];
  const target = { target_id: 'instance-1', app_name: 'demo', app_id: 'demo', pid: 123 };
  assert.equal(await runGpuiCli(['doctor', '--target', target.target_id, '--session', 'task'], async command => {
    calls.push(command);
    return ok(command.method === 'status' ? { backend: '/actual/backend', sessions: [{ name: 'task', state: 'paused', inputGuard: 'unavailable', app: target }] } : { apps: [target] });
  }, f.io), 0);
  assert.equal(f.json().routing.state, 'return-control');
  assert.equal(f.json().routing.recommendedRoute, 'gpui');
  assert.deepEqual(calls.map(c => c.method), ['status', 'list']);
});

test('GPUI tool schema uses the installed backend and never selects or controls an app', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-gpui-schema-'));
  const actual = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 } }, additionalProperties: false };
  let reads = 0;
  const service = new GpuiService({ directory, defaultBackend: process.execPath, backendFactory: () => ({
    start: async () => {}, close() {}, call: noRequest, tools: async () => { reads++; return [
      { name: 'click_element', inputSchema: actual }, { name: 'select_app', inputSchema: {} }
    ]; }
  }) });
  t.after(() => { service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const f = capture();
  assert.equal(await runGpuiCli(['schema', 'click_element'], async command => ok(await service.execute(command)), f.io), 0);
  assert.deepEqual(f.json().result.tools, [{ name: 'click_element', inputSchema: actual, requiresObservation: true }]);
  assert.equal(f.json().result.targetVerified, false); assert.equal(reads, 1);
  assert.deepEqual(service.status().sessions, []);
  await assert.rejects(service.execute({ action: 'gpui', method: 'schema', tool: 'select_app' }), { code: 'GPUI_TOOL_UNSUPPORTED' });
  assert.equal(reads, 1);
});

test('desktop and Electron JSON schemas expose real validator constraints', async () => {
  const desktop = capture(); await runDesktopCli(['schema', 'action'], noRequest, desktop.io);
  const schema = desktop.json().result.commands.action.input;
  assert.equal(schema.properties.x.maximum, 8191);
  const value = schema.oneOf.find(branch => branch.properties.kind.const === 'set_value');
  assert.ok(value.required.includes('value')); assert.ok(value.required.includes('ref'));
  assert.equal(value.additionalProperties, false); assert.equal(value.properties.x, undefined);
  const key = schema.oneOf.find(branch => branch.properties.kind.const === 'press_key');
  assert.equal(key.properties.keys.maxItems, 5);
  const electron = capture(); await runElectronCli(['schema', 'register'], electron.io, {}, { request: noRequest });
  const registration = electron.json().result.commands.register.input;
  assert.equal(registration.properties.name.maxLength, 100);
  assert.equal(registration.properties.cdpPort.minimum, 1024);
  assert.equal(registration.additionalProperties, false);
});

test('top-level doctor selects requested route and forwards task identity without controlling', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-doctor-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = capture(), calls = [];
  const code = await runProfilePilotCli(['doctor', '--electron', app.id, '--session', 'task', '--json'], f.io, {
    homeDir: directory, env: { PROFILEPILOT_NATIVE_ROOT: path.join(directory, 'native'), CPM_DATA_DIR: directory },
    request: async command => {
      calls.push(command);
      if (command.action === 'ping') return ok({ app_version: 'test', protocol_version: 1, pid: 10 });
      if (command.action === 'phone') return ok({ devices: [] });
      if (command.action === 'local-app' && command.method === 'inspect') return ok({ app });
      throw new Error('Unexpected command ' + JSON.stringify(command));
    }
  });
  assert.equal(code, 0);
  const application = f.json().applications;
  assert.equal(application.selectedRoute, 'electron');
  assert.equal(application.electron.targets[0].routing.state, 'ready');
  assert.ok(calls.every(command => ['ping', 'phone', 'local-app'].includes(command.action)));
  assert.ok(calls.every(command => !['claim', 'connect', 'resume'].includes(command.method)));
  assert.throws(() => parseProfilePilotCliArgs(['doctor', '--electron', 'app', '--route', 'desktop']), /一致/);
});
