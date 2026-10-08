// Installation integration fixture only. Owns a new empty Chrome user-data-dir;
// never points at, copies, or closes the user's daily Chrome Profile.
// --manual opens a visible disposable Chrome for one genuine Load unpacked step.
// After that step, the same script verifies restarts/reload/upgrade automatically.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
const require = createRequire(import.meta.url);
const manual = process.argv.includes('--manual');
const outputFlag = process.argv.indexOf('--out');
const output = path.resolve(outputFlag >= 0 ? process.argv[outputFlag + 1] : 'artifacts/native-install-lifecycle');
const root = await mkdtemp(path.join(os.tmpdir(), 'pp-install-lifecycle-'));
const chromeData = path.join(root, 'chrome'); const compiled = path.join(root, 'compiled');
const source = path.join(root, 'source'); const destination = path.join(root, 'extension');
await mkdir(output, { recursive: true }); await mkdir(chromeData);
await cp(path.resolve('extensions/profilepilot'), source, { recursive: true });
await build({ entryPoints: ['src/main/tasks/native-installer.ts', 'src/main/tasks/native-bridge.ts', 'src/main/tasks/native-extension-maintenance.ts', 'src/main/cdp-client.ts', 'src/main/chrome-launch.ts'], entryNames: '[name]', outdir: compiled, bundle: true, platform: 'node', format: 'cjs', external: ['agent-browser/package.json'] });
const { NativeExtensionInstaller, parseNativeDebugEndpoint } = require(path.join(compiled, 'native-installer.js'));
const { NativeBrowserBridge, NATIVE_EXTENSION_ID } = require(path.join(compiled, 'native-bridge.js'));
const { startNativeExtensionMaintenance } = require(path.join(compiled, 'native-extension-maintenance.js'));
const { CdpBrowserClient } = require(path.join(compiled, 'cdp-client.js'));
const { getDirectChromeCommand } = require(path.join(compiled, 'chrome-launch.js'));
let child, client, bridge, endpoint, saved = {}, stopMaintenance;
const vault = { read: () => saved, write: value => { saved = value; } };
const installer = new NativeExtensionInstaller({ source, destination, userDataDir: chromeData, extensionId: NATIVE_EXTENSION_ID, openSettings: async () => { throw Error('Isolated tests must not prompt in daily Chrome'); } });
const prepared = await installer.prepare();
const fixture = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><title>ProfilePilot durable installation fixture</title><h1>ProfilePilot isolated installation test</h1><p>Load unpacked once from this directory, then leave this window open:</p><pre>' + prepared.extensionPath.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]) + '</pre>'); });
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
const until = async (fn, description, timeout = 45000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 150)); }
  throw Error(description);
};
async function startChrome(url) {
  await rm(path.join(chromeData, 'DevToolsActivePort'), { force: true });
  child = spawn(getDirectChromeCommand(), [`--user-data-dir=${chromeData}`, ...manual ? [] : ['--headless=new'], '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', url], { windowsHide: true, stdio: 'ignore' });
  const failed = new Promise((_, reject) => child.once('error', reject));
  endpoint = await Promise.race([failed, until(async () => { try { return parseNativeDebugEndpoint(await readFile(path.join(chromeData, 'DevToolsActivePort'), 'utf8')); } catch { return undefined; } }, 'Isolated Chrome startup timed out')]);
  client = await CdpBrowserClient.connect(endpoint, 10000);
}
async function closeChrome() {
  if (!client) client = await CdpBrowserClient.connect(endpoint, 5000);
  const exit = child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve));
  await client.send('Browser.close', {}, 5000).catch(() => {}); client.close(); client = undefined;
  await Promise.race([exit, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Chrome did not exit')), 10000); timer.unref(); })]);
}
async function startBridge() {
  bridge = new NativeBrowserBridge(path.join(root, 'bridge'), vault); await bridge.start();
  bridge.configureInstallation(installer, () => {});
}
async function closeBridge() {
  const closed = new Promise(resolve => bridge.server.once('close', resolve));
  bridge.close(); bridge.server.closeAllConnections(); await closed;
}
async function pair(invitation) {
  const popup = await until(async () => (await client.send('Target.getTargets')).targetInfos.find(t => t.url.startsWith(`chrome-extension://${NATIVE_EXTENSION_ID}/popup.html#setup=`)), 'Installed extension did not claim onboarding invitation');
  const { sessionId } = await client.send('Target.attachToTarget', { targetId: popup.targetId, flatten: true });
  await until(async () => (await client.send('Runtime.evaluate', { expression: 'Boolean(document.querySelector("#code")?.value)', returnByValue: true }, 5000, sessionId)).result.value, 'Pairing page did not initialize');
  const shot = await client.send('Page.captureScreenshot', { format: 'png' }, 5000, sessionId);
  await writeFile(path.join(output, 'initial-pairing.png'), Buffer.from(shot.data, 'base64'));
  await client.send('Runtime.evaluate', { expression: 'document.querySelector("#connect").requestSubmit()', returnByValue: true }, 5000, sessionId);
  await until(() => bridge.states().some(s => s.connected && s.extensionVersion), 'Initial user confirmation did not connect');
  assert.equal(bridge.installationStates().at(-1).stage, 'connected');
  assert.ok(saved['native:Default']);
}
const evidence = { platform: process.platform, arch: process.arch, mode: manual ? 'manual-unpacked' : 'temporary-cdp', extensionId: NATIVE_EXTENSION_ID,
  extensionVersion: prepared.version, extensionDigest: prepared.digest, testedAt: new Date().toISOString(), checks: [] };
try {
  await startBridge();
  const invitation = await bridge.authorize('native:Default', 'Isolated installation fixture');
  await startChrome(manual ? fixtureUrl : invitation.url);
  evidence.browser = (await client.send('Browser.getVersion')).product;
  if (manual) {
    await client.send('Target.createTarget', { url: invitation.url, background: true });
    await writeFile(path.join(output, 'manual-runtime.json'), JSON.stringify({ pid: child.pid, chromeData, extensionPath: prepared.extensionPath, fixtureUrl }, null, 2));
    console.log('WAIT genuine Load unpacked in disposable Chrome:', prepared.extensionPath);
    await until(async () => (await client.send('Extensions.getExtensions')).extensions.some(e => e.id === NATIVE_EXTENSION_ID), 'Manual installation was not completed within ten minutes', 600000);
  } else {
    client.close(); client = undefined;
    await installer.install({ url: invitation.url, profileId: 'native:Default', signal: AbortSignal.timeout(60000), report: p => console.log('INSTALL', p.stage) });
    client = await CdpBrowserClient.connect(endpoint, 5000);
  }
  await pair(invitation); evidence.checks.push('initial-install-and-pair'); console.log('PASS initial install and pairing');
  // App restart: retain only the same protected credential store and listener file.
  await closeBridge(); await startBridge();
  await until(() => bridge.states().some(s => s.connected && s.extensionVersion), 'Extension did not reconnect after app restart', 60000);
  evidence.checks.push('app-restart-without-repair-or-confirmation'); console.log('PASS app restart automatically reconnects');
  const beforeReload = saved['native:Default'];
  if (manual) {
    await bridge.request('native:Default', 'extension.reload', {});
    await until(() => !bridge.states().some(s => s.connected), 'Reload did not disconnect');
    await until(() => bridge.states().some(s => s.connected && s.extensionVersion), 'Reload did not reconnect');
    assert.equal(saved['native:Default'], beforeReload); evidence.checks.push('reload-preserves-pairing'); console.log('PASS extension reload preserves pairing');
  } else {
    assert.equal(bridge.states()[0].installationMode, 'temporary');
    await assert.rejects(bridge.request('native:Default', 'extension.reload', {}), /临时|temporary/);
    assert.ok((await client.send('Extensions.getExtensions')).extensions.some(e => e.id === NATIVE_EXTENSION_ID && e.enabled));
    evidence.checks.push('temporary-reload-blocked-without-disabling'); console.log('PASS temporary reload reports repair guidance and stays enabled');
  }
  // Replacing files at the stable directory must update a loaded extension.
  const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
  const parts = manifest.version.split('.').map(Number); parts[parts.length - 1]++; manifest.version = parts.join('.');
  await writeFile(path.join(source, 'manifest.json'), JSON.stringify(manifest, null, 2));
  assert.equal((await installer.prepare()).extensionPath, prepared.extensionPath);
  // Exercise the application maintenance hook rather than reloading by test fiat.
  stopMaintenance = startNativeExtensionMaintenance(installer, bridge, error => { console.error('Maintenance:', error.message); });
  if (manual) await until(() => bridge.states().some(s => s.connected && s.extensionVersion === manifest.version), 'Version upgrade did not reload/reconnect');
  else {
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.ok(bridge.states().some(s => s.connected && s.extensionVersion === prepared.version));
  }
  stopMaintenance(); stopMaintenance = undefined;
  assert.equal(saved['native:Default'], beforeReload);
  evidence.checks.push(manual ? 'stable-path-upgrade-and-automatic-reload' : 'temporary-upgrade-defers-reload');
  console.log(manual ? 'PASS stable-path version upgrade and automatic reload' : 'PASS temporary upgrade preserves current connection until explicit reinstall');
  await closeChrome(); await until(() => !bridge.states().some(s => s.connected), 'Closed Chrome stayed connected');
  await startChrome(fixtureUrl);
  const installed = (await client.send('Extensions.getExtensions')).extensions.find(e => e.id === NATIVE_EXTENSION_ID);
  if (manual) {
    assert.ok(installed?.enabled, 'Genuine manual installation must survive Chrome restart');
    await until(() => bridge.states().some(s => s.connected && s.extensionVersion === manifest.version), 'Persistent extension did not reconnect after Chrome restart');
    assert.equal(saved['native:Default'], beforeReload); evidence.checks.push('chrome-restart-persistent-install-and-no-confirmation'); console.log('PASS Chrome restart retains manual installation and original pairing');
  } else {
    evidence.cdpRetainedAfterRestart = Boolean(installed);
    if (!installed) {
      const next = await bridge.authorize('native:Default', 'Isolated repair fixture');
      await client.send('Target.createTarget', { url: next.url, background: true }); client.close(); client = undefined;
      await installer.install({ url: next.url, profileId: 'native:Default', signal: AbortSignal.timeout(60000), report: () => {} });
      client = await CdpBrowserClient.connect(endpoint, 5000); await pair(next);
      evidence.checks.push('temporary-removal-and-explicit-repair'); console.log('PASS Chrome removes temporary installation; explicit repair succeeds');
    } else evidence.checks.push('temporary-install-retained-by-this-Chrome-build');
  }
  evidence.passed = true;
} catch (error) {
  evidence.passed = false; evidence.error = error.message;
  if (client) {
    try {
      evidence.extensions = (await client.send('Extensions.getExtensions')).extensions.map(e => ({ id: e.id, enabled: e.enabled, version: e.version }));
      for (const name of ['Preferences', 'Secure Preferences']) {
        try {
          const preferences = JSON.parse(await readFile(path.join(chromeData, 'Default', name), 'utf8'));
          const item = preferences.extensions?.settings?.[NATIVE_EXTENSION_ID];
          if (item) evidence[name] = { disableReasons: item.disable_reasons, location: item.location, creationFlags: item.creation_flags, wasInstalledByDefault: item.was_installed_by_default };
        } catch {}
      }
      const targets = (await client.send('Target.getTargets')).targetInfos;
      evidence.targets = targets.map(t => ({ type: t.type, url: t.url.replace(/\/profilepilot-connect\/[a-f0-9]{48}/g, '/profilepilot-connect/<ticket>').replace(/#setup=.*/, '#setup=<ticket>') }));
      const worker = targets.find(t => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${NATIVE_EXTENSION_ID}/`));
      if (worker) {
        const { sessionId } = await client.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
        evidence.worker = (await client.send('Runtime.evaluate', { expression: '(async()=>({version:chrome.runtime.getManifest().version,savedConnection:Boolean((await chrome.storage.local.get("connection")).connection),alarms:(await chrome.alarms.getAll()).map(a=>a.name)}))()', returnByValue: true, awaitPromise: true }, 5000, sessionId)).result?.value;
      }
    } catch (diagnosticError) { evidence.diagnosticError = diagnosticError.message; }
  }
  throw error;
}
finally {
  stopMaintenance?.();
  await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
  if (client || child?.exitCode === null) await closeChrome().catch(() => { if (child?.exitCode === null) child.kill(); });
  if (bridge) bridge.close(); fixture.closeAllConnections(); fixture.close();
  await rm(path.join(output, 'manual-runtime.json'), { force: true });
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('Refusing cleanup outside test root');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => console.warn('Test-only cleanup deferred:', root));
}
console.log(JSON.stringify({ passed: true, report: path.join(output, 'result.json') }));
