const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { buildSync } = require('esbuild');
const { loadCli } = require('./cli-test-build.cjs');
const { browserGatewaySocketPath, BROWSER_GATEWAY_PROTOCOL_VERSION } = loadCli('src/main/browser-gateway-client.ts');
const { writeAgentBrowserRuntimeProfilesSync } = loadCli('src/main/agent-browser-lease.ts');
const { ENGINE_VERSION } = loadCli('src/main/browser-engine/arguments.ts');
const { controlRecovery } = loadCli('src/shared/control-recovery.ts');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-browser-trace-')), management = path.join(root, 'management');
  const cli = path.join(root, 'ppilot.cjs'), engine = path.join(root, 'profilepilot-browser-engine.cjs');
  for (const [entry, output] of [['src/main/profilepilot-cli.ts', cli], ['src/main/browser-engine/cli.ts', engine]]) {
    fs.writeFileSync(output, buildSync({ entryPoints: [path.resolve(entry)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['playwright-core'], logLevel: 'silent' }).outputFiles[0].contents);
  }
  fs.writeFileSync(path.join(root, 'browser-runtime.json'), JSON.stringify({ executable: engine }));
  const session = 'trace-task', engineRoot = path.join(root, 'engine'); fs.mkdirSync(engineRoot);
  let failure = false, activity = 0, identity;
  const requests = [], nativeRequests = [];
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      const command = JSON.parse(Buffer.concat(chunks)); let response;
      if (req.url === '/native-service') response = { ok: true, result: { service: 'browser', version: 1, pid: process.pid, root } };
      else if (req.url === '/native-control') {
        nativeRequests.push(command);
        response = failure ? { ok: false, requestId: command.requestId, code: 'NATIVE_USER_IN_CONTROL', error: 'private error body', recovery: controlRecovery('NATIVE_USER_IN_CONTROL') }
          : { ok: true, result: { privatePageText: 'private-page-value' } };
      } else if (command.ping) response = { success: true, data: record };
      else {
        requests.push(command); activity++;
        response = failure ? { success: false, requestId: command.id, code: 'BROWSER_STALE_REF', error: 'private-page-value', recovery: controlRecovery('BROWSER_STALE_REF') }
          : { success: true, requestId: command.id, data: { action: 'fill', privatePageText: 'private-page-value' } };
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(response));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const record = { version: ENGINE_VERSION, pid: process.pid, port: server.address().port, token: 'a'.repeat(64), session, root: engineRoot };
  fs.writeFileSync(path.join(engineRoot, session + '.engine.json'), JSON.stringify(record));
  fs.writeFileSync(path.join(root, 'native-control.json'), JSON.stringify({ version: 1, port: record.port, token: record.token, pid: process.pid, service: 'browser', serviceVersion: 1 }));
  writeAgentBrowserRuntimeProfilesSync([{ profileId: 'trace-fixture', profileName: 'Trace fixture', cdpPort: 9223, running: true }], root);
  const gateway = net.createServer(socket => {
    let text = ''; socket.setEncoding('utf8'); socket.on('data', chunk => {
      text += chunk; if (!text.includes('\n')) return;
      const request = JSON.parse(text.split('\n')[0]);
      if (request.action === 'acquire') identity = request.daemonInstanceId;
      const response = request.action === 'acquire' ? { ok: true, webSocketUrl: 'ws://127.0.0.1:9223/fixture', connectionActive: true }
        : { ok: true, protocolVersion: BROWSER_GATEWAY_PROTOCOL_VERSION, ports: [9223], state: { profiles: [{ publicPort: 9223, profileId: 'trace-fixture', ownerSessionId: session,
          daemonInstanceId: identity, ownership: 'agent', sessionStatus: 'active', connectionActive: true, agentActivity: { generation: activity } }] } };
      socket.end(JSON.stringify(response) + '\n');
    });
  });
  fs.mkdirSync(path.join(root, '.profilepilot', 'gateway'), { recursive: true });
  await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(browserGatewaySocketPath(root), resolve); });
  const env = { ...process.env, HOME: root, NODE_PATH: path.resolve('node_modules'), PROFILEPILOT_MANAGEMENT_ROOT: management, AGENT_BROWSER_SOCKET_DIR: engineRoot, PROFILEPILOT_CONTROL_TRACE_FD: undefined };
  t.after(async () => { await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => gateway.close(resolve))]); fs.rmSync(root, { recursive: true, force: true }); });
  const run = (args, input) => new Promise(resolve => {
    const child = spawn(process.execPath, [cli, '--task-kind', 'verification', '--task-id', 'private-task-value', 'browser', ...args], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x); child.stdin.end(input);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  const traces = route => fs.readFileSync(path.join(management, 'control-diagnostics', `cli-${route}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  return { root, engine, session, run, traces, requests, nativeRequests, engineUrl: `http://127.0.0.1:${record.port}/command`, fail: value => { failure = value; } };
}

test('compiled root CLI correlates native success/failure with the actual request and action kind', async t => {
  const f = await fixture(t), action = JSON.stringify({ kind: 'fill', version: 'v', ref: 'e1', value: 'private-input-value' });
  const args = ['--root', f.root, '--session', f.session, 'action', '--params-stdin'];
  const success = await f.run(args, action); assert.equal(success.code, 0, success.stderr);
  f.fail(true); const failure = await f.run(args, action); assert.equal(failure.code, 75, failure.stderr);
  const rows = f.traces('extension'); assert.equal(rows.length, 2);
  for (let i = 0; i < rows.length; i++) { assert.equal(rows[i].requestId, f.nativeRequests[i].requestId); assert.equal(rows[i].actionKind, 'fill'); assert.equal(rows[i].method, 'action'); }
  assert.equal(rows[0].ok, true); assert.equal(rows[1].code, 'NATIVE_USER_IN_CONTROL'); assert.equal(rows[1].requiresUser, true);
  assert.doesNotMatch(JSON.stringify(rows), /private-(?:input|page|task)|private error/);
});

test('compiled Gateway CLI preserves stdout and stdin while fd3 returns actual engine metadata on Windows and POSIX', async t => {
  const f = await fixture(t), input = JSON.stringify({ kind: 'fill', version: 'v', ref: 'e1', value: 'private-input-value' });
  const args = ['--session', f.session, '--cdp', '9223', 'action', '--params-stdin'];
  const success = await f.run(args, input); assert.equal(success.code, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).result.privatePageText, 'private-page-value');
  f.fail(true); const failure = await f.run(args, input); assert.equal(failure.code, 1, failure.stderr);
  const rows = f.traces('gateway'); assert.equal(rows.length, 2); assert.equal(f.requests.length, 2);
  for (let i = 0; i < rows.length; i++) { assert.equal(rows[i].requestId, f.requests[i].id); assert.equal(rows[i].actionKind, 'fill'); assert.equal(rows[i].method, 'action'); assert.equal(JSON.parse(f.requests[i].command.args[2]).value, 'private-input-value'); }
  assert.equal(rows[0].ok, true); assert.equal(rows[1].code, 'BROWSER_STALE_REF'); assert.equal(rows[1].nextStep, 'reobserve');
  assert.doesNotMatch(JSON.stringify(rows), /private-(?:input|page|task)/);
});

test('an older Gateway driver without a metadata channel keeps its original output and exit status', async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.engine, `const fs = require('node:fs');
    const input = fs.readFileSync(0, 'utf8');
    fetch(${JSON.stringify(f.engineUrl)}, { method: 'POST', body: JSON.stringify({ id: 'old-driver-request', command: { args: ['action', '--params', input] } }) })
      .then(response => response.json()).then(() => process.stdout.write('original legacy output\\n'));
  `);
  const result = await f.run(['--session', f.session, '--cdp', '9223', 'action', '--params-stdin'], '{"kind":"fill","version":"v","ref":"e1","value":"private-input-value"}');
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout, 'original legacy output\n');
  assert.equal(f.traces('gateway')[0].ok, true); assert.equal(f.requests.length, 1);
});
