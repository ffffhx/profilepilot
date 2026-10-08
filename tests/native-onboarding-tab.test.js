const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const windows = require('../dist/main/windows-platform');
const fsUtil = require('../dist/main/fs-util');
const { openNativeOnboardingTab } = require('../dist/main/tasks/native-onboarding-tab');
const { nativeOnboardingPage } = require('../dist/main/tasks/native-onboarding-page');
const sourceUrl = 'http://127.0.0.1:19000/profilepilot-connect/' + 'a'.repeat(48);
const invitation = sourceUrl;

function platform(t, value) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
}

test('invalid invitations and destinations cannot reach either OS automation entrypoint', async t => {
  const win = t.mock.method(windows, 'runWindowsPowerShell', async () => { throw Error('must not run'); });
  const mac = t.mock.method(fsUtil, 'execFileAsync', async () => { throw Error('must not run'); });
  for (const url of [undefined, '', sourceUrl + '/local-install', sourceUrl + '/open-debugging', 'https://example.com/', invitation + "'; throw 'bad", invitation.replace('127.0.0.1', 'attacker.test')]) {
    await assert.rejects(openNativeOnboardingTab(url, 'extensions'), /连接页面无效/);
  }
  await assert.rejects(openNativeOnboardingTab(invitation, 'other'), /连接页面无效/);
  assert.equal(win.mock.callCount(), 0);
  assert.equal(mac.mock.callCount(), 0);
});

test('Windows requires confirmed tab opening and returns manual instructions on uncertainty without retry', async t => {
  platform(t, 'win32');
  const call = t.mock.method(windows, 'runWindowsPowerShell', async () => 'opened\r\n');
  await openNativeOnboardingTab(invitation, 'extensions');
  assert.equal(call.mock.callCount(), 1);
  call.mock.mockImplementation(async () => '');
  await assert.rejects(openNativeOnboardingTab(invitation, 'extensions'), /chrome:\/\/extensions\//);
  assert.equal(call.mock.callCount(), 2);
  call.mock.mockImplementation(async () => { throw Error('focus changed'); });
  await assert.rejects(openNativeOnboardingTab(sourceUrl, 'debugging'), /chrome:\/\/inspect\/#remote-debugging/);
  assert.equal(call.mock.callCount(), 3);
});

test('macOS creates an adjacent tab with the destination URL and handles missing automation permission', async t => {
  platform(t, 'darwin');
  const call = t.mock.method(fsUtil, 'execFileAsync', async () => ({ stdout: '' }));
  await openNativeOnboardingTab(invitation, 'extensions');
  assert.equal(call.mock.calls[0].arguments[0], 'osascript');
  const script = call.mock.calls[0].arguments[1][1];
  assert.ok(script.includes(invitation));
  assert.match(script, /make new tab at after tab sourceIndex with properties \{URL:"chrome:\/\/extensions\/"\}/);
  assert.doesNotMatch(script, /set URL of|make new window/);
  call.mock.mockImplementation(async () => { throw Error('Not authorized'); });
  await assert.rejects(openNativeOnboardingTab(invitation, 'extensions'), /地址栏输入 chrome:\/\/extensions\//);
  assert.equal(call.mock.callCount(), 2);
});

test('opening failures stay visible after status polling and clear on the next explicit attempt', async () => {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { hidden: false, disabled: false, textContent: '', after() {}, setAttribute() {} });
    return elements.get(selector);
  };
  const button = { dataset: { action: 'local-install' } };
  const error = element('error');
  let fail = true;
  const context = vm.createContext({
    document: { querySelector: element, querySelectorAll: () => [button], createElement: () => error },
    location: { pathname: new URL(invitation).pathname }, setTimeout() {},
    fetch: async (_url, options) => options
      ? { ok: !fail, json: async () => ({ error: '请在地址栏输入 chrome://extensions/' }) }
      : { ok: true, json: async () => ({ stage: 'confirm-tab', message: '准备完成' }) }
  });
  const script = /<script nonce="test">([\s\S]*?)<\/script>/.exec(nativeOnboardingPage('Profile', '', '', 'test'))[1];
  vm.runInContext(script, context);
  await button.onclick();
  await vm.runInContext('poll()', context);
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /chrome:\/\/extensions/);
  assert.equal(button.disabled, false);
  fail = false;
  await button.onclick();
  assert.equal(error.hidden, true);
});
