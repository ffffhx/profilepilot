import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';

const app = await launchProfilePilotE2e({ name: 'workspace spotlight tour', onboarding: true, env: { CPM_START_VIEW: 'tasks' } });
const d = app.driver;
const shell = expression => d.evaluate(expression, { target: 'shell' });
const key = 'profilepilot:workspace-guide:v2';
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
  await d.waitFor('h1', state => state.text === 'Agent');
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
      focused: tour.contains(document.activeElement), cardFits: card.left >= 0 && card.right <= innerWidth + 1 && card.top >= 0 && card.bottom <= innerHeight + 1,
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
  await ready('agent-tab');
  assert.equal(await shell(`document.querySelector('#workspace-guide').matches(':modal')`), true);
  assert.equal(await shell(`localStorage.getItem(${JSON.stringify(key)})`), null);
  await checkGeometry();
  assert.equal(await shell(`(() => { const target = document.querySelector('.workspace-link[data-workspace="agent"]').getBoundingClientRect(); return document.querySelector('#workspace-guide').contains(document.elementFromPoint(target.left + target.width/2, target.top + target.height/2)); })()`), true, 'native modal blocks clicks through spotlight hole');
  await capture('spotlight-agent-tab');
  for (const [width, height] of [[860, 600], [560, 600]]) {
    await d.request('resize', { width, height });
    await checkGeometry();
    await capture(`spotlight-${width}`);
  }
  await d.request('resize', { width: 1400, height: 950 });
  await tick();
  await d.domClick('.guide-skip');
  await closed();
  await d.domInput('#prompt', '保留这份未发送的任务草稿');
  await shell(`window.__initialFrame = document.querySelector('iframe[data-active="true"]'); window.__initialOrigin = __initialFrame.contentWindow.performance.timeOrigin; document.querySelector('[data-workspace-guide]').focus(); true`);
  await d.domClick('[data-workspace-guide]');
  const ids = ['agent-tab', 'agent-new', 'agent-prompt', 'agent-profile', 'browser-tab', 'browser-new', 'browser-profiles', 'local-apps-tab', 'apps-add', 'apps-list', 'phones-tab', 'phone-connect', 'phone-mobile', 'tools-tab', 'tools-extension', 'tools-cli', 'tools-preferences', 'settings'];
  for (const id of ids) {
    await ready(id);
    await checkGeometry();
    if (['agent-prompt', 'browser-new', 'phone-connect', 'phone-mobile', 'tools-extension'].includes(id)) await capture(`spotlight-${id}`);
    assert.equal(await d.evaluate(`!!document.querySelector('dialog[open], .onboarding-backdrop')`), false, 'tour must not trigger product actions or old prompts');
    console.log(`PASS spotlight ${id}`);
    await d.domClick('[data-guide-next]');
  }
  await closed();
  assert.equal(await shell(`localStorage.getItem(${JSON.stringify(key)})`), 'completed');
  assert.equal(await shell(`document.querySelector('iframe[data-active="true"]') === __initialFrame && __initialFrame.contentWindow.performance.timeOrigin === __initialOrigin`), true);
  assert.equal(await d.evaluate(`document.querySelector('#prompt').value`), '保留这份未发送的任务草稿');
  assert.equal(await shell(`document.querySelector('iframe[data-workspace="phones"]').contentDocument.querySelector('[data-phone-options]').open`), false, 'disclosure state restored');
  assert.equal(await shell(`document.activeElement.hasAttribute('data-workspace-guide')`), true);
  await reload();
  assert.equal((await d.query('#workspace-guide')).exists, false);
  await d.domClick('[data-workspace-guide]');
  await ready('agent-tab');
  await shell(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, metaKey: true, bubbles: true })); true`);
  assert.equal(await d.evaluate(`!!document.querySelector('dialog[open]')`), false);
  assert.equal(await shell(`document.querySelector('[data-workspace-guide]').focus(); document.querySelector('#workspace-guide').contains(document.activeElement)`), true);
  await d.domInput('[data-guide-chapter]', 'browser');
  await ready('browser-tab');
  await d.domClick('[data-guide-next]');
  await ready('browser-new');
  await d.evaluate(`(() => { const button = document.querySelector('[data-action="new-profile"]'); const replacement = button.cloneNode(true); replacement.style.marginTop = '25px'; button.replaceWith(replacement); return true; })()`);
  await checkGeometry();
  await d.evaluate(`window.__tourButton = document.querySelector('[data-action="new-profile"]'); __tourButton.style.display = 'none'; true`);
  await tick();
  assert.equal(await shell(`document.querySelector('.guide-spotlight').hidden`), true);
  await d.evaluate(`window.__tourButton.style.display = ''; true`);
  await ready('browser-new');
  await checkGeometry();
  await d.domClick('[data-guide-back]');
  await ready('browser-tab');
  await shell(`document.querySelector('#workspace-guide').requestClose(); true`);
  await closed();
  assert.equal(await shell(`document.documentElement.dataset.workspace`), 'agent');
  await shell(`localStorage.removeItem(${JSON.stringify(key)}); localStorage.setItem('profilepilot:workspace-guide:v1', 'completed'); true`);
  await reload();
  await ready('agent-tab');
  await d.domClick('.guide-skip');
  await closed();
  assert.equal(await shell(`localStorage.getItem(${JSON.stringify(key)})`), 'dismissed');
  await reload();
  assert.equal((await d.query('#workspace-guide')).exists, false);
  await d.domClick('.workspace-link[data-workspace="tools"]');
  await d.waitFor('h1', state => state.text === '配套工具');
  await d.domClick('[data-workspace-guide]');
  await ready('agent-tab');
  await d.domClick('.guide-skip');
  await closed();
  assert.equal(await shell(`document.documentElement.dataset.workspace`), 'tools');
  await shell(`window.workspaceHost.ready(document.querySelector('iframe[data-active="true"]').contentWindow); true`);
  assert.equal((await d.query('#workspace-guide')).exists, false);
  await d.request('resize', { width: 860, height: 650 });
  await d.domClick('[data-workspace-guide]');
  for (const [chapter, target, next] of [['agent', 'agent-prompt', 2], ['local-apps', 'apps-list', 2], ['phones', 'phone-connect', 1], ['tools', 'tools-cli', 2]]) {
    await d.domInput('[data-guide-chapter]', chapter);
    await ready(`${chapter}-tab`);
    for (let step = 0; step < next; step++) await d.domClick('[data-guide-next]');
    await ready(target);
    await checkGeometry();
  }
  await capture('spotlight-compact-controls');
  await d.domClick('.guide-skip');
  await closed();
  await d.request('resize', { width: 1400, height: 950 });
  await shell(`localStorage.setItem('profilepilot-workspace-theme', 'dark'); true`);
  await d.domClick('[data-workspace-guide]');
  await ready('agent-tab');
  assert.equal(await shell(`getComputedStyle(document.querySelector('.guide-card')).backgroundColor`), 'rgb(30, 42, 60)');
  await capture('spotlight-dark');
  await shell(`window.__originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new DOMException('Storage unavailable', 'QuotaExceededError'); }; true`);
  await d.domClick('.guide-skip');
  await closed();
  await shell(`Storage.prototype.setItem = window.__originalSetItem; localStorage.removeItem('profilepilot-workspace-theme'); true`);
  assert.deepEqual(app.output().stderr.match(/Uncaught (?:Exception|Error|TypeError)/g) || [], []);
  console.log('PASS spotlight tour: 18 real targets, Tab navigation, geometry/resize, input blocking, draft/disclosure restoration, persistence/replay, dynamic targets, chapters/back/Escape, dark theme and storage failure');
} catch (error) {
  await capture('failure').catch(() => {});
  throw error;
} finally { await app.stop(); }
