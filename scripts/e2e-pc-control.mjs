import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchProfilePilotE2e, repoRoot } from './e2e/lib/electron-driver.mjs';

// The runtime suite covers real launch/stop. This isolated UI fixture exercises
// mixed application states and row targeting without launching user applications.
const app = await launchProfilePilotE2e({ name: 'PC control', experimentalAgent: false });
const d = app.driver;
const shell = expression => d.evaluate(expression, { target: 'shell' });
const directory = path.join(repoRoot, 'test-results', 'pc-control');
try {
  await mkdir(directory, { recursive: true });
  const capture = async name => {
    await d.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await writeFile(path.join(directory, name), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  };
  assert.equal((await d.query('h1')).text, 'PC 控制');
  assert.equal((await d.query('[data-pc-view="browser"][aria-current="page"]')).exists, true);
  assert.equal(await shell(`document.querySelectorAll('.workspace-link[data-workspace="local-apps"]').length`), 0);
  await capture('browser-profiles.png');
  const browserOrigin = await d.evaluate('performance.timeOrigin');
  await d.domClick('[data-pc-view="local-apps"]');
  await d.waitFor('.pc-apps-table');
  await d.request('resize', {width:1600,height:950});
  // Keep the disposable window hidden while simulating a visible pane.
  await d.evaluate('Object.defineProperty(document, "hidden", {configurable:true, get:() => false}); true');
  assert.equal(await shell(`document.querySelector('.workspace-link[aria-current="page"]').textContent.trim()`), 'PC 控制');
  const appsOrigin = await d.evaluate('performance.timeOrigin');
  const fixtures = Array.from({ length:24 }, (_, i) => ({
    id:`pc-app-${i}`, name:i === 0 ? '桌面笔记' : i === 1 ? '设计工具 · 工作项目' : `测试应用 ${i + 1}`,
    mode:'launch', cwd:'C:\\Projects\\Electron app', command:'must-not-execute', environment:'', createdAt:'2026-10-09T00:00:00.000Z',
    cdpPort:9333 + i, inspectPort:null, managed:false,
    controls:{ start:i !== 0, stop:false, restart:false },
    runtime:{ status:i === 0 ? 'running' : 'stopped', pid:null, startedAt:null, exitCode:null, error:'' },
    debug:{ renderer:i === 0, main:false, targets:[] }, agent:{ connected:i === 0 }
  }));
  await d.evaluate(`window.__pcApps = ${JSON.stringify(fixtures)}; window.localApps.list = async () => window.__pcApps; window.__pcStarts = []; window.localApps.start = async id => { window.__pcStarts.push(id); }; true`);
  await d.evaluate(`
    window.__pcShows = []; window.__pcPreviews = []; window.__pcControls = [];
    window.localApps.showWindow = async id => { window.__pcShows.push(id); };
    window.localApps.preview = async id => {
      window.__pcPreviews.push(id);
      return { screenshot:'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="380"><rect width="600" height="380" fill="#f1f5fc"/><rect x="25" y="25" width="110" height="330" rx="8" fill="#dbe7fc"/><rect x="155" y="25" width="420" height="55" rx="8" fill="white"/><rect x="155" y="100" width="420" height="255" rx="8" fill="white"/></svg>'), title:id, capturedAt:new Date().toISOString() };
    };
    window.localApps.agentControl = async (id, action) => {
      window.__pcControls.push([id, action]);
      const app = window.__pcApps.find(item => item.id === id);
      if (action === 'stop') delete app.agent.sessionId;
      else app.agent.ownership = action === 'takeover' ? 'user' : 'agent';
    };
    window.__pcApps[0].agent = {connected:true, sessionId:'session-0', name:'Codex', ownership:'agent', connectionActive:true, targetTitle:'项目笔记'};
    window.localApps.connect = async id => { throw new Error('请先打开应用，再检查连接。'); };
    true
  `);
  await d.domClick('.app-topbar [data-action="refresh"]');
  await d.waitFor('[data-app-row]', s => s.count === fixtures.length);
  assert.deepEqual(await d.evaluate(`[...document.querySelectorAll('.pc-apps-table th')].map(e => e.textContent)`), ['应用', '运行状态', 'Agent 可用性', '当前 Agent', '操作']);
  assert.equal((await d.query('.target-row, .connection-grid, .app-port, [data-action="debug"]')).exists, false);
  await d.domClick('[data-app-row="pc-app-0"] td:nth-child(2)');
  await d.waitFor('.app-preview-screen img');
  assert.match((await d.query('.app-agent-person')).text, /Codex/);
  await d.domClick('[data-app-id="pc-app-0"][data-action="show"]');
  await d.waitFor('[data-agent-control="takeover"]', s => !s.disabled);
  assert.deepEqual(await d.evaluate('window.__pcShows'), ['pc-app-0']);
  await d.domClick('[data-agent-control="takeover"]');
  await d.waitFor('[data-agent-control="return"]', s => !s.disabled);
  assert.match((await d.query('[data-app-row="pc-app-0"]')).text, /已由你接管/);
  await d.domClick('[data-agent-control="return"]');
  await d.waitFor('[data-agent-control="takeover"]', s => !s.disabled);
  assert.deepEqual(await d.evaluate('window.__pcControls'), [['pc-app-0','takeover'], ['pc-app-0','return']]);

  await d.domClick('[data-app-id="pc-app-1"][data-action="start"]');
  await d.waitFor('.app-content h2', s => s.text === fixtures[1].name);
  assert.deepEqual(await d.evaluate('window.__pcStarts'), ['pc-app-1'], 'row operation must use its own application, even when another row is selected');
  assert.equal((await d.query('[data-app-row].selected')).attributes['data-app-row'], 'pc-app-1');
  await d.domInput('.app-search', '桌面笔记');
  await d.waitFor('[data-app-row]', s => s.count === 1);
  await d.domInput('.app-search', '没有这个应用');
  assert.match((await d.query('.app-list-empty')).text, /没有匹配/);
  await d.domInput('.app-search', '');
  await d.waitFor('[data-app-row]', s => s.count === fixtures.length);

  // Connection errors stay readable and must not invent a successful connection.
  await d.evaluate('window.__pcApps[2].controls.start=false; true');
  await d.domClick('.app-topbar [data-action="refresh"]');
  await d.waitFor('[data-app-id="pc-app-2"][data-action="connect"]', s => !s.disabled);
  await d.domClick('[data-app-id="pc-app-2"][data-action="connect"]');
  await d.domClick('.app-connection-dialog [data-check]');
  await d.waitFor('.connection-result', s => s.text.includes('请先打开应用'));
  await d.domClick('.app-connection-dialog [data-close]');
  await d.domClick('[data-app-id="pc-app-1"][data-action="more"]');
  await d.domClick('.app-menu [data-action="edit"]');
  assert.equal(await d.evaluate('document.querySelector(".app-form [name=name]").value'), '设计工具 · 工作项目');
  await d.domClick('[data-cancel]');
  await d.domClick('[data-app-row="pc-app-0"] td:nth-child(2)');
  await d.waitFor('.app-preview-screen img');
  const scroll = await d.evaluate('window.scrollTo(0, 200); window.scrollY');
  assert.ok(scroll > 0);

  const capturesBeforeHidden = await d.evaluate('window.__pcPreviews.length');
  await d.domClick('[data-pc-view="browser"]');
  assert.equal(await d.evaluate('performance.timeOrigin'), browserOrigin);

  await new Promise(resolve => setTimeout(resolve, 5100));
  assert.equal(await shell(`document.querySelector('iframe[name="workspace-local-apps"]').contentWindow.__pcPreviews.length`), capturesBeforeHidden, 'hidden workspace must not capture');
  await d.domClick('[data-pc-view="local-apps"]');
  assert.equal(await d.evaluate('performance.timeOrigin'), appsOrigin);
  assert.equal(await d.evaluate('window.scrollY'), scroll);
  assert.equal((await d.query('[data-app-row].selected')).attributes['data-app-row'], 'pc-app-0');
  await d.evaluate('window.scrollTo(0,0); true');
  await d.domClick('[data-app-row="pc-app-0"] td:nth-child(2)');
  await d.waitFor('.app-preview-screen img');
  for (const width of [1440, 1000]) {
    await d.request('resize', { width, height:950 });
    await capture(`electron-apps-${width}.png`);
    assert.equal(await d.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true, 'table must not force horizontal page overflow');
    assert.equal((await d.query('[data-pc-view="browser"]')).hitMatches, true);
    assert.equal((await d.query('.app-topbar [data-action="add"]')).hitMatches, true);
  }
  // Deep links still resolve to the same pane; PC navigation always defaults to Profiles.
  await d.domClick('.workspace-link[data-workspace="phones"]');
  await d.domClick('.workspace-link[data-workspace="browser"]');
  assert.equal((await d.query('[data-pc-view="browser"][aria-current="page"]')).exists, true);
  assert.equal(await shell(`window.workspaceHost.navigate('./local-apps.html')`), true);
  await d.waitFor('[data-pc-view="local-apps"][aria-current="page"]');
  assert.equal(await shell(`document.querySelector('.workspace-link[aria-current="page"]').dataset.workspace`), 'browser');
  console.log('PASS PC control: unified navigation, Profiles default, cached selection/scroll, table columns, search/empty states, row action targeting, responsive layout and old deep links');
} finally {
  await app.stop();
}
