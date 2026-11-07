const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { transformSync } = require('esbuild');
const { loadCli } = require('./cli-test-build.cjs');
const { followDesktopStatus } = loadCli('src/renderer/desktop-status.ts');
const { DesktopService } = loadCli('src/main/desktop/service.ts');
const target = { id: 'a'.repeat(32), title: 'Owned guidance fixture', pid: 1, process: 'fixture', className: 'Form' };
const version = 'b'.repeat(32);
const turn = () => new Promise(resolve => setImmediate(resolve));
const idle = () => ({ available: true, supported: true, platform: 'win32', session: null, inputObservation: { phase: 'idle' } });
const owned = phase => ({ ...idle(), session: { name: 'another-owner', revision: 1, state: phase === 'ready' ? 'active' : 'paused', window: target },
  inputObservation: { phase, generation: 'g1' } });

function rendererFixture(options = {}) {
  const nodes = new Map(), controls = [], calls = [];
  const element = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  class Element {
    constructor() { this.children = []; this.textContent = ''; this.hidden = false; this.dataset = {}; }
    get textContent() { return this.text; }
    set textContent(value) { this.text = value; this.children = []; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.text = ''; this.children = children; }
    setAttribute() {}
    querySelector(selector) { return selector === 'span' ? element('summary-span') : controls.find(value => selector.includes(value.dataset.control)); }
    querySelectorAll(selector) { return selector === '[data-control]' ? controls : this.children; }
  }
  for (const key of ['takeover', 'return', 'stop']) { const button = new Element(); button.dataset.control = key; controls.push(button); }
  let current = idle(), windows = [target], truncated = false, notify;
  const api = {
    status: async () => current,
    windows: options.windows || (async () => ({ windows, truncated })),
    preview: options.preview || (async () => ({ image: { mimeType: 'image/jpeg', data: 'fixture' } })),
    onChanged(listener) { notify = listener; return () => {}; },
    control(...args) { calls.push(args); return Promise.resolve(); }
  };
  const context = { module: { exports: {} }, exports: {}, crypto: { randomUUID },
    document: { getElementById: element, createElement: () => new Element() },
    window: { desktopControl: api, addEventListener() {} }, Image: Element,
    setInterval: () => 1, clearInterval() {}, require(id) {
      if (id === './desktop-status') return { followDesktopStatus };
      if (id === './workspace-switcher') return { workspaceSwitcher: () => '', workspaceIdentityBar: () => '', refreshWorkspaceSwitcher() {} };
      if (id === './pc-control') return { pcControlTabs: () => '' };
      if (id === './workspace-lifecycle') return { onWorkspaceVisibilityChanged() {} };
      throw new Error('Unexpected renderer dependency ' + id);
    } };
  const source = fs.readFileSync('src/renderer/desktop.ts', 'utf8');
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, context);
  return { element, calls, async select() { await turn(); element('desktop-windows').children[0].onclick(); await turn(); },
    async refresh(rows, partial = false) { windows = rows; truncated = partial; element('desktop-refresh').onclick(); await turn(); },
    publish(value) { current = value; notify(value); } };
}

function serviceFixture() {
  const drivers = []; let inputs = 0;
  const service = new DesktopService({ platform: 'win32', available: () => true, allowUnobservedTestDriver: true, driver: () => {
    const driver = { closed: false, close() { driver.closed = true; }, async request(operation) {
      assert.equal(driver.closed, false);
      if (operation === 'windows') return { windows: [target] };
      if (operation === 'window.observe') return { windowId: target.id, version, truncated: false, gaps: [], elements: [
        { reference: 'e1', role: 'Button', name: 'Save', text: '', actions: ['invoke'], password: false }
      ] };
      assert.equal(operation, 'window.action'); inputs++; return { executed: true };
    } };
    drivers.push(driver); return driver;
  } });
  return { service, drivers, get inputs() { return inputs; } };
}
const command = (method, session, extra = {}) => ({ action: 'desktop', method, session, ...extra });
function suggestedSession(fixture) {
  const text = fixture.element('desktop-command').textContent;
  const match = /^ppilot desktop claim --session ([a-zA-Z0-9._:-]{1,100}) --window ([a-f0-9]{32})$/.exec(text);
  assert.ok(match, 'A selected idle window needs a concrete, copyable claim example'); assert.equal(match[2], target.id);
  return match[1];
}

test('a target missing from a partial list clears its old title and hides the stale claim example', async () => {
  const f = rendererFixture(); await f.select(); assert.equal(f.element('desktop-selected').textContent, target.title);
  await f.refresh([], true);
  assert.notEqual(f.element('desktop-selected').textContent, target.title);
  assert.equal(f.element('desktop-command').hidden, true);
  assert.doesNotMatch(f.element('desktop-command').textContent, /claim|aaaaaaaa/);
  assert.doesNotMatch(f.element('desktop-preview').textContent, /已关闭/);
  assert.match(f.element('desktop-preview').textContent, /未找到|未.*列表/);
  assert.equal(f.calls.length, 0);
});

test('an idle example stays stable but receives a usable new task name after a completed task', async () => {
  const f = rendererFixture(), service = serviceFixture(); await f.select();
  try {
    const first = suggestedSession(f); f.publish(idle()); assert.equal(suggestedSession(f), first);
    await service.service.execute(command('claim', first, { windowId: target.id })); f.publish(service.service.status());
    await service.service.execute(command('complete', first, { requireActive: true })); f.publish(service.service.status());
    const second = suggestedSession(f); assert.notEqual(second, first);
    f.publish(idle()); assert.equal(suggestedSession(f), second);
    await service.service.execute(command('claim', second, { windowId: target.id }));
    assert.equal(service.service.status().session.name, second); assert.equal(service.inputs, 0); assert.equal(f.calls.length, 0);
  } finally { await service.service.close(); }
});

test('manual refresh supplies a new usable name when a whole session completed between status samples', async () => {
  const f = rendererFixture(), service = serviceFixture(); await f.select();
  try {
    const first = suggestedSession(f);
    await service.service.execute(command('claim', first, { windowId: target.id }));
    await service.service.execute(command('complete', first, { requireActive: true }));
    // The page was hidden or missed both notifications: an idle status alone
    // cannot tell it that the displayed example has already been consumed.
    f.publish(service.service.status()); assert.equal(suggestedSession(f), first);
    await assert.rejects(service.service.execute(command('claim', first, { windowId: target.id })), { code: 'DESKTOP_SESSION_ENDED' });
    await f.refresh([target]);
    const second = suggestedSession(f); assert.notEqual(second, first);
    f.publish(idle()); assert.equal(suggestedSession(f), second);
    assert.match(f.element('desktop-command-hint').textContent, /每个新任务/);
    assert.match(f.element('desktop-command-hint').textContent, /刷新|重新选择/);
    await service.service.execute(command('claim', second, { windowId: target.id }));
    assert.equal(service.service.status().session.name, second);
    assert.equal(service.inputs, 0); assert.equal(f.calls.length, 0);
  } finally { await service.service.close(); }
});

test('explicitly reselecting a window renews the example while idle status polling leaves it stable', async () => {
  const f = rendererFixture(); await f.select(); const first = suggestedSession(f);
  f.publish(idle()); f.publish(idle()); assert.equal(suggestedSession(f), first);
  await f.select(); const second = suggestedSession(f); assert.notEqual(second, first);
  f.publish(idle()); f.publish(idle()); assert.equal(suggestedSession(f), second);
  assert.equal(f.calls.length, 0);
});

test('active paused arming and pending owners show only a status suggestion without reusing their session', async () => {
  const f = rendererFixture(); await f.select();
  for (const phase of ['ready', 'paused', 'arming', 'pending']) {
    f.publish(owned(phase)); assert.equal(f.element('desktop-command').textContent, 'ppilot desktop status', phase);
    assert.equal(f.element('desktop-command-hint').textContent, '当前已有桌面任务，请先检查状态。');
    assert.equal(f.element('desktop-command').hidden, false);
    assert.doesNotMatch(f.element('desktop-command').textContent, /claim|resume|another-owner/);
  }
  assert.equal(f.calls.length, 0);
});

test('platform unavailability clears old preview and prevents an in-flight preview from restoring it', async () => {
  let finish;
  const f = rendererFixture({ preview: () => new Promise(resolve => { finish = resolve; }) }); await f.select();
  f.publish({ ...idle(), supported: false, available: false, platform: 'darwin', reason: 'Native Windows control unavailable' });
  finish({ image: { mimeType: 'image/jpeg', data: 'old-image' } }); await turn();
  assert.notEqual(f.element('desktop-selected').textContent, target.title);
  assert.equal(f.element('desktop-command').hidden, true); assert.doesNotMatch(f.element('desktop-command').textContent, /claim|aaaaaaaa/);
  assert.equal(f.element('desktop-preview').children.length, 0); assert.match(f.element('desktop-preview').textContent, /unavailable/);
  assert.equal(f.calls.length, 0);
});

test('platform unavailability clears an existing image and excludes a late window-list response', async () => {
  let reads = 0, finish;
  const f = rendererFixture({ windows: () => ++reads === 1 ? Promise.resolve({ windows: [target], truncated: false })
    : new Promise(resolve => { finish = resolve; }) }); await f.select();
  assert.equal(f.element('desktop-preview').children.length, 1);
  await f.refresh([target]);
  f.publish({ ...idle(), available: false, reason: 'Component unavailable' });
  finish({ windows: [target], truncated: false }); await turn();
  assert.equal(f.element('desktop-preview').children.length, 0);
  assert.equal(f.element('desktop-windows').children.length, 0);
  assert.equal(f.element('desktop-command').hidden, true);
  assert.equal(f.calls.length, 0);
});

test('a late window list cannot cross unavailable-to-available generations', async () => {
  let reads = 0, finish;
  const f = rendererFixture({ windows: () => ++reads === 2 ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve({ windows: [target], truncated: false }) }); await f.select();
  await f.refresh([target]); assert.equal(reads, 2);
  f.publish({ ...idle(), available: false, reason: 'Component unavailable' });
  f.publish(idle());
  finish({ windows: [target], truncated: false }); await turn();
  assert.equal(f.element('desktop-windows').children.length, 0, 'the older available generation must not restore selectable rows');
  assert.equal(f.element('desktop-preview').children.length, 0);
  assert.equal(f.element('desktop-command').hidden, true);
  assert.notEqual(f.element('desktop-selected').textContent, target.title);
  await f.refresh([target]); assert.equal(reads, 3); assert.equal(f.element('desktop-windows').children.length, 1);
  await f.select(); suggestedSession(f); assert.equal(f.calls.length, 0);
});

test('an interval timeout requires fresh observation without falsely claiming the unchanged driver was replaced', async () => {
  const f = serviceFixture(), session = 'guidance-timeout';
  try {
    await f.service.execute(command('claim', session, { windowId: target.id })); const before = [...f.drivers];
    const result = await f.service.execute(command('wait', session, { condition: { name: 'Finished' }, timeoutMs: 100, intervalMs: 2000 }));
    assert.equal(result.timedOut, true); assert.equal(result.attempts, 1); assert.deepEqual(f.drivers, before);
    assert.equal(f.drivers.some(driver => driver.closed), false);
    let failure; try { await f.service.execute(command('action', session, { requestId: randomUUID(), params: { kind: 'invoke', ref: 'e1', version } })); } catch (error) { failure = error; }
    assert.equal(failure?.code, 'DESKTOP_FRESH_OBSERVATION_REQUIRED'); assert.equal(f.inputs, 0);
    assert.doesNotMatch(failure.message, /驱动已经更换/); assert.match(failure.message, /重新观察|重新.*截图/);
  } finally { await f.service.close(); }
});

test('the generated plugin reference matches the source desktop guidance including window-state behavior', () => {
  const normalized = file => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const source = normalized('skills/profilepilot/references/desktop.md');
  const generated = normalized('plugins/profilepilot/skills/profilepilot/references/desktop.md');
  assert.match(source, /restore.*minimize.*maximize/);
  assert.equal(generated === source, true, 'Run the existing npm run plugin:sync; do not edit generated reference files by hand');
});
