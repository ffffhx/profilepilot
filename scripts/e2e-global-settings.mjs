import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchProfilePilotE2e, repoRoot, delay } from './e2e/lib/electron-driver.mjs';

const app = await launchProfilePilotE2e({ mode: 'background', experimentalAgent: false });
const d = app.driver;
const toggle = '[data-action="toggle-startup"]';
const waitStatus = text => d.waitFor('#startup-status', s => s.text === text);
try {
  const agentLink = '.workspace-link[data-workspace="agent"]';
  const agentToggle = '[data-action="toggle-experimental-agent"]';
  const agentVisible = () => d.evaluate(`document.querySelector(${JSON.stringify(agentLink)}).getBoundingClientRect().width > 0`, { target: 'shell' });
  assert.equal(await agentVisible(), false, 'Agent is hidden by default');
  assert.equal(await d.evaluate('document.documentElement.dataset.workspace', { target: 'shell' }), 'browser');
  assert.equal((await d.query(toggle)).exists, false);
  assert.equal((await d.query('[data-action="open-mini-window"]')).exists, false);
  assert.ok(!(await d.windows()).mini?.visible, 'floating window starts hidden');
  await d.domClick('.workspace-settings', { target: 'shell' });
  await d.waitFor('.global-settings');
  const supported = ['win32', 'darwin'].includes(process.platform);
  await waitStatus(supported ? '已开启' : '不可用');
  assert.equal((await d.query(agentToggle)).attributes['aria-checked'], 'false');
  assert.match((await d.query('#experimental-agent-description')).text, /默认隐藏/);
  assert.equal((await d.query('#settings-form')).exists, false, 'global settings has no Agent model form');
  assert.equal(await d.evaluate(`document.querySelector('.workspace-settings').getAttribute('aria-current')`, { target: 'shell' }), 'page');
  if (supported) {
    await d.domClick(toggle);
    await waitStatus('已关闭');
    assert.equal((await d.query(toggle)).attributes['aria-checked'], 'false');
    assert.equal(JSON.parse(await readFile(path.join(app.dataDir, 'startup-settings.json'), 'utf8')).enabled, false);
    // Changing system login items outside this page must update on return.
    await d.domClick('.workspace-link[data-workspace="browser"]');
    await d.evaluate('window.profileManager.setStartupEnabled(true)');
    await d.domClick('.workspace-settings');
    await waitStatus('已开启');
    await d.domClick(toggle);
    await waitStatus('已关闭');
    await d.domClick(toggle);
    await waitStatus('已开启');
  }
  // Platform and failure states must be visible without misleading "off" text.
  await d.evaluate(`window.__readStartup = window.profileManager.getStartupSettings; true`);
  const states = [
    [{ supported:true, enabled:true, requiresApproval:true, error:null }, '待系统允许', false, '登录项'],
    [{ supported:false, enabled:false, requiresApproval:false, error:'请使用安装版 ProfilePilot 设置开机自启动。' }, '不可用', true, '安装版'],
    [{ supported:true, enabled:false, requiresApproval:false, error:'系统未应用设置，请重试。' }, '状态待确认', false, '重试']
  ];
  for (const [state, label, disabled, hint] of states) {
    await d.evaluate(`window.profileManager.getStartupSettings = async () => (${JSON.stringify(state)}); true`);
    await d.domClick('[data-action="refresh-startup"]');
    await waitStatus(label);
    assert.equal((await d.query(toggle)).disabled, disabled);
    assert.ok((await d.query('#startup-note')).text.includes(hint));
  }
  await d.evaluate(`window.profileManager.getStartupSettings = async () => { throw new Error('测试读取失败'); }; true`);
  await d.domClick('[data-action="refresh-startup"]');
  await waitStatus('状态待确认');
  assert.equal((await d.query(toggle)).disabled, true);
  assert.match((await d.query('#startup-note')).text, /测试读取失败/);
  await d.evaluate(`window.profileManager.getStartupSettings = window.__readStartup; true`);
  await d.domClick('[data-action="refresh-startup"]');
  await waitStatus(supported ? '已开启' : '不可用');
  // Agent retains its own configuration and unsaved fields across workspace changes.
  await d.domClick(agentToggle);
  await d.waitFor('#experimental-agent-status', s => s.text === '已开启');
  await d.waitFor(agentLink, s => s.hitMatches, { target: 'shell' });
  await d.domClick('.workspace-link[data-workspace="agent"]');
  await d.waitFor('.sidebar-footer [data-nav="settings"]');
  assert.equal((await d.query('.sidebar-footer [data-nav="settings"]')).text, 'Agent 设置');
  assert.equal((await d.query('.sidebar-footer [data-nav="settings"]')).hitMatches, true, 'Agent settings is visibly accessible');
  await d.domClick('.sidebar-footer [data-nav="settings"]');
  await d.waitFor('#settings-form');
  await d.domInput('#model', 'unsaved-settings-check');
  await d.domClick('.workspace-settings');
  await waitStatus(supported ? '已开启' : '不可用');
  await d.domClick(agentToggle);
  await d.waitFor('#experimental-agent-status', s => s.text === '已关闭');
  await d.waitFor(agentLink, s => !s.hitMatches, { target: 'shell' });
  await d.domClick(agentToggle);
  await d.waitFor(agentLink, s => s.hitMatches, { target: 'shell' });
  await d.domClick('.workspace-link[data-workspace="agent"]');
  assert.equal((await d.query('#model')).value, 'unsaved-settings-check');
  await d.domClick('.workspace-settings');
  await waitStatus(supported ? '已开启' : '不可用');
  // Saving the preference survives a shell reload, then closing the experiment
  // removes the entry again. Direct task links take users to the opt-in setting.
  await d.request('reload', { target: 'shell' });
  await delay(350);
  await d.waitFor('h1', s => s.text === 'PC 控制');
  assert.equal(await agentVisible(), true);
  await d.domClick('.workspace-settings', { target: 'shell' });
  await d.waitFor('#experimental-agent-status', s => s.text === '已开启');
  await d.domClick(agentToggle);
  await d.waitFor(agentLink, s => !s.hitMatches, { target: 'shell' });
  await d.evaluate(`window.workspaceHost.navigate('./tasks.html?task=disabled-link'); true`, { target:'shell' });
  await d.waitFor('.global-settings');
  assert.equal(await d.evaluate('document.documentElement.dataset.workspace', {target:'shell'}), 'settings');
  await d.request('reload', { target: 'shell' });
  await delay(350);
  await d.waitFor('h1', s => s.text === 'PC 控制');
  assert.equal(await agentVisible(), false, 'disabled preference also survives reload');
  await d.domClick('.workspace-settings', { target:'shell' });
  await d.waitFor('#experimental-agent-status', s=>s.text==='已关闭');
  for (const [width, height] of [[1400, 950], [560, 600]]) {
    await d.request('resize', { width, height });
    await delay(150);
    assert.equal(await d.evaluate('document.documentElement.scrollWidth > innerWidth'), false, 'settings fits the viewport');
    assert.equal((await d.query(toggle)).hitMatches, true);
  }
  await d.request('resize', { width:1400, height:950 });
  const directory = path.join(repoRoot, 'test-results', 'global-settings');
  await mkdir(directory, { recursive:true });
  await d.screenshot(); await delay(250);
  await writeFile(path.join(directory, 'settings.png'), Buffer.from((await d.screenshot()).pngBase64, 'base64'));
  console.log('PASS global settings: startup states, experimental Agent defaults/enable/disable/persistence, retained drafts, opt-in routing and responsive layout');
} finally {
  await app.stop();
}
