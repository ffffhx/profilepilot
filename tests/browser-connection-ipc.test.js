const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

test('browser IPC and connection notifications work without loading task history', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-browser-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const taskFile = path.join(root, 'browser-tasks', 'tasks.json');
  fs.mkdirSync(path.dirname(taskFile)); fs.writeFileSync(taskFile, '{corrupt task history');
  let handler, changed, canPair = true;
  const calls = [], messages = [];
  const states = [{ profileId: 'native:Default', connected: true, ownership: 'user', capabilities: ['liveView'] }];
  class Client {
    constructor(_root, callback) { changed = callback; }
    states() { return states; } installationStates() { return []; }
    async pair(id) { calls.push(['pair', id]); return { code: 'fixture', expiresAt: 'later' }; }
    async request(...args) { calls.push(args); return { tabs: [] }; }
    async revealExtension() { calls.push(['reveal']); }
  }
  const electron = { ipcMain: { handle: (name, fn) => { assert.equal(name, 'browser-connection:request'); handler = fn; } },
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args) => messages.push(args) } }] } };
  const filename = path.resolve('dist/main/browser-service/desktop.js');
  const localRequire = createRequire(filename), module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports,__dirname,process){${fs.readFileSync(filename,'utf8')}\n})`, { filename })(
    id => id === 'electron' ? electron : id === './client' ? { BrowserServiceClient: Client } : localRequire(id),
    module, module.exports, path.dirname(filename), { env: { ...process.env, CPM_DATA_DIR: root } });
  module.exports.registerBrowserConnection({ getState: async () => ({ profiles: [{ id: 'native:Default', source: 'native', name: 'Chrome' }] }) }, () => canPair);
  const event = { senderFrame: { url: pathToFileURL(path.resolve('public/index.html')).href } };
  assert.deepEqual(await handler(event, 'snapshot'), { nativeBrowsers: states, nativeInstallations: [] });
  assert.equal((await handler(event, 'pairNativeBrowser', 'native:Default')).code, 'fixture');
  await handler(event, 'getNativeLiveView', 'native:Default');
  await handler(event, 'openNativeExtensionFolder');
  assert.deepEqual(calls, [['pair', 'native:Default'], ['native:Default', 'liveView', {}, 5000], ['reveal']]);
  canPair = false;
  await assert.rejects(handler(event, 'pairNativeBrowser', 'native:Default'), /暂停/);
  await assert.rejects(handler({ senderFrame: { url: 'https://example.test' } }, 'snapshot'));
  await assert.rejects(handler({ senderFrame: { url: pathToFileURL(path.resolve('public/phones.html')).href } }, 'snapshot'));
  changed(); assert.equal(messages.length, 1); assert.equal(messages[0][0], 'browser-connection:changed');
  assert.equal('tasks' in messages[0][1], false);
  assert.equal(fs.readFileSync(taskFile, 'utf8'), '{corrupt task history');
});
