import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadCli } = require('./cli-test-build.cjs');
const wrapper = loadCli('src/main/agent-browser-wrapper.ts');
const leases = loadCli('src/main/agent-browser-lease.ts');

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pp-gateway-home-'));
  const normal = path.join(root, 'normal'), isolated = path.join(root, 'isolated');
  mkdirSync(normal); mkdirSync(isolated);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, normal, isolated, env: { HOME: normal, PROFILEPILOT_GATEWAY_HOME: isolated, AGENT_BROWSER_SESSION: 'fixture-session', PROFILEPILOT_BROWSER_CLI: '1' } };
}
function writeNotice(home, overrides = {}) {
  const notice = { version: 1, code: 'AGENT_USER_IN_CONTROL', reason: 'user_takeover', ownership: 'agentDelegatedToUser',
    hardStop: true, session: 'fixture-session', message: 'Synthetic control notice', at: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(), ...overrides };
  for (const file of wrapper.profilePilotNoticePaths(home, 'fixture-session')) {
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(notice));
  }
  return notice;
}

test('real wrapper entrypoint honors isolated takeover state without changing HOME or launching a driver', async t => {
  const f = fixture(t); const ambientHome = process.env.HOME;
  writeNotice(f.isolated);
  let stderr = '';
  t.mock.method(process.stderr, 'write', chunk => { stderr += String(chunk); return true; });
  // If isolation regresses this invalid driver returns 127; it cannot open a browser.
  const exitCode = await wrapper.runAgentBrowserWrapper(['snapshot'], { ...f.env, PROFILEPILOT_AGENT_BROWSER_REAL: path.join(f.root, 'missing-driver') });
  assert.equal(exitCode, 75);
  assert.equal(JSON.parse(stderr).error_code, 'AGENT_USER_IN_CONTROL');
  assert.equal(process.env.HOME, ambientHome);
  assert.equal(wrapper.findActiveProfilePilotNotice(['snapshot'], { HOME: f.normal, AGENT_BROWSER_SESSION: 'fixture-session' }), null);
});

test('profile discovery and lease writes use the explicit Gateway root, preserving a separate same-port catalog', t => {
  const f = fixture(t);
  leases.writeAgentBrowserRuntimeProfilesSync([{ profileId: 'normal-profile', profileName: 'Normal profile', cdpPort: 19223, running: true }], f.normal);
  leases.writeAgentBrowserRuntimeProfilesSync([{ profileId: 'isolated-profile', profileName: 'Isolated profile', cdpPort: 19223, running: true }], f.isolated);
  const originalCatalog = readFileSync(leases.agentBrowserRuntimeProfilesPath(f.normal), 'utf8');
  const args = wrapper.resolveProfilePilotUseArgs(['profilepilot', 'use', 'Isolated profile'], f.env);
  assert.deepEqual(args, ['--session', 'fixture-session', '--cdp', '19223', 'connect', '19223']);
  assert.throws(() => wrapper.resolveProfilePilotUseArgs(['profilepilot', 'use', 'Normal profile'], f.env), /没有找到/);
  const resolution = wrapper.acquireProfileLeaseForCommandWithAutomaticSwitch(['--cdp', '19223', 'snapshot'], f.env);
  assert.equal(resolution.lease.ok, true);
  assert.equal(leases.readAgentBrowserProfileLeaseSync(19223, f.isolated).session, 'fixture-session');
  assert.equal(leases.readAgentBrowserProfileLeaseSync(19223, f.isolated).cdpPort, 19223);
  assert.equal(leases.readAgentBrowserProfileLeaseSync(19223, f.normal), null);
  assert.equal(readFileSync(leases.agentBrowserRuntimeProfilesPath(f.normal), 'utf8'), originalCatalog);
});

test('return notices are consumed only inside the explicit root and HOME fallback remains compatible', t => {
  const f = fixture(t);
  const returned = { code: 'AGENT_CONTROL_RETURNED', reason: 'user_return', ownership: 'agent', hardStop: false };
  writeNotice(f.normal, returned); writeNotice(f.isolated, returned);
  const match = wrapper.consumeProfilePilotReturnNotice(['snapshot'], f.env);
  assert.ok(match.path.startsWith(f.isolated + path.sep));
  assert.ok(wrapper.profilePilotNoticePaths(f.isolated, 'fixture-session').every(file => !existsSync(file)));
  assert.ok(wrapper.profilePilotNoticePaths(f.normal, 'fixture-session').every(file => existsSync(file)));
  const fallback = wrapper.consumeProfilePilotReturnNotice(['snapshot'], { HOME: f.normal, AGENT_BROWSER_SESSION: 'fixture-session' });
  assert.ok(fallback.path.startsWith(f.normal + path.sep));
});

test('notice cleanup default honors explicit Gateway environment without replacing system HOME', t => {
  const f = fixture(t); const priorGateway = process.env.PROFILEPILOT_GATEWAY_HOME, priorHome = process.env.HOME;
  t.after(() => { if (priorGateway === undefined) delete process.env.PROFILEPILOT_GATEWAY_HOME; else process.env.PROFILEPILOT_GATEWAY_HOME = priorGateway; });
  process.env.PROFILEPILOT_GATEWAY_HOME = f.isolated;
  writeNotice(f.isolated); writeNotice(f.normal);
  const cleared = wrapper.clearProfilePilotNoticesForSession('fixture-session');
  assert.equal(cleared.length, 2);
  assert.ok(cleared.every(file => file.startsWith(f.isolated + path.sep)));
  assert.ok(wrapper.profilePilotNoticePaths(f.normal, 'fixture-session').every(file => existsSync(file)));
  assert.equal(process.env.HOME, priorHome);
});
