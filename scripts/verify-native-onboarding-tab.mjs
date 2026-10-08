import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { NativeOnboarding } = require('../dist/main/tasks/native-onboarding');
const { openNativeOnboardingTab } = require('../dist/main/tasks/native-onboarding-tab');
const { getDirectChromeCommand, focusProfileWindow, waitForChildExit } = require('../dist/main/chrome-launch');
const { CdpBrowserClient } = require('../dist/main/cdp-client');
const { runWindowsPowerShell } = require('../dist/main/windows-platform');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = await mkdtemp(path.join(os.tmpdir(), 'pp-onboarding-tab-'));
const onboarding = new NativeOnboarding('gmdaabnoocjlpimglalnbegfdaklfnaj');
const outcomes = [];
async function openSettings(url, page) {
  try { await openNativeOnboardingTab(url, page); outcomes.push({ ok: true }); }
  catch (error) { outcomes.push({ ok: false, message: error.cause?.stderr || error.cause?.message || error.message }); throw error; }
}
onboarding.configure({
  install: async () => {},
  prepare: async () => ({ extensionPath: root, version: 'test', digest: 'test' }),
  openSettings: (_id, url) => openSettings(url, 'debugging'),
  openExtensions: (_id, url) => openSettings(url, 'extensions')
}, () => {});
let port;
const intermediaryRequests = [];
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && /\/(local-install|open-debugging)$/.test(req.url || '')) intermediaryRequests.push(req.url);
  if (req.url === '/neighbor') { res.setHeader('Content-Type', 'text/html'); res.end('<title>Right-hand fixture tab</title>Keep this tab.'); return; }
  onboarding.handle(req, res, port);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
port = server.address().port;
const invitation = onboarding.create(port, 'PP1.fixture-only', '标签页回归测试', new Date(Date.now() + 300000).toISOString(), 'native:Default');
let child;
let client;
async function waitFor(read, description) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await read();
    if (result) return result;
    await pause(150);
  }
  throw Error(`Timed out: ${description}`);
}
async function chromeUi(browserPid) {
  return JSON.parse(await runWindowsPowerShell(`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::FromHandle((Get-Process -Id ${browserPid}).MainWindowHandle)
$tabCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
$editCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
$names = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCondition) | ForEach-Object { $_.Current.Name })
$values = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCondition) | ForEach-Object { $p = $null; if ($_.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { $p.Current.Value } })
@{ tabs = $names; addresses = $values } | ConvertTo-Json -Compress
`, { timeout: 8000 }));
}
try {
  // Disposable browser test fixture: never attach to the user's Chrome data.
  child = spawn(getDirectChromeCommand(), [`--user-data-dir=${root}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--remote-debugging-port=0', invitation], { stdio: 'ignore', windowsHide: true });
  const endpoint = await waitFor(async () => {
    const data = await readFile(path.join(root, 'DevToolsActivePort'), 'utf8').catch(() => '');
    const [debugPort, wsPath] = data.trim().split(/\r?\n/);
    return debugPort && wsPath && `ws://127.0.0.1:${debugPort}${wsPath}`;
  }, 'fixture Chrome endpoint');
  client = await CdpBrowserClient.connect(endpoint, 5000);
  const browserPid = (await client.send('SystemInfo.getProcessInfo')).processInfo.find(p => p.type === 'browser').id;
  const targets = async () => (await client.send('Target.getTargets')).targetInfos.filter(t => t.type === 'page');
  const source = await waitFor(async () => (await targets()).find(t => t.url === invitation), 'invitation tab');
  const sourceWindow = await client.send('Browser.getWindowForTarget', { targetId: source.targetId });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId: source.targetId, flatten: true });
  // Seed a visited extension detail URL, matching the inline completion in the
  // reported screenshot. Keep another tab to the right to verify adjacency.
  const historyUrl = 'chrome://extensions/?id=gmdaabnoocjlpimglalnbegfdaklfnaj';
  const seed = await client.send('Target.createTarget', { url: historyUrl });
  await waitFor(async () => (await targets()).find(t => t.targetId === seed.targetId && t.url.startsWith('chrome://extensions') && t.title), 'history seed');
  await pause(500);
  await client.send('Target.closeTarget', { targetId: seed.targetId });
  await client.send('Target.createTarget', { url: `http://127.0.0.1:${port}/neighbor` });
  let sourceNavigations = 0;
  const visitedUrls = new Map();
  await client.send('Page.enable', {}, 5000, sessionId);
  client.onEvent = (method, params, eventSession) => {
    if (eventSession === sessionId && method === 'Page.frameNavigated') sourceNavigations++;
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      const info = params.targetInfo;
      if (!visitedUrls.has(info.targetId)) visitedUrls.set(info.targetId, []);
      visitedUrls.get(info.targetId).push(info.url);
    }
  };
  await client.send('Target.setDiscoverTargets', { discover: true });
  for (const [selector, action, destination] of [['#open-extensions', 'local-install', 'chrome://extensions/'], ['#settings', 'open-debugging', 'chrome://inspect/#remote-debugging']]) {
    await client.send('Target.activateTarget', { targetId: source.targetId });
    const focused = await focusProfileWindow([browserPid]);
    assert.ok(focused, 'The disposable fixture must be foreground to simulate a user click');
    await pause(500);
    const before = await targets();
    const outcomeCount = outcomes.length;
    await client.send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)}).closest('details')?.setAttribute('open',''); document.querySelector(${JSON.stringify(selector)}).click()`,
      userGesture: true, returnByValue: true
    }, 20000, sessionId);
    await waitFor(() => outcomes.length > outcomeCount, 'new-tab opener result');
    assert.equal(outcomes.at(-1).ok, true, outcomes.at(-1).message);
    const created = await waitFor(async () => (await targets()).find(t => t.url === destination), destination);
    assert.equal((await targets()).length, before.length + 1);
    assert.equal((await client.send('Browser.getWindowForTarget', { targetId: created.targetId })).windowId, sourceWindow.windowId);
    assert.ok((await targets()).some(t => t.targetId === source.targetId && t.url === invitation));
    if (process.platform === 'win32') {
      const ui = await chromeUi(browserPid);
      const sourceIndex = ui.tabs.findIndex(name => name.includes('连接系统 Chrome'));
      assert.ok(sourceIndex >= 0, JSON.stringify(ui));
      assert.ok(ui.tabs[sourceIndex + 1]?.includes(created.title), `New tab must be next to the invitation: ${JSON.stringify(ui)}`);
      await client.send('Target.activateTarget', { targetId: source.targetId });
      const sourceUi = await chromeUi(browserPid);
      assert.ok(sourceUi.addresses.some(value => value === invitation || 'http://' + value === invitation), 'Original omnibox must still show the invitation');
    }
    assert.equal(sourceNavigations, 0, 'Original tab must not navigate or reload');
    assert.deepEqual(intermediaryRequests, [], 'No intermediary page may be requested');
    assert.ok(!visitedUrls.get(created.targetId).some(url => url.startsWith('http:')), 'The new tab must go directly to Chrome settings');
    console.log(`PASS ${action}: adjacent settings tab, no intermediary page; original page and omnibox unchanged; history completion handled`);
  }
  const neighbor = (await targets()).find(t => t.url.endsWith('/neighbor'));
  await client.send('Target.activateTarget', { targetId: neighbor.targetId });
  const before = await targets();
  await assert.rejects(openNativeOnboardingTab(invitation, 'extensions'), /未能确认/);
  assert.equal((await targets()).length, before.length);
  console.log('PASS wrong active tab: no keystrokes or extra tabs/windows');
} finally {
  onboarding.close(); server.closeAllConnections(); server.close();
  if (client) {
    await client.send('Browser.close', {}, 2000).catch(() => {});
    client.close();
  }
  if (child && !await waitForChildExit(child, 3000)) child.kill();
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  if (process.platform === 'win32') {
    // Chrome can relaunch under a different PID before it writes its endpoint.
    // Stop only a surviving browser whose command line names this fixture root.
    await runWindowsPowerShell(`$fixtureRoot = '${root.replaceAll("'", "''")}'; Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine.Contains($fixtureRoot) -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`);
  }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
