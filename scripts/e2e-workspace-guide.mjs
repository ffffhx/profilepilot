import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';

const app = await launchProfilePilotE2e({ name: 'workspace spotlight tour', onboarding: true });
const d = app.driver;
const shell = expression => d.evaluate(expression, { target: 'shell' });
const key = 'profilepilot:workspace-guide:v3:';
const output = path.join(repoRoot, 'test-results', 'workspace-guide');
const tick = () => shell('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
const capture = async name => {
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(path.join(output, `${name}.png`), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
      return;
    } catch (error) {
      if (attempt >= 3 || !/UnknownVizError/.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
};
const ready = id => d.waitFor(`#workspace-guide[data-target-ready="true"][data-step-id="${id}"]`, s => s.exists, { timeoutMs: 15000 });
const closed = () => d.waitFor('#workspace-guide', state => !state.exists);
const reload = async () => {
  await shell('document.documentElement.dataset.reloadMarker = "old"; true');
  await d.request('reload');
  await d.waitFor('html', state => state.exists && !state.attributes['data-reload-marker']);
  await d.waitFor('html[data-workspace-loading="false"]', state => state.exists, { target:'shell', timeoutMs:30000 });
  await d.waitFor('h1', state => state.exists, { timeoutMs:30000 });
  await tick();
};
const checkGeometry = async () => {
  await tick();
  const state = await shell(`(() => {
    const tour = document.querySelector('#workspace-guide');
    const card = tour.querySelector('.guide-card').getBoundingClientRect();
    const ring = tour.querySelector('.guide-spotlight').getBoundingClientRect();
    const frame = document.querySelector('iframe[data-active="true"]');
    const doc = tour.dataset.targetScope === 'shell' ? document : frame.contentDocument;
    const target = [...doc.querySelectorAll(tour.dataset.targetSelector)].find(node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
    const rect = target.getBoundingClientRect(), outer = frame.getBoundingClientRect();
    const x = rect.left + (doc === document ? 0 : outer.left), y = rect.top + (doc === document ? 0 : outer.top);
    const overlap = Math.max(0, Math.min(card.right, ring.right) - Math.max(card.left, ring.left)) * Math.max(0, Math.min(card.bottom, ring.bottom) - Math.max(card.top, ring.top));
    return { id: tour.dataset.stepId, workspace: document.documentElement.dataset.workspace, expected: tour.dataset.targetWorkspace,
      focused: tour.contains(document.activeElement) || !!document.activeElement.closest('.workspace-rail'), cardFits: card.left >= 0 && card.right <= innerWidth + 1 && card.top >= 0 && card.bottom <= innerHeight + 1,
      ringFits: ring.left >= -1 && ring.right <= innerWidth + 1 && ring.top >= -1 && ring.bottom <= innerHeight + 1,
      targetMatches: ring.left >= x - 6 && ring.top >= y - 6 && ring.right <= x + rect.width + 6 && ring.bottom <= y + rect.height + 6,
      overlap, ring: { left:ring.left,top:ring.top,width:ring.width,height:ring.height }, card: { left:card.left,top:card.top,width:card.width,height:card.height } };
  })()`);
  assert.equal(state.workspace, state.expected, JSON.stringify(state));
  for (const prop of ['focused', 'cardFits', 'ringFits', 'targetMatches']) assert.equal(state[prop], true, `${prop}: ${JSON.stringify(state)}`);
  assert.equal(state.overlap, 0, `card must not obscure target: ${JSON.stringify(state)}`);
  return state;
};

try {
  await mkdir(output, { recursive: true });
  await ready('browser-tab');
  await tick();
  assert.equal((await d.windows()).main.backgroundColor.toLowerCase(), '#5e697b', 'native caption background must match the guide shade');
  assert.equal((await d.windows()).main.captionAppearance.endsWith('/true'), true);
  assert.equal(await shell(`document.querySelector('.guide-progress').textContent`), '1 / 3');
  assert.equal(await shell(`document.querySelector('iframe[data-active="true"]').inert`), true);
  // The real rail remains clickable while the page underneath is protected.
  assert.equal(await shell(`(() => { const tab = document.querySelector('.workspace-link[data-workspace="phones"]'); const rect = tab.getBoundingClientRect(); return document.elementFromPoint(rect.left + 15, rect.top + rect.height / 2).closest('a') === tab; })()`), true);
  await d.domClick('.workspace-link[data-workspace="phones"]', { target: 'shell' });
  await ready('phones-tab');
  assert.equal(await shell(`localStorage.getItem('profilepilot:workspace-guide:v3:browser')`), 'dismissed');
  assert.equal(await shell(`document.querySelectorAll('#workspace-guide').length`), 1);
  await d.domClick('.guide-skip');
  await closed();
  await tick();
  assert.equal((await d.windows()).main.backgroundColor.toLowerCase(), '#f6faff', 'native caption restores after guide closes');
  assert.equal((await d.windows()).main.captionAppearance.endsWith('/false'), true);
  await d.domClick('.workspace-link[data-workspace="browser"]');
  assert.equal((await d.query('#workspace-guide')).exists, false, 'visiting an already dismissed tab does not repeat its guide');
  const chapters = [
    ['browser', ['browser-tab', 'browser-new', 'browser-profiles']],
    ['phones', ['phones-tab', 'phone-connect', 'phone-mobile']],
    ['tools', ['tools-tab', 'tools-extension', 'tools-cli']],
    ['agent', ['agent-tab', 'agent-prompt', 'settings']],
    ['local-apps', ['local-apps-tab', 'apps-add', 'apps-list']]
  ];
  for (const [workspace, ids] of chapters) {
    if (workspace === 'local-apps') await d.domClick('.workspace-link[data-workspace="browser"]');
    await d.domClick(workspace === 'local-apps' ? '[data-pc-view="local-apps"]' : `.workspace-link[data-workspace="${workspace}"]`);
    if (!(await d.query('#workspace-guide')).exists) await d.domClick('[data-workspace-guide]');
    for (const [index, id] of ids.entries()) {
      await ready(id);
      await checkGeometry();
      assert.equal(await shell(`document.documentElement.dataset.workspace`), workspace);
      assert.equal(await shell(`document.querySelector('.guide-progress').textContent`), `${index + 1} / 3`);
      if (index === 1) await capture(`${workspace}-control`);
      await d.domClick('[data-guide-next]');
    }
    await closed();
    assert.equal(await shell(`localStorage.getItem(${JSON.stringify(key + workspace)})`), 'completed');
    assert.equal(await shell(`document.querySelector('iframe[data-active="true"]').inert`), false);
    assert.equal(await shell(`document.documentElement.dataset.workspace`), workspace, 'completion must not navigate to another tab');
    console.log(`PASS contextual tour ${workspace}: three steps, no cross-tab navigation`);
  }
  // Replaying a guide must preserve the page instance and its unsent draft.
  await d.domClick('.workspace-link[data-workspace="agent"]');
  assert.equal((await d.query('#workspace-guide')).exists, false);
  await d.domInput('#prompt', 'Keep this unsent draft');
  await shell(`window.__initialFrame = document.querySelector('iframe[data-active="true"]'); window.__initialOrigin = __initialFrame.contentWindow.performance.timeOrigin; true`);
  await d.domClick('[data-workspace-guide]');
  await ready('agent-tab');
  await d.domClick('[data-guide-next]');
  await ready('agent-prompt');
  for (const [width, height] of [[860,650], [560,600]]) {
    await d.request('resize', { width, height });
    await checkGeometry();
  }
  await d.request('resize', { width:1400, height:950 });
  await d.domClick('.guide-skip');
  await closed();
  assert.equal(await d.evaluate(`document.querySelector('#prompt').value`), 'Keep this unsent draft');
  assert.equal(await shell(`__initialFrame.contentWindow.performance.timeOrigin === __initialOrigin`), true);
  // Persistence is per tab across reload, not one global completion flag.
  await reload();
  assert.equal((await d.query('#workspace-guide')).exists, false);
  for (const [workspace] of chapters) {
    if (workspace === 'local-apps') await d.domClick('.workspace-link[data-workspace="browser"]');
    await d.domClick(workspace === 'local-apps' ? '[data-pc-view="local-apps"]' : `.workspace-link[data-workspace="${workspace}"]`);
    assert.equal((await d.query('#workspace-guide')).exists, false);
  }
  await shell(`localStorage.setItem('profilepilot-workspace-theme', 'dark'); true`);
  await d.domClick('[data-workspace-guide]');
  await ready('local-apps-tab');
  assert.equal(await shell(`getComputedStyle(document.querySelector('.guide-card')).backgroundColor`), 'rgb(30, 42, 60)');
  await capture('dark');
  await shell(`document.querySelector('#workspace-guide').dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true })); true`);
  await closed();
  await shell(`window.__originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new DOMException('Storage unavailable', 'QuotaExceededError'); }; true`);
  await d.domClick('[data-workspace-guide]');
  await ready('local-apps-tab');
  await d.domClick('.guide-skip');
  await closed();
  await shell(`Storage.prototype.setItem = window.__originalSetItem; true`);
  assert.deepEqual(app.output().stderr.match(/Uncaught (?:Exception|Error|TypeError)/g) || [], []);
  console.log('PASS per-tab tours: first visit, direct tab switching, completion/dismissal persistence, manual replay, resizing, draft preservation, dark theme and storage failure');
} catch (error) {
  await capture('failure').catch(() => {});
  throw error;
} finally { await app.stop(); }
