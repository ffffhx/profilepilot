const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { NativeExtensionInstaller, parseNativeDebugEndpoint, prepareNativeExtension } = require('../dist/main/tasks/native-installer');
const extensionId = 'gmdaabnoocjlpimglalnbegfdaklfnaj';
const source = path.resolve('extensions/profilepilot');

test('native endpoint discovery only accepts a local Chrome browser endpoint', () => {
  assert.equal(parseNativeDebugEndpoint('18888\r\n/devtools/browser/abc-123\r\n'), 'ws://127.0.0.1:18888/devtools/browser/abc-123');
  assert.equal(parseNativeDebugEndpoint('18888\n/devtools/browser'), 'ws://127.0.0.1:18888/devtools/browser');
  for (const value of ['0\n/devtools/browser/abc', '65536\n/devtools/browser', '9222\n//attacker.test', '9222\n/devtools/page/abc', '1e3\n/devtools/browser']) assert.throws(() => parseNativeDebugEndpoint(value));
});

test('bundled extension is validated and staged in a stable, reusable external path', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-install-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = await prepareNativeExtension(source, root, extensionId);
  assert.equal(await prepareNativeExtension(source, root, extensionId), folder);
  assert.equal(JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'))).version, '0.1.0');
  assert.equal(await fs.readFile(path.join(folder, 'background.js'), 'utf8'), await fs.readFile(path.join(source, 'background.js'), 'utf8'));
  await assert.rejects(prepareNativeExtension(source, root, 'a'.repeat(32)), /校验失败/);
});

async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'DevToolsActivePort'), '18888\n/devtools/browser/fixture');
  const calls = []; const progress = []; const controller = new AbortController();
  let closed = false; let connectionCount = 0;
  const url = 'http://127.0.0.1:19000/profilepilot-connect/' + 'a'.repeat(48);
  const client = {
    close() { closed = true; },
    async send(method, params, timeout, sessionId) {
      calls.push({ method, params, sessionId });
      switch (method) {
        case 'Browser.getVersion': return { product: `Chrome/${options.major || 153}.0.0.0` };
        case 'Target.getTargets': return { targetInfos: [{ type: 'page', targetId: 'invitation', url: options.missingPage ? 'https://example.test' : url }, { type: 'page', targetId: 'user-work', url: 'https://example.test' }] };
        case 'Target.createTarget': return { targetId: 'verification' };
        case 'Target.attachToTarget': return { sessionId: params.targetId + '-session' };
        case 'Runtime.evaluate': return { result: { value: path.join(root, options.wrongProfile ? 'Profile 2' : 'Default') } };
        case 'Extensions.loadUnpacked': if (options.loadError) throw new Error('Blocked by administrator'); return { id: extensionId };
        case 'Extensions.getExtensions': return { extensions: [{ id: extensionId, enabled: !options.disabled }] };
        default: return {};
      }
    }
  };
  const installer = new NativeExtensionInstaller({ source, destination: path.join(root, 'files'), userDataDir: root, extensionId,
    openSettings: async () => {}, connect: async (endpoint, timeout, signal) => { connectionCount++; assert.equal(endpoint, 'ws://127.0.0.1:18888/devtools/browser/fixture'); if (options.reject) throw new Error('denied'); if (options.abort) { controller.abort(); throw controller.signal.reason; } return client; }
  });
  const run = () => installer.install({ url, profileId: 'native:Default', signal: controller.signal, report: p => progress.push(p) });
  return { calls, progress, run, controller, root, closed: () => closed, connections: () => connectionCount };
}

test('authorized installation validates Profile and ID, reloads only the invitation and disconnects', async t => {
  const s = await setup(t); await s.run();
  assert.equal(s.closed(), true);
  assert.equal(s.calls.filter(c => c.method === 'Extensions.loadUnpacked').length, 1);
  assert.ok(s.calls.findIndex(c => c.method === 'Runtime.evaluate') < s.calls.findIndex(c => c.method === 'Extensions.loadUnpacked'));
  assert.equal(s.calls.find(c => c.method === 'Page.reload').sessionId, 'invitation-session');
  assert.deepEqual(s.calls.filter(c => c.method === 'Target.closeTarget').map(c => c.params.targetId), ['verification']);
  assert.equal(s.progress.at(-1).stage, 'confirm-tab');
});

test('wrong Profile, missing invitation and older Chrome never install', async t => {
  await Promise.all([{ wrongProfile: true }, { missingPage: true }, { major: 148 }].map(async options => {
    const s = await setup(t, options); await assert.rejects(s.run());
    assert.equal(s.calls.some(c => c.method === 'Extensions.loadUnpacked'), false);
    assert.equal(s.closed(), true);
  }));
});

test('denied authorization does not retry or perform browser operations', async t => {
  const s = await setup(t, { reject: true }); await assert.rejects(s.run(), /不会自动重试/);
  assert.equal(s.connections(), 1); assert.equal(s.calls.length, 0);
});

test('policy blocked and disabled extensions are not reported as installed', async t => {
  await Promise.all([{ loadError: true }, { disabled: true }].map(async options => {
    const s = await setup(t, options); await assert.rejects(s.run());
    assert.equal(s.progress.some(p => p.stage === 'confirm-tab'), false);
    assert.equal(s.closed(), true);
  }));
});

test('cancelling before Chrome enables debugging stops discovery', async t => {
  const s = await setup(t); await fs.unlink(path.join(s.root, 'DevToolsActivePort'));
  const running = s.run(); setTimeout(() => s.controller.abort(), 50);
  await assert.rejects(running); assert.equal(s.connections(), 0);
});
