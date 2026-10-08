const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
// Compile only this owner's modules into a private fixture, never shared dist.
const compiled = syncFs.mkdtempSync(path.join(os.tmpdir(), 'pp-install-compile-'));
require('esbuild').buildSync({ entryPoints: ['src/main/tasks/native-installer.ts', 'src/main/tasks/native-onboarding.ts', 'src/main/tasks/native-extension-maintenance.ts'], outdir: compiled, bundle: true, platform: 'node', format: 'cjs' });
const { prepareNativeExtension, NativeExtensionInstaller, nativeExtensionStoreUrl, sameNativeProfilePath } = require(path.join(compiled, 'native-installer.js'));
const { NativeOnboarding } = require(path.join(compiled, 'native-onboarding.js'));
const { startNativeExtensionMaintenance } = require(path.join(compiled, 'native-extension-maintenance.js'));
after(() => fs.rm(compiled, { recursive: true, force: true }));
const id = 'gmdaabnoocjlpimglalnbegfdaklfnaj';

test('maintenance reloads an outdated development extension once after task release and leaves store/user takeover alone', async () => {
  let listener; let prepared = 0; const calls = []; const errors = [];
  const state = { profileId: 'native:Default', connected: true, extensionVersion: '0.2.0', installationType: 'development', ownerSessionId: 'task' };
  const bridge = { states: () => [state], onEvent: fn => { listener = fn; return () => { listener = undefined; }; }, request: async (...args) => { calls.push(args); } };
  const close = startNativeExtensionMaintenance({ prepare: async () => { prepared++; return { version: '0.3.0' }; } }, bridge, error => errors.push(error));
  await new Promise(done => setImmediate(done));
  assert.equal(prepared, 1); assert.equal(calls.length, 0);
  delete state.ownerSessionId; state.pausedByBrowser = true; listener({ type: 'state' }); assert.equal(calls.length, 0);
  state.pausedByBrowser = false; state.installationType = 'normal'; listener({ type: 'state' }); assert.equal(calls.length, 0);
  state.installationType = 'development'; state.installationMode = 'temporary'; listener({ type: 'state' }); assert.equal(calls.length, 0);
  delete state.installationMode; listener({ type: 'state' }); listener({ type: 'state' });
  assert.equal(calls.length, 1); assert.equal(calls[0][1], 'extension.reload');
  state.extensionVersion = '0.4.0'; listener({ type: 'state' }); assert.equal(calls.length, 1);
  assert.deepEqual(errors, []); close(); assert.equal(listener, undefined);
});

test('legacy connections report one repairable upgrade hint per Profile without guessing installation type or reloading', async t => {
  for (const extensionPath of ['C:\\Users\\fixture\\App Data\\native-extension\\current', '/Users/fixture/Library/Application Support/ProfilePilot/native-extension/current']) {
    await t.test(extensionPath, async () => {
      let listener; let finishPreparation; const reports = []; const calls = []; const errors = [];
      const state = { profileId: 'native:Default', connected: false, taskTabs: false };
      const bridge = { states: () => [state], onEvent: fn => { listener = fn; return () => { listener = undefined; }; }, request: async (...args) => { calls.push(args); } };
      const driver = { prepare: () => new Promise(resolve => { finishPreparation = resolve; }), reportMaintenance: (profileId, progress) => reports.push({ profileId, progress }) };
      const stop = startNativeExtensionMaintenance(driver, bridge, error => errors.push(error));
      try {
        finishPreparation({ version: '0.3.0', extensionPath, digest: 'fixture' });
        await new Promise(done => setImmediate(done));
        assert.equal(reports.length, 0);
        state.connected = true; listener({ type: 'state' });
        const hint = reports[0];
        assert.equal(hint.profileId, state.profileId); assert.equal(hint.progress.stage, 'failed');
        assert.equal(hint.progress.extensionPath, extensionPath); assert.equal(hint.progress.version, '0.3.0');
        assert.ok(hint.progress.message.includes(extensionPath)); assert.match(hint.progress.message, /旧版扩展/);
        assert.match(hint.progress.message, /无需卸载或重新配对/);
        assert.equal('mode' in hint.progress, false); assert.equal('installationType' in state, false);
        assert.equal(state.taskTabs, false);
        listener({ type: 'state' }); state.connected = false; listener({ type: 'state' });
        state.connected = true; state.ownerSessionId = 'existing-task'; state.pausedByBrowser = true;
        listener({ type: 'state' }); listener({ type: 'state' });
        assert.equal(reports.length, 1); assert.equal(calls.length, 0); assert.deepEqual(errors, []);
        delete state.ownerSessionId; state.pausedByBrowser = false;
        state.extensionVersion = '0.3.0'; listener({ type: 'state' });
        assert.equal(reports.at(-1).progress, undefined); assert.equal(calls.length, 0);
      } finally { stop(); }
      assert.equal(listener, undefined);
    });
  }
});

test('failed update publishes repair guidance once and stopping suppresses late work', async t => {
  const { source, destination } = await fixture(t);
  const installer = new NativeExtensionInstaller({ source, destination, extensionId: id, userDataDir: destination, openSettings: async () => {} });
  const onboarding = new NativeOnboarding(id); let notifications = 0;
  onboarding.configure(installer, () => { notifications++; });
  let listener; let calls = 0;
  const state = { profileId: 'native:Default', connected: true, extensionVersion: '0.0.1', installationType: 'development' };
  const bridge = { states: () => [state], onEvent: fn => { listener = fn; return () => { listener = undefined; }; }, request: async () => { calls++; throw Error('Reload failed'); } };
  const errors = []; const stop = startNativeExtensionMaintenance(installer, bridge, e => errors.push(e));
  t.after(() => { stop(); onboarding.close(); });
  for (let i = 0; i < 200 && !errors.length; i++) await new Promise(done => setTimeout(done, 5));
  assert.equal(calls, 1); assert.equal(errors.length, 1); assert.ok(notifications > 0);
  assert.equal(onboarding.states()[0].stage, 'failed'); assert.match(onboarding.states()[0].message, /重新加载/);
  listener({ type: 'state' }); assert.equal(calls, 1);
  state.extensionVersion = '99.0.0'; listener({ type: 'state' }); assert.equal(onboarding.states().length, 0);
  stop(); assert.equal(listener, undefined);
  let prepared;
  const lateDriver = { prepare: () => new Promise(resolve => { prepared = resolve; }) };
  const stopLate = startNativeExtensionMaintenance(lateDriver, bridge, () => {}); stopLate();
  prepared({ version: '100.0.0' }); await new Promise(done => setImmediate(done)); assert.equal(calls, 1);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-install-persistence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); const destination = path.join(root, 'native-extension');
  await fs.cp(path.resolve('extensions/profilepilot'), source, { recursive: true });
  return { root, source, destination };
}

test('upgrade, corruption repair and concurrent preparation preserve the loaded path and include nested assets', async t => {
  const { source, destination } = await fixture(t);
  const installer = new NativeExtensionInstaller({ source, destination, extensionId: id, userDataDir: destination, openSettings: async () => {} });
  const first = await installer.prepare();
  assert.equal(first.extensionPath, path.join(destination, 'current'));
  await fs.mkdir(path.join(source, 'nested'), { recursive: true });
  await fs.writeFile(path.join(source, 'nested/new-panel.js'), 'export const fixture = true;');
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'))); manifest.version = '0.99.0';
  await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(first.extensionPath, 'unwanted.js'), 'stale');
  const prepared = await Promise.all(Array.from({ length: 4 }, () => installer.prepare()));
  for (const item of prepared) { assert.equal(item.extensionPath, first.extensionPath); assert.equal(item.version, '0.99.0'); assert.notEqual(item.digest, first.digest); }
  assert.equal(await fs.readFile(path.join(first.extensionPath, 'nested/new-panel.js'), 'utf8'), 'export const fixture = true;');
  await assert.rejects(fs.access(path.join(first.extensionPath, 'unwanted.js')));
  await fs.writeFile(path.join(first.extensionPath, 'background.js'), 'corrupt');
  await fs.unlink(path.join(first.extensionPath, 'popup.html'));
  const repaired = await installer.prepare();
  assert.equal(repaired.digest, prepared[0].digest);
  assert.deepEqual(await fs.readFile(path.join(first.extensionPath, 'background.js')), await fs.readFile(path.join(source, 'background.js')));
  assert.deepEqual(await fs.readFile(path.join(first.extensionPath, 'popup.html')), await fs.readFile(path.join(source, 'popup.html')));
});

test('invalid source leaves last valid installation intact and old hash directories remain', async t => {
  const { source, destination } = await fixture(t);
  const folder = await prepareNativeExtension(source, destination, id);
  await fs.mkdir(path.join(destination, 'old-hash')); await fs.writeFile(path.join(destination, 'old-hash/keep'), 'keep');
  const old = await fs.readFile(path.join(folder, 'manifest.json'));
  const manifest = JSON.parse(old); manifest.key = 'invalid'; await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(prepareNativeExtension(source, destination, id), /校验失败/);
  assert.deepEqual(await fs.readFile(path.join(folder, 'manifest.json')), old);
  assert.equal(await fs.readFile(path.join(destination, 'old-hash/keep'), 'utf8'), 'keep');
});

test('store URLs only accept the configured official item and filesystem comparison respects the OS', async t => {
  const { root } = await fixture(t);
  const url = `https://chromewebstore.google.com/detail/profilepilot/${id}`;
  assert.equal(nativeExtensionStoreUrl(id, url), url);
  for (const bad of [url + '?a=1', url + '.fake', url.replace('https:', 'http:'), url.replace('.google.com', '.google.com.attacker.test'), url.replace(id, 'a'.repeat(32))]) assert.equal(nativeExtensionStoreUrl(id, bad), '');
  assert.equal(await sameNativeProfilePath(root, root), true);
  assert.equal(await sameNativeProfilePath(root, path.join(root, 'different')), false);
  const upperExists = await fs.stat(root.toUpperCase()).then(() => true, () => false);
  assert.equal(await sameNativeProfilePath(root, root.toUpperCase()), upperExists);
});

async function serverFixture(t) {
  const files = await fixture(t); const onboarding = new NativeOnboarding(id); let opens = 0; let reveals = 0; let debug = 0;
  const installer = new NativeExtensionInstaller({ ...files, extensionId: id, userDataDir: files.root, openSettings: async (profile, invitation) => { assert.equal(profile, 'native:Default'); assert.equal(invitation, url); debug++; }, openExtensions: async (profile, invitation) => { assert.equal(profile, 'native:Default'); assert.equal(invitation, url); opens++; }, revealExtension: async folder => { assert.equal(folder, path.join(files.destination, 'current')); reveals++; } });
  onboarding.configure(installer, () => {});
  let port; const server = http.createServer((req, res) => onboarding.handle(req, res, port));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
  t.after(() => { onboarding.close(); server.closeAllConnections(); server.close(); });
  const url = onboarding.create(port, 'PP1.fixture-secret', '<Local profile>', new Date(Date.now() + 300000).toISOString(), 'native:Default');
  const post = action => fetch(url + '/' + action, { method: 'POST', headers: { Origin: new URL(url).origin, 'X-ProfilePilot-Onboarding': '1' } });
  return { ...files, onboarding, url, post, counts: () => ({ opens, reveals, debug }) };
}

test('durable onboarding prepares files, opens only the selected Profile and never requests debugging', async t => {
  const s = await serverFixture(t); s.onboarding.start(s.url);
  assert.equal((await s.post('local-install')).status, 200);
  assert.equal((await s.post('reveal-extension')).status, 200);
  const status = await (await fetch(s.url + '/status')).json();
  assert.equal(status.mode, 'local'); assert.equal(status.stage, 'confirm-tab');
  assert.equal(status.extensionPath, path.join(s.destination, 'current'));
  assert.deepEqual(s.counts(), { opens: 1, reveals: 1, debug: 0 });
  const page = await (await fetch(s.url)).text();
  assert.match(page, /首次安装一次/); assert.match(page, /仅本次 Chrome 会话/); assert.match(page, /&lt;Local profile&gt;/); assert.doesNotMatch(page, /PP1.fixture-secret/);
  assert.equal((await fetch(s.url + '/local-install', { method: 'POST', headers: { Origin: 'https://wrong.test', 'X-ProfilePilot-Onboarding': '1' } })).status, 403);
  s.onboarding.connected('native:Default'); s.onboarding.start(s.url, true);
  assert.equal((await (await fetch(s.url + '/status')).json()).stage, 'connected');
  assert.deepEqual(s.counts(), { opens: 1, reveals: 1, debug: 0 });
});

test('settings buttons request a direct native tab without serving or linking to an intermediary page', async t => {
  const s = await serverFixture(t);
  const page = await (await fetch(s.url)).text();
  for (const action of ['local-install', 'open-debugging']) {
    assert.ok(page.includes(`data-action="${action}"`));
    assert.ok(!page.includes(`href="${s.url}/${action}"`));
    const response = await fetch(s.url + '/' + action);
    assert.equal(response.status, 403);
    assert.equal(await response.text(), '');
  }
  assert.deepEqual(s.counts(), { opens: 0, reveals: 0, debug: 0 });
  assert.equal((await (await fetch(s.url + '/status')).json()).stage, 'preparing');
});

test('cancelling a preparation prevents a late completion from reopening Chrome', async t => {
  const s = await serverFixture(t);
  let resolve; const prepared = new Promise(done => { resolve = done; }); let opened = false;
  s.onboarding.configure({ prepare: () => prepared, openSettings: async () => {}, install: async () => {}, openExtensions: async () => { opened = true; } }, () => {});
  const local = s.post('local-install');
  // Ensure server has entered the slow operation before cancelling.
  await new Promise(done => setImmediate(done));
  assert.equal((await s.post('cancel')).status, 200);
  resolve({ extensionPath: '/fixture', version: '1', digest: 'abc' });
  assert.equal((await local).status, 400); assert.equal(opened, false);
  assert.equal((await (await fetch(s.url + '/status')).json()).stage, 'cancelled');
});

test('debugging opens in the same invitation window, and an opener failure is returned without another launch', async t => {
  const s = await serverFixture(t);
  assert.equal((await s.post('open-debugging')).status, 200);
  assert.equal(s.counts().debug, 1);
  let attempts = 0;
  s.onboarding.configure({
    prepare: async () => ({ extensionPath: s.destination, version: '1', digest: 'abc' }),
    install: async () => {}, openSettings: async () => {},
    openExtensions: async () => { attempts++; throw Error('请在地址栏输入 chrome://extensions/'); }
  }, () => {});
  const response = await s.post('local-install');
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /chrome:\/\/extensions/);
  assert.equal(attempts, 1);
  assert.equal((await (await fetch(s.url + '/status')).json()).stage, 'confirm-tab');
});

test('release ZIP is deterministic, root-level, contains exact assets and rejects a missing side panel', async t => {
  const { validateExtension, extensionZip } = await import('../scripts/package-native-extension.mjs');
  const { source } = await fixture(t);
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json')));
  manifest.icons = Object.fromEntries([16, 32, 48, 128].map(n => [n, `icons/icon-${n}.png`]));
  await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify(manifest));
  const validated = await validateExtension(source);
  assert.equal(validated.extensionId, id);
  const zip = extensionZip(validated.files); assert.deepEqual(zip, extensionZip(validated.files));
  const entries = new Map(); let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18); const length = zip.readUInt16LE(offset + 26); const name = zip.subarray(offset + 30, offset + 30 + length).toString();
    entries.set(name, zip.subarray(offset + 30 + length, offset + 30 + length + size)); offset += 30 + length + size;
  }
  assert.ok(entries.has('manifest.json'));
  for (const file of validated.files) assert.deepEqual(entries.get(file.name), file.data);
  manifest.side_panel = { default_path: 'missing.html' }; await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(validateExtension(source), /Missing asset/);
});
