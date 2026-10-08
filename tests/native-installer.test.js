const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const build = process.env.PROFILEPILOT_INSTALL_TEST_BUILD || require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'pp-install-test-build-'));
if (!process.env.PROFILEPILOT_INSTALL_TEST_BUILD) {
  require('esbuild').buildSync({ entryPoints: ['src/main/tasks/native-installer.ts'], outdir: build, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  test.after(() => fs.rm(build, { recursive: true, force: true }));
}
const { NativeExtensionInstaller, parseNativeDebugEndpoint, prepareNativeExtension } = require(path.join(build, 'native-installer.js'));
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
  assert.equal(JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'))).version, JSON.parse(await fs.readFile(path.join(source, 'manifest.json'))).version);
  assert.equal(await fs.readFile(path.join(folder, 'background.js'), 'utf8'), await fs.readFile(path.join(source, 'background.js'), 'utf8'));
  await assert.rejects(prepareNativeExtension(source, root, 'a'.repeat(32)), /校验失败/);
});

async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'DevToolsActivePort'), '18888\n/devtools/browser/fixture');
  const calls = []; const progress = []; const controller = new AbortController();
  let closed = false; let connectionCount = 0; let installed = Boolean(options.existing);
  const url = 'http://127.0.0.1:19000/profilepilot-connect/' + 'a'.repeat(48);
  const client = {
    close() { closed = true; },
    async send(method, params, timeout, sessionId) {
      calls.push({ method, params, sessionId });
      switch (method) {
        case 'Browser.getVersion': return { product: `Chrome/${options.major || 153}.0.0.0` };
        case 'Target.getTargets': return { targetInfos: [{ type: 'page', targetId: 'invitation', url: options.missingPage ? 'https://example.test' : url }, { type: 'page', targetId: 'user-work', url: 'https://example.test' }, { type: 'service_worker', targetId: 'extension-worker', url: `chrome-extension://${extensionId}/background.js` }] };
        case 'Target.createTarget': return { targetId: 'verification' };
        case 'Target.attachToTarget': return { sessionId: params.targetId + '-session' };
        case 'Runtime.evaluate':
          if (sessionId === 'extension-worker-session' && params.expression === 'chrome.runtime.getManifest().version') {
            const preparedVersion = JSON.parse(await fs.readFile(path.join(root, 'files', 'current', 'manifest.json'))).version;
            return { result: { value: Object.hasOwn(options, 'workerVersion') ? options.workerVersion : preparedVersion },
              ...(options.manifestException ? { exceptionDetails: { text: 'worker unavailable' } } : {}) };
          }
          return { result: { value: sessionId === 'extension-worker-session' ? true : path.join(root, options.wrongProfile ? 'Profile 2' : 'Default') } };
        case 'Extensions.loadUnpacked': if (options.loadError) throw new Error('Blocked by administrator'); installed = true; return { id: extensionId };
        case 'Extensions.getExtensions': return { extensions: installed ? [{ id: extensionId, enabled: !options.disabled,
          path: options.wrongPath ? path.join(root, 'other-extension') : path.join(root, 'files', 'current'),
          version: JSON.parse(await fs.readFile(path.join(root, 'files', 'current', 'manifest.json'))).version }] : [] };
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
  const mark = s.calls.find(c => c.method === 'Runtime.evaluate' && c.params.expression.includes('profilepilotInstallation'));
  const manifest = s.calls.find(c => c.method === 'Runtime.evaluate' && c.params.expression === 'chrome.runtime.getManifest().version');
  assert.equal(manifest.sessionId, 'extension-worker-session');
  assert.ok(s.calls.indexOf(manifest) < s.calls.indexOf(mark));
  assert.match(mark.params.expression, /mode:'temporary'/);
  assert.equal(mark.sessionId, 'extension-worker-session');
  assert.deepEqual(s.calls.filter(c => c.method === 'Target.closeTarget').map(c => c.params.targetId), ['verification']);
  assert.equal(s.progress.at(-1).stage, 'confirm-tab');
});

test('enabled extensions with an old or unverifiable worker never report installation success or change pairing', async t => {
  await Promise.all([
    { workerVersion: '0.1.0' },
    { workerVersion: '99.0.0' },
    { workerVersion: undefined },
    { manifestException: true }
  ].map(async options => {
    const s = await setup(t, options);
    await assert.rejects(s.run(), error => {
      assert.match(error.message, /未确认扩展更新成功/);
      assert.match(error.message, /Chrome 扩展管理页重新加载/);
      assert.match(error.message, /已有配对会保留/);
      if (typeof options.workerVersion === 'string') assert.ok(error.message.includes(options.workerVersion));
      return true;
    });
    assert.equal(s.connections(), 1);
    assert.equal(s.calls.filter(c => c.method === 'Extensions.loadUnpacked').length, 1);
    assert.ok(s.calls.some(c => c.method === 'Extensions.getExtensions'), 'enabled/list metadata alone cannot prove the running version');
    assert.equal(s.progress.some(p => ['confirm-tab', 'connected'].includes(p.stage)), false);
    assert.equal(s.calls.some(c => c.method === 'Page.reload'), false);
    assert.equal(s.calls.some(c => c.method.startsWith('Extensions.') && !['Extensions.loadUnpacked', 'Extensions.getExtensions'].includes(c.method)), false);
    assert.equal(s.calls.some(c => /(?:storage\.local\.(?:get|set|clear|remove)|runtime\.reload|developerPrivate|management\.setEnabled)/.test(c.params?.expression || '')), false);
    assert.ok(s.calls.some(c => c.method === 'Target.detachFromTarget' && c.params.sessionId === 'extension-worker-session'));
    assert.deepEqual(s.calls.filter(c => c.method === 'Target.closeTarget').map(c => c.params.targetId), ['verification']);
    assert.equal(s.closed(), true);
  }));
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

test('an existing matching extension is verified and reused without loading again or rewriting installation storage', async t => {
  const s = await setup(t, { existing: true }); await s.run();
  assert.equal(s.calls.some(c => c.method === 'Extensions.loadUnpacked'), false);
  assert.equal(s.calls.some(c => /storage\.local\.(?:set|remove|clear)/.test(c.params?.expression || '')), false);
  assert.ok(s.calls.some(c => c.params?.expression === 'chrome.runtime.getManifest().version'));
  assert.equal(s.progress.at(-1).mode, 'existing');
  assert.match(s.progress.at(-1).message, /原有安装方式/);
  assert.equal(s.closed(), true);
});

test('existing old workers cannot be reported as updated or marked temporary', async t => {
  const s = await setup(t, { existing: true, workerVersion: '0.1.0' });
  await assert.rejects(s.run(), /未确认扩展更新成功/);
  assert.equal(s.calls.some(c => c.method === 'Extensions.loadUnpacked'), false);
  assert.equal(s.calls.some(c => /storage\.local\.(?:set|remove|clear)/.test(c.params?.expression || '')), false);
  assert.equal(s.calls.some(c => c.method === 'Page.reload'), false);
  assert.equal(s.progress.some(p => p.stage === 'confirm-tab'), false);
  assert.equal(s.closed(), true);
});

test('disabled or differently located existing installations are never replaced by a temporary one', async t => {
  await Promise.all([{ existing: true, disabled: true }, { existing: true, wrongPath: true }].map(async options => {
    const s = await setup(t, options);
    await assert.rejects(s.run(), /尚未启用或安装目录不同/);
    assert.equal(s.calls.some(c => c.method === 'Extensions.loadUnpacked'), false);
    assert.equal(s.calls.some(c => c.method === 'Target.attachToTarget' && c.params.targetId === 'extension-worker'), false);
    assert.equal(s.calls.some(c => c.method === 'Page.reload'), false);
    assert.equal(s.closed(), true);
  }));
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
