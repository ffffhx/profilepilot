import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { buildWindowsCimInvocation, quoteWindowsArgument } from '../../../scripts/start-independent.mjs';

const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const built = name => require(path.join(repo, 'dist/main', name));
const exec = promisify(execFile);
let activeFixture;
const entry = fileURLToPath(import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

export function evaluationEnvironmentContract({ headless = true } = {}) {
  if (typeof headless !== 'boolean') throw Error('headless must be boolean');
  return {
    schemaVersion: 1, route: 'gateway', profile: 'fresh-per-cell', loginReuse: false,
    extensions: 'disabled', proxy: 'direct', sync: false, browserMode: headless ? 'headless' : 'headed',
    window: { width: 1280, height: 900 }, deviceScaleFactor: 1, language: 'zh-CN',
    viewport: 'observed-native', timezone: 'host-observed'
  };
}

export function evaluationChromeArguments(userDataDir, contract = evaluationEnvironmentContract()) {
  if (!path.isAbsolute(userDataDir)) throw Error('Evaluation Profile directory must be absolute');
  return [`--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-background-networking', '--disable-extensions',
    '--disable-component-extensions-with-background-pages', '--disable-component-update', '--disable-default-apps',
    '--no-proxy-server', `--window-size=${contract.window.width},${contract.window.height}`,
    `--force-device-scale-factor=${contract.deviceScaleFactor}`, `--lang=${contract.language}`,
    '--enable-logging=stderr', ...(contract.browserMode === 'headless' ? ['--headless=new'] : []), 'about:blank'];
}

const ENVIRONMENT_EXPRESSION = `JSON.stringify({
  documentUrl: location.href,
  outerWindow: {width: outerWidth, height: outerHeight},
  viewport: {width: innerWidth, height: innerHeight},
  deviceScaleFactor: devicePixelRatio,
  language: navigator.language, languages: Array.from(navigator.languages),
  intlLocale: Intl.DateTimeFormat().resolvedOptions().locale,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  userAgent: navigator.userAgent, platform: navigator.platform,
  colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  maxTouchPoints: navigator.maxTouchPoints
})`;

function environmentFailure(message, environmentContract, observedEnvironment, checks = []) {
  return Object.assign(new Error(message), { environmentContract, observedEnvironment, preflightChecks: checks });
}

// Host-only readback using the same guarded CLI and preflight session. The
// model's command allowlist remains unchanged and exposes neither CDP nor JS.
export async function inspectEvaluationEnvironment(command, { root, contract, launchArgs, expectedLaunchArgs, freshProfile }) {
  let observed = { freshProfile, launchArgumentsVerified: false };
  const checks = [];
  const check = (key, expected, actual, passed = JSON.stringify(expected) === JSON.stringify(actual)) => checks.push({ key, passed, expected, actual });
  try {
    const expected = [...expectedLaunchArgs, '--remote-debugging-pipe'];
    observed.launchArgumentsVerified = Array.isArray(launchArgs) && JSON.stringify(launchArgs) === JSON.stringify(expected);
    check('fresh-profile', true, freshProfile);
    check('launch-arguments', true, observed.launchArgumentsVerified);
    if (checks.some(item => !item.passed)) throw Error('Isolated Profile launch does not match the environment contract');
    const paramsPath = path.join(root, 'environment-probe.json');
    const params = JSON.stringify({ expression: ENVIRONMENT_EXPRESSION, returnByValue: true, awaitPromise: false });
    await writeFile(paramsPath, params, { flag: 'wx', mode: 0o600 });
    // The Gateway raw bridge supports --params and --params-stdin, not the
    // common action contract's --params-file. This is one shell:false argv.
    const response = await command(['cdp', 'call', 'Runtime.evaluate', '--params', params]);
    if (response?.ok !== true || response.result?.exceptionDetails || typeof response.result?.result?.value !== 'string') throw Error('Environment readback failed or returned an invalid CDP envelope');
    const value = JSON.parse(response.result.result.value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid environment readback value');
    observed = { ...observed, ...value };
    const targets = await command(['cdp', 'call', 'Target.getTargets']);
    if (targets?.ok !== true || !Array.isArray(targets.result?.targetInfos)) throw Error('Extension target inspection failed');
    observed.extensionTargetCount = targets.result.targetInfos.filter(target => typeof target.url === 'string' && target.url.startsWith('chrome-extension://')).length;
    const cookies = await command(['cookies', 'get']);
    if (cookies?.success !== true || !Array.isArray(cookies.data?.cookies)) throw Error('Initial cookie inspection failed');
    observed.cookieCount = cookies.data.cookies.length;
    check('initial-url', 'about:blank', observed.documentUrl);
    check('window-width', contract.window.width, observed.outerWindow?.width);
    check('window-height', contract.window.height, observed.outerWindow?.height);
    check('device-scale-factor', contract.deviceScaleFactor, observed.deviceScaleFactor);
    check('language', contract.language, observed.language);
    check('preferred-language', contract.language, observed.languages?.[0]);
    check('viewport-readable', 'positive finite native dimensions', observed.viewport,
      Number.isFinite(observed.viewport?.width) && observed.viewport.width > 0 && Number.isFinite(observed.viewport?.height) && observed.viewport.height > 0);
    check('intl-locale-readable', 'nonempty string', observed.intlLocale, typeof observed.intlLocale === 'string' && !!observed.intlLocale);
    check('timezone-readable', 'nonempty string (host-observed)', observed.timeZone, typeof observed.timeZone === 'string' && !!observed.timeZone);
    check('active-extension-targets', 0, observed.extensionTargetCount);
    check('initial-cookie-count', 0, observed.cookieCount);
    if (checks.some(item => !item.passed)) throw Error(`Evaluation environment mismatch: ${checks.filter(item => !item.passed).map(item => item.key).join(', ')}`);
    return { observedEnvironment: observed, checks };
  } catch (error) {
    throw environmentFailure(error.message, contract, observed, checks);
  }
}

async function gatewayWorker(root) {
  const config = JSON.parse(await readFile(path.join(root, 'worker.json'), 'utf8'));
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('pp-eval-gateway-') || config.environment.PROFILEPILOT_GATEWAY_HOME !== path.join(root, 'home')) throw Error('Invalid isolated Gateway worker directory');
  Object.assign(process.env, config.environment);
  delete process.env.CHROME_CRASHPAD_PIPE_NAME;
  const { BrowserGatewayDaemon } = built('browser-gateway-daemon');
  const daemon = new BrowserGatewayDaemon(config.environment.PROFILEPILOT_GATEWAY_HOME);
  const diagnostics = { chromeStderr: '', chromeExit: null };
  let saving = Promise.resolve();
  const save = () => { const value = JSON.stringify(diagnostics); saving = saving.then(() => writeFile(path.join(root, 'diagnostics.json'), value)).catch(() => {}); };
  const register = daemon.gateway.registerBackend.bind(daemon.gateway);
  daemon.gateway.registerBackend = async input => {
    const child = input.backend.child;
    diagnostics.chromePid = child?.pid;
    diagnostics.launchArgs = child?.spawnargs?.slice(1);
    child?.stderr?.setEncoding('utf8');
    child?.stderr?.on('data', chunk => { diagnostics.chromeStderr = (diagnostics.chromeStderr + chunk).slice(-8192); save(); });
    child?.on('exit', (code, signal) => { diagnostics.chromeExit = { code, signal }; save(); });
    save();
    return register(input);
  };
  const shutdown = () => { void daemon.stop().finally(() => process.exit(0)); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  await daemon.start();
  await writeFile(path.join(root, 'worker-ready.json'), JSON.stringify({ pid: process.pid, token: config.token }));
  // A runner crash must not leave a disposable browser behind. This only
  // checks the private fixture lease; it never resumes a user-owned session.
  setInterval(async () => {
    if (!alive(config.parentPid) || !await readFile(path.join(root, 'worker.json'), 'utf8').then(value => JSON.parse(value).token === config.token).catch(() => false)) shutdown();
  }, 1000).unref();
}

async function launchWorker(root, environment) {
  const token = randomUUID();
  await writeFile(path.join(root, 'worker.json'), JSON.stringify({ token, parentPid: process.pid, environment }), { mode: 0o600 });
  const args = [entry, '--worker', root];
  if (process.platform === 'win32') {
    const literal = value => `'${String(value).replaceAll("'", "''")}'`;
    const bootstrapScript = `$ErrorActionPreference='Stop'\n$env:ELECTRON_RUN_AS_NODE='1'\nStart-Process -FilePath ${literal(process.execPath)} -ArgumentList ${literal(args.map(quoteWindowsArgument).join(' '))} -WorkingDirectory ${literal(repo)} -WindowStyle Hidden`;
    const powershellPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const invocation = buildWindowsCimInvocation({ bootstrapScript, powershellPath });
    const started = spawnSync(invocation.executable, invocation.args, { windowsHide: true, shell: false, encoding: 'utf8', timeout: 15000 });
    if (started.error || started.status !== 0) throw Error(started.error?.message || started.stderr || 'Could not launch independent Gateway worker');
  } else {
    const child = spawn(process.execPath, args, { cwd: repo, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, shell: false, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = await readFile(path.join(root, 'worker-ready.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (ready?.token === token && Number.isSafeInteger(ready.pid) && alive(ready.pid)) return ready.pid;
    const error = await readFile(path.join(root, 'worker-error.txt'), 'utf8').catch(() => '');
    if (error) throw Error(error);
    await pause(100);
  }
  throw Error('Independent Gateway worker did not become ready');
}

async function browserBinaryVersion(executable) {
  try {
    if (process.platform === 'win32') {
      const literal = `'${executable.replaceAll("'", "''")}'`;
      const script = `[Diagnostics.FileVersionInfo]::GetVersionInfo(${literal}).FileVersion`;
      const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
      const { stdout } = await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
      return stdout.trim() || 'unknown';
    }
    if (process.platform === 'darwin') {
      const plist = path.join(path.dirname(path.dirname(executable)), 'Info.plist');
      const { stdout } = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], { timeout: 5000, encoding: 'utf8' });
      return stdout.trim() || 'unknown';
    }
  } catch { /* Version metadata must not launch another browser. */ }
  return 'unknown';
}

// This helper owns its entire disposable registry and Gateway. All browser
// commands still pass through the normal ProfilePilot control protocol.
export async function startEvaluationGateway({ headless = true } = {}, dependencies = {}) {
  if (activeFixture) throw Error('Evaluation Gateways in one process must run sequentially');
  const contract = evaluationEnvironmentContract({ headless });
  const runtime = { built, exec, launchWorker, isAlive: alive, pause, browserBinaryVersion, ...dependencies };
  const identity = Symbol('evaluation gateway'); activeFixture = identity;
  let root, workerPid, port, closed = false;
  const original = {};
  let home, engineRoot, id, requestBrowserGateway, observedEnvironment, environmentChecks;
  const restore = () => {
    for (const [key, value] of Object.entries(original)) value === undefined ? delete process.env[key] : process.env[key] = value;
    if (activeFixture === identity) activeFixture = undefined;
  };
  const close = async () => {
    if (closed) return; closed = true;
    const errors = [];
    try {
      if (workerPid && port && home) await requestBrowserGateway({ action: 'unregister-profile', publicPort: port, closeChrome: true }, { homeDir: home, timeoutMs: 10000 }).catch(error => errors.push(error.message));
      if (workerPid) {
        await requestBrowserGateway({ action: 'shutdown' }, { homeDir: home, timeoutMs: 10000 }).catch(error => errors.push(error.message));
        for (let attempt = 0; attempt < 50 && runtime.isAlive(workerPid); attempt++) await runtime.pause(100);
        if (runtime.isAlive(workerPid)) {
          if (process.platform === 'win32') await runtime.exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(workerPid), '/T', '/F'], { windowsHide: true, timeout: 10000 }).catch(error => errors.push(error.message));
          else try { process.kill(-workerPid, 'SIGTERM'); } catch (error) { errors.push(error.message); }
        }
      }
      // A killed adapter may leave its engine alive. Only retire identities
      // discovered inside this fixture's private engine directory.
      if (engineRoot) {
        const { retireAgentBrowserSessionSync } = runtime.built('agent-browser-lease');
        for (const filename of await readdir(engineRoot).catch(() => [])) {
          if (!filename.endsWith('.engine.json')) continue;
          try {
            const record = JSON.parse(await readFile(path.join(engineRoot, filename), 'utf8'));
            if (record.root !== engineRoot || filename !== `${record.session}.engine.json` || !/^pp-eval-[A-Za-z0-9._-]+$/.test(record.session)) continue;
            if (!retireAgentBrowserSessionSync(record.session, record.pid, home)) errors.push(`Could not retire isolated engine ${record.session}`);
          } catch (error) { errors.push(error.message); }
        }
      }
    } finally {
      restore();
      if (root && path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('pp-eval-gateway-')) {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(error => errors.push(error.message));
      }
    }
    if (errors.length) throw Error(`Isolated Gateway cleanup failed: ${errors.join('; ')}`);
  };
  try {
    ({ requestBrowserGateway } = runtime.built('browser-gateway-client'));
    root = await mkdtemp(path.join(os.tmpdir(), 'pp-eval-gateway-'));
    home = path.join(root, 'home'); engineRoot = path.join(home, '.agent-browser');
    const data = path.join(root, 'data');
    await mkdir(home, { recursive: true });
    const { bundledBrowserExecutable } = runtime.built('tasks/browser-runtime');
    const overrides = {
      CPM_DATA_DIR: data, PROFILEPILOT_GATEWAY_HOME: home,
      AGENT_BROWSER_SOCKET_DIR: engineRoot, PROFILEPILOT_AGENT_BROWSER_REAL: bundledBrowserExecutable(),
      CPM_E2E_DISPOSABLE_PROFILES: '1'
    };
    // Windows shell folders remain untouched; explicit paths below avoid the
    // Windows os.homedir() / HOME difference without changing USERPROFILE.
    for (const [key, value] of Object.entries(overrides)) { original[key] = process.env[key]; process.env[key] = value; }
    const { ProfileManager } = runtime.built('profile-manager');
    const manager = new ProfileManager(data);
    const profile = await manager.createProfile('Agent benchmark fixture');
    id = `isolated:${profile.id}`;
    port = await manager.prepareProfileForAgent(id);
    workerPid = await runtime.launchWorker(root, overrides);
    const { getDirectChromeCommand } = runtime.built('chrome-launch');
    const executable = getDirectChromeCommand();
    if (!executable) throw Error('Chrome executable is unavailable');
    const userDataDir = path.join(data, 'profiles', profile.dirName);
    if (path.relative(data, userDataDir).startsWith('..')) throw Error('Fixture Profile escaped its data directory');
    const freshProfile = (await readdir(userDataDir)).length === 0;
    if (!freshProfile) throw environmentFailure('Evaluation requires an empty freshly created Profile', contract, { freshProfile });
    const launchArgs = evaluationChromeArguments(userDataDir, contract);
    const launched = await requestBrowserGateway({ action: 'launch-profile', profileId: id, profileName: profile.name, publicPort: port, executable,
      args: launchArgs
    }, { homeDir: home, timeoutMs: 10000 });
    if (!launched.ok || launched.profile?.profileId !== id) throw Error('Isolated Gateway did not register the created Profile');
    await runtime.pause(1000);
    const launchDiagnostic = await readFile(path.join(root, 'diagnostics.json'), 'utf8').then(JSON.parse).catch(() => ({}));
    if (launchDiagnostic.chromeExit) throw Error('Isolated Chrome exited before CLI preflight');
    const session = `pp-eval-preflight-${randomUUID()}`;
    const cli = path.join(repo, 'dist/main/profilepilot-cli.cjs');
    const command = async args => {
      const { stdout } = await runtime.exec(process.execPath, [cli, '--task-kind', 'verification', '--task-id', session, '--operation-id', randomUUID(),
        'browser', '--session', session, '--cdp', String(port), '--json', ...args], {
        cwd: repo, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024, encoding: 'utf8'
      });
      return JSON.parse(stdout.trim());
    };
    await command(['open', 'about:blank']);
    const status = await command(['status']);
    if (status.profile?.profileId !== id || status.profile?.ownerSessionId !== session || status.profile?.ownership !== 'agent') throw Error('Preflight did not retain exclusive ownership of the isolated Profile');
    const location = await command(['get', 'url']);
    if (location.data?.url !== 'about:blank') throw Error('Preflight did not observe the isolated blank page');
    const inspected = await inspectEvaluationEnvironment(command, { root, contract, launchArgs: launchDiagnostic.launchArgs, expectedLaunchArgs: launchArgs, freshProfile });
    observedEnvironment = inspected.observedEnvironment;
    environmentChecks = inspected.checks;
    // Browser.getVersion is deliberately outside the CLI raw-CDP allowlist.
    // Read the executable's metadata instead of issuing a rejected operation
    // or launching a second Chrome instance just for its version.
    const chromeVersion = await runtime.browserBinaryVersion(executable);
    await command(['complete']);
    const state = await requestBrowserGateway({ action: 'status' }, { homeDir: home });
    const binding = state.state?.profiles?.find(item => item.profileId === id);
    if (!binding || binding.ownerSessionId) throw Error('Preflight did not release its own session');
    return { id, name: profile.name, port, home, root, close, browser: { mode: headless ? 'headless' : 'headed', version: chromeVersion }, metadata: {
      profileId: id, logicalPort: port, gatewayProtocol: state.protocolVersion ?? 'unknown',
      chromeVersion, chromeVersionSource: chromeVersion === 'unknown' ? 'unavailable' : 'launched-executable-metadata',
      gatewayPid: workerPid, chromePid: binding.chromePid, browserMode: headless ? 'headless' : 'headed', viewport: observedEnvironment.viewport, isolation: 'fresh-managed-profile',
      environmentContract: contract, observedEnvironment, environmentChecks
    } };
  } catch (error) {
    const diagnostics = root ? await readFile(path.join(root, 'diagnostics.json'), 'utf8').then(JSON.parse).catch(() => ({})) : {};
    let cleanupError;
    try { await close(); } catch (failure) { cleanupError = failure.message; }
    const detail = error.stderr || error.message;
    throw Object.assign(Error(`Evaluation Gateway preparation failed: ${detail}\n${JSON.stringify({ diagnostics, cleanupError })}`), {
      environmentContract: error.environmentContract || contract,
      observedEnvironment: error.observedEnvironment || observedEnvironment,
      preflightChecks: error.preflightChecks || environmentChecks,
      ...(cleanupError ? { cleanupError } : {})
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === entry && process.argv[2] === '--worker') {
  const root = path.resolve(process.argv[3] || '');
  gatewayWorker(root).catch(async error => {
    if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('pp-eval-gateway-')) await writeFile(path.join(root, 'worker-error.txt'), String(error.stack || error)).catch(() => {});
    process.exit(1);
  });
}
