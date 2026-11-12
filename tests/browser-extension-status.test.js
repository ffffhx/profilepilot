const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTsModule } = require('./helpers/load-ts-module');

const profile = { id: 'native:Default', name: '日常 Chrome', source: 'native' };
const receipt = { profileId: profile.id, stage: 'connected', message: '连接成功，可以返回 ProfilePilot 开始任务。以后会自动重连。' };
const online = { profileId: profile.id, connected: true, taskTabs: true, ownership: 'user', extensionVersion: '0.2.17', capabilities: ['tabs'] };
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const { nativeBrowserSettings } = loadTsModule('src/renderer/native-browser-settings.ts');
function fixture() {
  const store = { state: { profiles: [profile] }, nativeExtensionProfileId: profile.id,
    nativeExtensionBrowsers: [online], nativeExtensionService: { status: 'connected' }, nativeExtensionInstallations: [receipt] };
  const { renderBrowserExtensionPanel: render } = loadTsModule('src/renderer/render/browser-extension.ts', {
    stubs: { '../state': { store }, '../util': { escapeHtml: escape, renderButtonLabel: (busy, idle, active) => busy ? active : idle } }
  });
  return { store, render, settings: () => nativeBrowserSettings([profile], store.nativeExtensionBrowsers, undefined, undefined, store.nativeExtensionInstallations, store.nativeExtensionService) };
}

test('live disconnect and reconnect supersede installation success in tools and settings', () => {
  const { store, render, settings } = fixture();
  assert.match(render(), />已连接<\/span>/);
  assert.match(render(), /日常 Chrome/);
  store.nativeExtensionBrowsers = [{ profileId: profile.id, connected: false, ownership: 'user' }];
  for (const html of [render(), settings()]) {
    assert.match(html, /扩展当前未连接|扩展未连接/);
    assert.match(html, /工具端服务已连接/);
    assert.doesNotMatch(html, /连接成功|已就绪|以后会自动重连/);
  }
  store.nativeExtensionBrowsers = [online];
  assert.match(render(), />已连接<\/span>/);
  assert.match(settings(), /已连接 · 可使用当前页/);
  store.nativeExtensionBrowsers = [];
  assert.match(render(), />尚未配对<\/span>/);
  assert.doesNotMatch(render(), /已配对|连接成功/);
});

test('service failure and unknown snapshots never blame the extension or show stale success', () => {
  const { store, render, settings } = fixture();
  store.nativeExtensionService = { status: 'disconnected', error: '<service unavailable>' };
  assert.match(render(), />工具端未连接<\/span>/);
  assert.match(render(), /尚不能确认扩展是否在线/);
  assert.match(render(), /&lt;service unavailable>/);
  assert.doesNotMatch(settings(), /连接成功|可使用当前页/);
  store.nativeExtensionService = { status: 'connecting' };
  assert.match(render(), />工具端连接中<\/span>/);
  store.nativeExtensionError = 'snapshot failed';
  assert.match(render(), />检测失败<\/span>/);
  assert.doesNotMatch(render(), /连接成功|连接已就绪/);
  store.nativeExtensionError = null;
  store.nativeExtensionLoading = true;
  assert.match(render(), />检测中…<\/span>/);
  assert.doesNotMatch(render(), /连接成功|连接已就绪/);
});

test('an incompatible connected extension stays connected and offers an update path without re-pairing', () => {
  const { store, render, settings } = fixture();
  store.nativeExtensionBrowsers = [{ ...online, taskTabs: false, extensionVersion: '0.1.0' }];
  assert.match(render(), />已连接 · 需更新<\/span>/);
  assert.match(render(), /data-action="open-browser-extension-folder"[^>]*>打开更新目录/);
  assert.doesNotMatch(render(), /data-action="connect-browser-extension"|待连接|连接成功/);
  assert.match(settings(), /已连接 · 请更新或重新加载扩展/);
  for (const partial of [{}, { extensionVersion: '0.2.17' }, { capabilities: [] }]) {
    store.nativeExtensionBrowsers = [{ profileId: profile.id, connected: true, taskTabs: false, ownership: 'user', ...partial }];
    assert.match(render(), />已连接 · 待就绪<\/span>/);
    assert.doesNotMatch(render(), /需更新|打开更新目录|连接成功/);
  }
});

test('ownership and technical interruptions never appear as an offline extension or freely usable target', () => {
  const { store, render } = fixture();
  store.nativeExtensionBrowsers = [{ ...online, pausedByBrowser: true }];
  assert.match(render(), /已连接 · 操作已暂停/);
  assert.doesNotMatch(render(), /可使用当前页|连接已就绪/);
  store.nativeExtensionBrowsers = [{ ...online, ownerSessionId: 'existing-task', ownership: 'agent' }];
  assert.match(render(), /已连接 · 任务使用中/);
  assert.doesNotMatch(render(), /可使用当前页/);
  store.nativeExtensionBrowsers = [{ ...online, controlIssue: { code: 'NATIVE_EXTENSION_FRAME_CONFLICT', message: '<frame conflict>' } }];
  assert.match(render(), /已连接 · 操作中断/);
  assert.match(render(), /&lt;frame conflict>/);
  assert.doesNotMatch(render(), /扩展未连接|连接成功/);
});

test('active installation progress is retained while unrelated Profile success cannot leak into the card', () => {
  const { store, render } = fixture();
  store.nativeExtensionBrowsers = [];
  store.nativeExtensionInstallations = [{ ...receipt, stage: 'confirm-tab', message: '请在目标 Chrome 中授权连接。' }];
  assert.match(render(), /请在目标 Chrome 中授权连接/);
  store.nativeExtensionInstallations = [{ ...receipt, profileId: 'native:Other' }];
  assert.doesNotMatch(render(), /连接成功/);
  store.state.profiles = [];
  assert.match(render(), />未发现 Profile<\/span>/);
  assert.doesNotMatch(render(), /连接成功/);
});
