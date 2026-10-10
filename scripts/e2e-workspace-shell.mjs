import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';
const { PNG } = createRequire(import.meta.url)('pngjs');
const app = await launchProfilePilotE2e({ name: 'persistent desktop shell' });
const d = app.driver;
const shell = expression => d.evaluate(expression, { target: 'shell' });
const directory = path.join(repoRoot, 'test-results', 'workspace-shell');
const workspaces = ['agent', 'browser', 'local-apps', 'phones', 'tools'];
const origins = new Map();
const samples = [];

function pixel(png, x, y) {
  const offset = (Math.round(y) * png.width + Math.round(x)) * 4;
  return [...png.data.subarray(offset, offset + 3)];
}
async function checkShell(label) {
  const state = await shell(`({
    sameDocument: window.__shellDocument === document && window.__shellOrigin === performance.timeOrigin,
    sameRail: window.__shellRail === document.querySelector('.workspace-rail'),
    sameHeader: window.__shellHeader === document.querySelector('.workspace-identity'),
    headerText: document.querySelector('.workspace-identity').textContent.trim(),
    active: [...document.querySelectorAll('iframe[data-active="true"]')].map(f => f.dataset.workspace),
    visible: [...document.querySelectorAll('iframe')].filter(f => getComputedStyle(f).visibility === 'visible').map(f => f.dataset.workspace),
    count: document.querySelectorAll('iframe').length,
    width: innerWidth,
    height: innerHeight,
    railWidth: document.querySelector('.workspace-rail').getBoundingClientRect().width
  })`);
  assert.equal(state.sameDocument, true, `${label}: desktop document was replaced`);
  assert.equal(state.sameRail, true, `${label}: rail was replaced`);
  assert.equal(state.sameHeader, true, `${label}: title bar was replaced`);
  assert.equal(state.headerText, '', `${label}: the title bar must not show connection status`);
  assert.equal(state.active.length, 1, `${label}: no active content`);
  assert.deepEqual(state.visible, state.active);
  assert.ok(state.count <= 6);
  const image = await d.screenshot();
  const png = PNG.sync.read(Buffer.from(image.pngBase64, 'base64'));
  const sx = png.width / state.width, sy = png.height / state.height;
  // Sample permanent areas during navigation, including the first visit to a tab.
  const rail = pixel(png, 5 * sx, state.height * .55 * sy);
  const title = pixel(png, (state.railWidth + 8) * sx, 8 * sy);
  assert.deepEqual(rail, [237, 246, 255], `${label}: rail flashed`);
  assert.deepEqual(title, [246, 250, 255], `${label}: title bar flashed`);
  samples.push({ label, active: state.active[0], rail, title });
}

try {
  await mkdir(directory, { recursive: true });
  await shell(`window.__shellDocument = document; window.__shellRail = document.querySelector('.workspace-rail'); window.__shellHeader = document.querySelector('.workspace-identity'); window.__shellOrigin = performance.timeOrigin; true`);
  await checkShell('initial');
  // Delay readiness to exercise a slow first load without destroying the old UI.
  await shell(`window.__originalReady = window.workspaceHost.ready;
    window.workspaceHost.ready = source => {
      if (source.location.pathname.endsWith('/phones.html')) window.__delayedPhone = source;
      else window.__originalReady(source);
    }; true`);
  await d.domClick('.workspace-link[data-workspace="phones"]');
  await checkShell('slow first phone load');
  assert.equal(await shell(`document.documentElement.dataset.workspace`), 'browser');
  // Clicking the current tab also cancels an unfinished switch.
  await d.domClick('.workspace-link[data-workspace="browser"]');
  assert.equal(await shell(`document.documentElement.dataset.workspaceLoading`), 'false');
  // A late response from the first click must never replace a newer selection.
  await d.domClick('.workspace-link[data-workspace="tools"]');
  await d.waitFor('h1', s => s.text === '配套工具');
  await shell(`window.workspaceHost.ready = window.__originalReady; if (window.__delayedPhone) window.__originalReady(window.__delayedPhone); true`);
  assert.equal(await shell(`document.documentElement.dataset.workspace`), 'tools');

  for (let round = 0; round < 4; round++) {
    for (const workspace of workspaces) {
      const started = performance.now();
      await d.domClick(workspace === 'local-apps' ? '[data-pc-view="local-apps"]' : `.workspace-link[data-workspace="${workspace}"]`);
      await d.waitFor(`html[data-workspace="${workspace}"][data-workspace-loading="false"]`, s => s.exists, { target:'shell' });
      await checkShell(`${round}/${workspace}`);
      assert.equal(await shell(`document.documentElement.dataset.workspace`), workspace);
      const origin = await d.evaluate('performance.timeOrigin');
      if (origins.has(workspace)) assert.equal(origin, origins.get(workspace), `${workspace} reloaded`);
      else origins.set(workspace, origin);
      samples.at(-1).elapsedMs = Math.round(performance.now() - started);
      if (workspace === 'agent') {
        if (round === 0) await d.domInput('#prompt', '切换后保留原页面与草稿');
        else assert.equal(await d.evaluate(`document.querySelector('#prompt').value`), '切换后保留原页面与草稿');
      }
      if (round === 0) {
        await d.evaluate(`window.__pageMarker = {}; window.__originalMarker = window.__pageMarker; true`);
        await writeFile(path.join(directory, `${workspace}.png`), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
      } else assert.equal(await d.evaluate('window.__pageMarker === window.__originalMarker'), true);
    }
  }
  // Global settings is its own workspace; Agent configuration stays in Agent.
  await d.domClick('.workspace-settings');
  await d.waitFor('.global-settings');
  assert.equal(await shell(`document.querySelector('.workspace-settings').getAttribute('aria-current')`), 'page');
  assert.equal((await d.query('#settings-form')).exists, false);
  await checkShell('global-settings');
  await d.domClick('.workspace-link[data-workspace="agent"]');
  await d.domClick('.sidebar-footer [data-nav="settings"]');
  await d.waitFor('[data-nav="settings"].active');
  assert.equal(await d.evaluate('performance.timeOrigin'), origins.get('agent'));
  await checkShell('settings');
  const scroll = await d.evaluate(`(() => {
    window.__scrollProbe = [...document.querySelectorAll('*')].find(node => /auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 120);
    if (!window.__scrollProbe) return 0;
    window.__scrollProbe.scrollTop = 120;
    return window.__scrollProbe.scrollTop;
  })()`);
  assert.ok(scroll > 0, 'settings must exercise a real scrolling container');
  await d.domClick('.workspace-link[data-workspace="browser"]');
  await d.domClick('.workspace-link[data-workspace="agent"]');
  assert.equal(await d.evaluate('window.__scrollProbe.scrollTop'), scroll, 'cached page retains its scroll position');
  await d.domClick('[data-action="return-agent"]');
  await d.waitFor('#prompt');
  const profile = await d.evaluate(`window.profileManager.createProfile('固定顶部栏测试').then(s=>s.profiles.find(p=>p.name==='固定顶部栏测试'))`);
  assert.equal(await shell(`!!document.querySelector('#workspace-profile')`), false);
  await d.waitFor('select[name="profileId"]', s => s.text.includes('固定顶部栏测试'));
  await d.domInput('select[name="profileId"]', profile.id);
  await d.waitFor('select[name="profileId"]', s => s.value === profile.id);
  await d.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'k', ctrlKey:true, metaKey:true, bubbles:true })); true`);
  assert.equal(await d.evaluate(`!!document.querySelector('dialog[open]')`), true, 'Agent command shortcut still works without header search');
  await d.evaluate(`document.querySelector('dialog[open]').close(); true`);
  await d.domClick('.workspace-link[data-workspace="browser"]');
  await d.waitFor(`[data-profile-row][data-id="${profile.id}"]`);
  await d.domClick(`[data-profile-row][data-id="${profile.id}"]`);
  await d.waitFor('.browser-profile-inspector h2', s => s.text === '固定顶部栏测试');
  assert.equal(await shell(`document.querySelector('.workspace-identity').textContent.trim()`), '', 'list selection does not restore the removed header status');
  await assert.rejects(d.evaluate(`window.phones.start('fixture', 'control', 'fixture', 'must reject')`), /手机工作区/);
  await assert.rejects(d.evaluate(`window.localApps.list()`), /本地应用工作区/);
  await d.domClick('.workspace-link[data-workspace="phones"]');
  assert.deepEqual((await d.evaluate('window.phones.snapshot()')).devices, []);
  assert.equal(typeof (await d.evaluate('window.mobile.snapshot()')).enabled, 'boolean');
  // Untrusted paths, network URLs and mini mode cannot become content panes.
  for (const href of ['https://example.com/', '../README.md', './index.html?mode=mini', 'data:text/html,test']) {
    assert.equal(await shell(`window.workspaceHost.navigate(${JSON.stringify(href)})`), false);
  }
  assert.equal(await shell(`document.querySelectorAll('iframe').length`), 6);
  // Both sidebars act independently, keep the draft, and leave an expand control visible.
  await d.domClick('.workspace-link[data-workspace="agent"]');
  await d.domClick('[data-nav="tasks"]');
  const draft = (await d.query('#prompt')).value;
  const paint = () => shell('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  for (const width of [1400, 800]) {
    await d.request('resize', { width, height:800 });
    for (const rail of ['expanded', 'collapsed']) {
      if (await shell('document.documentElement.dataset.workspaceRail') !== rail) await d.domClick('[data-toggle-workspace-rail]', { target:'shell' });
      await paint();
      const railState = await shell(`(() => {
        const aside=document.querySelector('.workspace-rail'), button=document.querySelector('[data-toggle-workspace-rail]');
        return { width:aside.getBoundingClientRect().width, contentLeft:document.querySelector('#workspace-pages').getBoundingClientRect().left,
          labels:[...aside.querySelectorAll('.workspace-link>span')].every(n=>getComputedStyle(n).display!=='none'),
          expanded:button.getAttribute('aria-expanded'), drag:getComputedStyle(button).getPropertyValue('-webkit-app-region'),
          buttonWidth:button.getBoundingClientRect().width };
      })()`);
      assert.equal(railState.labels, rail==='expanded');
      assert.equal(railState.expanded, String(rail==='expanded'));
      assert.equal(railState.drag, 'no-drag');
      assert.ok(railState.buttonWidth>0);
      assert.equal(railState.contentLeft, railState.width);
      assert.ok(rail==='collapsed' ? railState.width===64 : railState.width>150);
      for (const collapsed of [false, true]) {
        if (await d.evaluate('document.querySelector("#task-app").classList.contains("sidebar-collapsed")') !== collapsed) await d.domClick('#task-sidebar-toggle');
        await paint();
        const state = await d.evaluate(`(() => {
          const sidebar=document.querySelector('#task-sidebar'), button=document.querySelector('#task-sidebar-toggle'), workspace=document.querySelector('.workspace');
          return {hidden:getComputedStyle(sidebar).display==='none', expanded:button.getAttribute('aria-expanded'),
            button:button.getBoundingClientRect().width, left:workspace.getBoundingClientRect().left,
            overflow:document.documentElement.scrollWidth>innerWidth,
            dockBottom:document.querySelector('.compose-dock').getBoundingClientRect().bottom, bottom:workspace.getBoundingClientRect().bottom};
        })()`);
        assert.equal(state.hidden,collapsed);
        assert.equal(state.expanded,String(!collapsed));
        assert.ok(state.button>0);
        assert.ok(collapsed ? state.left===0 : state.left>100);
        assert.equal(state.overflow,false);
        assert.ok(Math.abs(state.dockBottom-state.bottom)<2);
        assert.equal((await d.query('#prompt')).value,draft);
        await writeFile(path.join(directory, `sidebars-${width}-${rail}-${collapsed}.png`), Buffer.from((await d.screenshot()).pngBase64,'base64'));
      }
    }
  }
  await d.domClick('.workspace-link[data-workspace="phones"]');
  await d.waitFor('h1', s=>s.text==='手机控制');
  assert.equal(await shell('document.documentElement.dataset.workspaceRail'),'collapsed');
  await d.domClick('.workspace-link[data-workspace="agent"]');
  assert.equal((await d.query('#prompt')).value,draft);
  await shell('location.reload(); true');
  await d.waitFor('.workspace-link', s=>s.exists, {target:'shell'});
  await d.domClick('.workspace-link[data-workspace="agent"]');
  await d.waitFor('#task-sidebar-toggle', s=>s.attributes['aria-expanded']==='false');
  assert.equal(await shell('document.documentElement.dataset.workspaceRail'),'collapsed','navigation preference survives reload');
  await d.domClick('#task-sidebar-toggle');
  await d.waitFor('#task-sidebar-toggle', s=>s.attributes['aria-expanded']==='true');
  await d.domClick('[data-toggle-workspace-rail]', {target:'shell'});
  assert.equal(await shell('document.documentElement.dataset.workspaceRail'),'expanded');
  // Exercise graceful shutdown after all five content frames have subscribed.
  await d.request('quit');
  await new Promise((resolve, reject) => {
    if (app.child.exitCode !== null) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error('Cached workspaces did not close gracefully')), 10000);
    app.child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  assert.equal(app.child.exitCode, 0);
  await writeFile(path.join(directory, 'switches.json'), JSON.stringify(samples, null, 2));
  const errors = app.output().stderr.match(/Uncaught (?:Exception|Error|TypeError)|Object has been destroyed/g) || [];
  assert.deepEqual(errors, []);
  console.log(`PASS persistent desktop: ${samples.length} captured transitions, one shell/rail/header, five reused pages, slow-load/race handling, drafts/search/scroll state, settings/profile/search actions, IPC limits and graceful shutdown`);
} finally { await app.stop(); }
