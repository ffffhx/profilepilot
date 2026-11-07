import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  evaluationEnvironmentContract, evaluationChromeArguments, startEvaluationGateway
} from '../benchmarks/agent-tasks/lib/gateway.mjs';

const ENV_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'CPM_DATA_DIR', 'PROFILEPILOT_GATEWAY_HOME', 'AGENT_BROWSER_SOCKET_DIR', 'PROFILEPILOT_AGENT_BROWSER_REAL', 'CPM_E2E_DISPOSABLE_PROFILES'];
const environment = () => Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const browserReadback = () => ({
  documentUrl: 'about:blank', outerWindow: { width: 1280, height: 900 }, viewport: { width: 1280, height: 813 },
  deviceScaleFactor: 1, language: 'zh-CN', languages: ['zh-CN', 'zh'], intlLocale: 'zh-CN',
  timeZone: 'Asia/Shanghai', userAgent: 'HeadlessChrome/test', platform: 'Win32', colorScheme: 'light', maxTouchPoints: 0
});

// This drives the real preparation entrypoint and temporary files. Only the
// worker/CLI process boundaries are replaced; no browser or model is started.
function runtime(options = {}) {
  const state = { controls: [], commands: [], completed: false };
  const requestBrowserGateway = async (request, configuration) => {
    assert.equal(configuration.homeDir, path.join(state.root, 'home'));
    state.controls.push(request.action);
    if (request.action === 'launch-profile') {
      state.launch = request;
      const launchArgs = [...request.args, '--remote-debugging-pipe'];
      if (options.changedLaunch) launchArgs.splice(launchArgs.indexOf('--disable-extensions'), 1);
      await writeFile(path.join(state.root, 'diagnostics.json'), JSON.stringify({ chromePid: 12345, launchArgs }));
      return { ok: true, profile: { profileId: request.profileId } };
    }
    if (request.action === 'status') return { ok: true, protocolVersion: 19, state: { profiles: [{ profileId: state.launch.profileId, chromePid: 12345 }] } };
    if (request.action === 'unregister-profile' && options.cleanupError) throw Error('synthetic cleanup failure');
    return { ok: true };
  };
  class ProfileManager {
    constructor(data) { state.data = data; }
    async createProfile() {
      await mkdir(path.join(state.data, 'profiles/fresh'), { recursive: true });
      if (options.reusedProfile) await writeFile(path.join(state.data, 'profiles/fresh/Cookies'), 'preexisting');
      return { id: 'synthetic', dirName: 'fresh', name: 'Synthetic fixture' };
    }
    async prepareProfileForAgent(id) { assert.equal(id, 'isolated:synthetic'); return 19432; }
  }
  return { state, dependencies: {
    built(name) {
      const modules = {
        'browser-gateway-client': { requestBrowserGateway },
        'tasks/browser-runtime': { bundledBrowserExecutable: () => path.resolve('dist/browser-runtime/profilepilot-browser-engine.cjs') },
        'profile-manager': { ProfileManager },
        'chrome-launch': { getDirectChromeCommand: () => path.resolve('synthetic-browser') },
        'agent-browser-lease': { retireAgentBrowserSessionSync: () => true }
      };
      assert.ok(modules[name], `Unexpected built dependency: ${name}`);
      return modules[name];
    },
    async launchWorker(root, env) {
      state.root = root;
      assert.equal(env.PROFILEPILOT_GATEWAY_HOME, path.join(root, 'home'));
      assert.equal(Object.hasOwn(env, 'HOME'), false);
      assert.equal(Object.hasOwn(env, 'USERPROFILE'), false);
      return 12344;
    },
    isAlive: () => false, pause: async () => {}, browserBinaryVersion: async () => '156.0.test',
    async exec(executable, argv) {
      assert.equal(executable, process.execPath);
      assert.ok(argv.includes('verification'));
      assert.equal(argv[argv.indexOf('--cdp') + 1], '19432');
      const session = argv[argv.indexOf('--session') + 1];
      assert.match(session, /^pp-eval-preflight-/);
      const args = argv.slice(argv.indexOf('--json') + 1);
      state.commands.push(args);
      const output = value => ({ stdout: JSON.stringify(value), stderr: '' });
      if (args[0] === 'status') return output({ ok: true, profile: { profileId: 'isolated:synthetic', ownerSessionId: session, ownership: options.takeover ? 'user' : 'agent' } });
      if (args[0] === 'open' || args[0] === 'get') return output({ success: true, data: { url: 'about:blank' } });
      if (args[0] === 'complete') { state.completed = true; return output({ ok: true }); }
      if (args[0] === 'cookies') return output({ success: true, data: { cookies: options.cookies || [] } });
      if (args[0] === 'cdp' && args[2] === 'Runtime.evaluate') {
        assert.deepEqual(args.slice(0, 4), ['cdp', 'call', 'Runtime.evaluate', '--params']);
        const params = JSON.parse(args[4]);
        assert.deepEqual(params, JSON.parse(await readFile(path.join(state.root, 'environment-probe.json'), 'utf8')));
        assert.equal(params.returnByValue, true);
        assert.match(params.expression, /navigator\.language/);
        assert.match(params.expression, /innerHeight/);
        assert.equal(params.expression.includes('fetch('), false);
        return output({ ok: true, result: { result: { type: 'string', value: JSON.stringify({ ...browserReadback(), ...options.observed }) }, ...(options.probeException ? { exceptionDetails: { text: 'probe failed' } } : {}) } });
      }
      if (args[0] === 'cdp' && args[2] === 'Target.getTargets') return output({ ok: true, result: { targetInfos: options.targets || [{ url: 'about:blank', type: 'page' }] } });
      throw Error(`Unexpected CLI operation ${JSON.stringify(args)}`);
    }
  } };
}

test('real preparation entrypoint pins launch flags and reads native viewport separately', async () => {
  const original = environment(), fake = runtime();
  const gateway = await startEvaluationGateway({}, fake.dependencies);
  try {
    assert.deepEqual(gateway.metadata.environmentContract, evaluationEnvironmentContract());
    assert.deepEqual(gateway.metadata.observedEnvironment.viewport, { width: 1280, height: 813 });
    assert.deepEqual(gateway.metadata.environmentContract.window, { width: 1280, height: 900 });
    assert.equal(gateway.metadata.environmentContract.timezone, 'host-observed');
    assert.equal(gateway.metadata.observedEnvironment.timeZone, 'Asia/Shanghai');
    assert.equal(gateway.metadata.environmentChecks.every(check => check.passed), true);
    assert.ok(gateway.metadata.environmentChecks.every(check => Object.hasOwn(check, 'expected') && Object.hasOwn(check, 'actual')));
    for (const flag of ['--disable-extensions', '--disable-sync', '--no-proxy-server', '--window-size=1280,900', '--force-device-scale-factor=1', '--lang=zh-CN', '--headless=new']) assert.ok(fake.state.launch.args.includes(flag));
    assert.equal(fake.state.completed, true);
    assert.equal(fake.state.commands.some(args => ['resume', 'eval', 'set'].includes(args[0])), false);
  } finally { await gateway.close(); }
  assert.deepEqual(environment(), original);
  assert.equal(existsSync(gateway.root), false);
  assert.deepEqual(fake.state.controls.slice(-2), ['unregister-profile', 'shutdown']);
});

test('macOS readback records real locale, timezone and viewport without pretending they are Windows values', async () => {
  const fake = runtime({ observed: { platform: 'MacIntel', timeZone: 'America/Los_Angeles', viewport: { width: 1280, height: 812 } } });
  const gateway = await startEvaluationGateway({}, fake.dependencies);
  try {
    assert.equal(gateway.metadata.observedEnvironment.platform, 'MacIntel');
    assert.equal(gateway.metadata.observedEnvironment.timeZone, 'America/Los_Angeles');
    assert.equal(gateway.metadata.observedEnvironment.viewport.height, 812);
  } finally { await gateway.close(); }
});

for (const [name, options, key] of [
  ['locale drift', { observed: { language: 'en-US' } }, 'language'],
  ['window drift', { observed: { outerWindow: { width: 1024, height: 768 } } }, 'window-width'],
  ['DPR drift', { observed: { deviceScaleFactor: 2 } }, 'device-scale-factor'],
  ['existing cookies', { cookies: [{ name: 'synthetic-existing-session' }] }, 'initial-cookie-count'],
  ['active extension', { targets: [{ url: 'chrome-extension://synthetic/background.js', type: 'service_worker' }] }, 'active-extension-targets'],
  ['changed actual launch flags', { changedLaunch: true }, 'launch-arguments']
]) test(`${name} fails before the model, exposes evidence and cleans up`, async () => {
  const original = environment(), fake = runtime(options);
  await assert.rejects(startEvaluationGateway({}, fake.dependencies), error => {
    assert.equal(error.environmentContract.language, 'zh-CN');
    assert.ok(error.observedEnvironment);
    assert.equal(error.preflightChecks.find(check => check.key === key)?.passed, false);
    return true;
  });
  assert.equal(fake.state.completed, false);
  assert.equal(existsSync(fake.state.root), false);
  assert.deepEqual(fake.state.controls.slice(-2), ['unregister-profile', 'shutdown']);
  assert.deepEqual(environment(), original);
});

test('probe exceptions and takeover never auto-resume or complete the session', async () => {
  for (const options of [{ probeException: true }, { takeover: true }]) {
    const fake = runtime(options);
    await assert.rejects(startEvaluationGateway({}, fake.dependencies), /readback failed|exclusive ownership/);
    assert.equal(fake.state.commands.some(args => ['resume', 'complete'].includes(args[0])), false);
    assert.equal(existsSync(fake.state.root), false);
  }
});

test('reused Profile is rejected and cleanup failures retain the original mismatch evidence', async () => {
  const reused = runtime({ reusedProfile: true });
  await assert.rejects(startEvaluationGateway({}, reused.dependencies), /empty freshly created Profile/);
  assert.equal(reused.state.controls.includes('launch-profile'), false);
  assert.equal(existsSync(reused.state.root), false);
  const fake = runtime({ observed: { language: 'en-US' }, cleanupError: true }), original = environment();
  await assert.rejects(startEvaluationGateway({}, fake.dependencies), error => {
    assert.match(error.cleanupError, /synthetic cleanup failure/);
    assert.equal(error.observedEnvironment.language, 'en-US');
    return true;
  });
  assert.deepEqual(environment(), original);
  assert.equal(existsSync(fake.state.root), false);
  assert.equal(fake.state.controls.at(-1), 'shutdown');
});

test('headed mode is explicit and only accepts an absolute fresh-profile location', () => {
  const contract = evaluationEnvironmentContract({ headless: false });
  assert.equal(contract.browserMode, 'headed');
  const args = evaluationChromeArguments(path.resolve('synthetic-profile'), contract);
  assert.equal(args.includes('--headless=new'), false);
  assert.ok(args.includes('--window-size=1280,900'));
  assert.throws(() => evaluationChromeArguments('relative-profile'), /absolute/);
  assert.throws(() => evaluationEnvironmentContract({ headless: 'false' }), /boolean/);
});
