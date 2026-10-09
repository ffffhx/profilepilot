// Render the actual extension HTML/CSS/JS in isolated Electron windows.
// Worker responses are fixtures; no user browser, account or control session is touched.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const root = await mkdtemp(path.join(os.tmpdir(), 'pp-native-status-'));
const output = path.resolve('test-results/native-status');
await mkdir(output, { recursive: true });
const preload = path.join(root, 'preload.cjs');
const fixture = path.join(root, 'fixture.cjs');
await writeFile(preload, `
window.statusFixture = { connected: true, profileId: 'native:Default', ownership: 'user' };
window.statusCalls = [];
window.chrome = {
  runtime: { sendMessage: async message => {
    window.statusCalls.push(message.method);
    if (message.method !== 'state') throw new Error('Unexpected action: ' + message.method);
    return { result: window.statusFixture };
  } },
  windows: { getCurrent: async () => ({ id: 1 }) },
  sidePanel: { open: async () => {} }
};
`);
await writeFile(fixture, `
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const [source, output, root] = process.argv.slice(2);
app.setPath('userData', path.join(root, 'user-data'));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 420, height: 600, useContentSize: true, show: false,
    webPreferences: { preload: path.join(root, 'preload.cjs'), contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  const checks = [];
  const evaluate = expression => win.webContents.executeJavaScript(expression);
  async function ready(label) {
    for (let i = 0; i < 100; i++) {
      if (await evaluate('document.querySelector("#connection-label")?.textContent === ' + JSON.stringify(label))) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw Error('Status did not settle: ' + label);
  }
  async function setState(state) {
    await evaluate('window.statusFixture = ' + JSON.stringify(state) + '; window.dispatchEvent(new Event("focus"));');
    await ready(state.connected ? '已连接' : state.profileId ? '未连接' : '尚未配对');
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  }
  async function check(name, expectedControl) {
    const layout = await evaluate('(' + function() {
      const body = document.body, card = document.querySelector('.identity-strip');
      const rect = card.getBoundingClientRect();
      const profile = document.querySelector('#profile-name').getBoundingClientRect();
      const status = document.querySelector('#connection-state').getBoundingClientRect();
      return { width: body.clientWidth, height: body.scrollHeight, scrollWidth: body.scrollWidth,
        text: body.innerText, cardFits: rect.left >= 0 && rect.right <= innerWidth,
        identityAligned: profile.right <= status.left + 1 || profile.bottom <= status.top + 1,
        control: document.querySelector('#control-state').textContent,
        controlsHidden: document.querySelector('#controlled-tab').hidden,
        visibleButtons: [...document.querySelectorAll('button')].filter(b => b.getClientRects().length).map(b => b.id),
        methods: window.statusCalls };
    }.toString() + ')()');
    assert.ok(layout.scrollWidth <= layout.width, name + ' horizontal overflow');
    assert.ok(layout.cardFits && layout.identityAligned, name + ' identity layout');
    assert.ok(layout.methods.every(method => method === 'state'), name + ' must be read only');
    if (expectedControl) assert.equal(layout.control, expectedControl);
    assert.doesNotMatch(layout.text, /临时安装|当前任务|任务对话|继续对话|开始任务|选中文字/);
    if (expectedControl === '空闲' || expectedControl === '正在控制' || expectedControl === '已暂停') {
      assert.ok(layout.visibleButtons.every(id => id === 'close-panel'));
    }
    const shot = await win.webContents.capturePage({ x: 0, y: 0, width: layout.width, height: Math.min(layout.height, 600) });
    writeFileSync(path.join(output, name + '.png'), shot.toPNG());
    checks.push({ name, width: layout.width, height: layout.height });
  }
  try {
    await win.loadFile(path.join(source, 'popup.html')); await ready('已连接');
    await check('popup-idle', '空闲');
    const active = { connected: true, profileId: 'native:Default', sessionId: 'fixture-session', ownership: 'agent',
      tabId: 7, tabTitle: 'ProfilePilot · 浏览器控制示例', url: 'https://example.test/browser' };
    await setState(active); await check('popup-active', '正在控制');
    await setState({ ...active, ownership: 'user' }); await check('popup-paused', '已暂停');
    await setState({ ...active, connected: false }); await check('popup-disconnected', '未连接');
    await setState({ connected: false }); await check('popup-unpaired');
    for (const width of [320, 420]) {
      win.setContentSize(width, 600);
      await win.loadFile(path.join(source, 'sidepanel.html')); await ready('已连接');
      await setState({ ...active, profileName: '这是一个比较长的工作 Profile 名称',
        tabTitle: '这是一个很长的网页标题，用于验证窄侧边栏的自动换行和布局对齐' });
      await check('sidepanel-' + width, '正在控制');
    }
    writeFileSync(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', platform: process.platform,
      scope: 'Actual extension DOM/CSS/module with local worker fixtures; no real Chrome transport or macOS hardware exercised', checks }, null, 2));
    console.log(JSON.stringify({ status: 'passed', checks: checks.length, output }));
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack); win.destroy(); app.exit(1); }
});
`);
try {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await promisify(execFile)(require('electron'), [fixture, path.resolve('extensions/profilepilot'), output, root], {
    env, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024
  });
  const report = JSON.parse(await readFile(path.join(output, 'result.json'), 'utf8'));
  assert.equal(report.status, 'passed');
  console.log(result.stdout.trim());
} finally {
  const tempBase = path.resolve(os.tmpdir()) + path.sep;
  assert.ok(path.resolve(root).startsWith(tempBase), 'only remove this fixture inside the temporary directory');
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
