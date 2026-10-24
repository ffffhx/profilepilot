const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskStore } = require('../dist/main/tasks/store');
const { TaskService } = require('../dist/main/tasks/service');
const { NativeBrowser } = require('../dist/main/tasks/native-browser');
const { runBrowserCli } = require('../dist/main/browser-cli');

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pp-sites-'));
  const store = new TaskStore(root), task = store.create({ prompt: 'Read sites', profileId: 'native:test' }, 'Test');
  const result = { version: 1, operation: 'zhihu.hot', status: 'ok', items: [{ title: 'Verified site title' }], source: { url: 'https://www.zhihu.com/hot', checkedAt: new Date().toISOString(), method: 'browser-fetch' } };
  let reads = 0;
  const browser = { siteAdapter: async (_task, _input, check) => { reads++; check('https://www.zhihu.com/hot'); return result; }, control: async () => {}, tabs: async () => [] };
  const service = new TaskService(store, { browser, apiKey: () => '', prepareProfile: async () => ({ name: 'Test', browserConnection: 'extension' }), profileName: async () => 'Test', changed: () => {}, notify: () => {} });
  service.tick = async () => {};
  const run = { started: Date.now(), stopped: false, chain: Promise.resolve(), repeat: '', repeatCount: 0 };
  service.runs.set(task.id, run); task.status = 'running'; task.browserConnection = 'extension';
  t.after(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  return { task, run, service, result, reads: () => reads };
}

test('built-in Agent discovers sites, enforces origin policy, records evidence and accepts verified finish', async t => {
  const f = fixture(t);
  assert.equal(JSON.parse((await f.service.handleTool(f.task, f.run, 'site_adapters', {})).content[0].text).length, 18);
  f.task.nativeAccess = { blockedOrigins: ['https://www.zhihu.com'] };
  await assert.rejects(f.service.handleTool(f.task, f.run, 'site_read', { operation: 'zhihu.hot' }), /限制/);
  assert.equal(f.reads(), 0);
  f.task.nativeAccess = {};
  const read = await f.service.handleTool(f.task, f.run, 'site_read', { operation: 'zhihu.hot' });
  assert.equal(JSON.parse(read.content[0].text).status, 'ok');
  assert.equal(f.task.usage.actions, 1); assert.match(f.task.evidencePages[0].snapshot, /Verified site title/);
  const finish = await f.service.handleTool(f.task, f.run, 'finish', { status: 'completed', summary: 'Read completed', evidence: ['Verified site title'], remaining: [] });
  assert.ok(!finish.isError); assert.equal(f.task.status, 'completed');
});

test('failed site reads never create supporting evidence', async t => {
  const f = fixture(t); f.result.status = 'blocked'; f.result.items = [];
  const read = await f.service.handleTool(f.task, f.run, 'site_read', { operation: 'zhihu.hot' });
  assert.equal(read.isError, true); assert.equal(f.task.evidencePages?.length || 0, 0);
});

test('native multi-step adapter stops when generation changes during initial read', async t => {
  const state = { profileId: 'native:test', connected: true, taskTabs: true, ownerSessionId: 's', ownership: 'agent', controlGeneration: 'one' };
  let calls = 0;
  const bridge = { states: () => [state], onEvent: () => () => {}, request: async (_profile, method) => {
    assert.equal(method, 'cdp'); calls++; state.controlGeneration = 'two'; state.ownership = 'user';
    return { result: { value: { url: 'https://www.zhihu.com/hot', ready: 'complete' } } };
  } };
  const browser = new NativeBrowser(bridge, os.tmpdir()); t.after(() => browser.dispose?.());
  await assert.rejects(browser.siteAdapter({ profileId: 'native:test', sessionId: 's' }, { operation: 'zhihu.hot' }), error => error.code === 'NATIVE_USER_IN_CONTROL');
  assert.equal(calls, 1);
});

test('external site discovery is local and identical for extension/Gateway without connecting', async () => {
  for (const prefix of [[], ['--connection', 'gateway']]) {
    let output = '', routed = false;
    const code = await runBrowserCli([...prefix, 'sites'], { stdout: { write: s => output += s }, stderr: { write: () => {} } }, {},
      { extension: async () => { routed = true; }, gateway: async () => { routed = true; return 0; } });
    assert.equal(code, 0); assert.equal(JSON.parse(output).result.length, 18); assert.equal(routed, false);
  }
});
