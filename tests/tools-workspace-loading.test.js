const assert = require("node:assert/strict");
const test = require("node:test");
const { loadTsModule } = require("./helpers/load-ts-module.js");

function fixture(t) {
  const originalDocument = global.document;
  global.document = { getElementById: () => null, addEventListener() {}, body: { classList: { remove() {} } } };
  t.after(() => { global.document = originalDocument; });
  const appRoot = { innerHTML: "", className: "", querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  const store = {
    viewMode: "main", workspace: "tools", state: null, modal: null,
    agentIntegrationDiagnostic: null, agentIntegrationLoading: true,
    nativeExtensionBrowsers: [], nativeExtensionInstallations: []
  };
  const emptyRenderers = new Proxy({}, { get: () => () => "" });
  const renderer = loadTsModule("src/renderer/render/render-root.ts", { stubs: {
    "../state": { store, appRoot },
    "../workspace-switcher": { workspaceSwitcher: () => '<button data-workspace-trigger>配套工具</button>', workspaceIdentityBar: () => '<div class="workspace-identity"></div>', refreshWorkspaceSwitcher() {} },
    "../busy": { isBusyAction: () => false, renderToastBody: value => value },
    "../confirm": emptyRenderers,
    "../control-preferences": emptyRenderers,
    "../util": { escapeHtml: value => String(value), renderBusyBanner: () => "", renderButtonLabel: (loading, idle, busy) => loading ? busy : idle },
    "./account-sync": emptyRenderers, "./clone-pool": emptyRenderers,
    "./live-view": emptyRenderers, "./mini": emptyRenderers,
    "./modals": emptyRenderers, "./profiles": emptyRenderers
  } });
  return { renderer, store, appRoot };
}

test("tools workspace and navigation render before the full Profile scan returns", t => {
  const { renderer, appRoot } = fixture(t);
  renderer.render();
  assert.match(appRoot.innerHTML, /data-workspace-trigger/);
  assert.match(appRoot.innerHTML, /id="browser-extension-title"/);
  assert.match(appRoot.innerHTML, /id="management-cli-title"/);
  assert.match(appRoot.innerHTML, /正在读取系统 Chrome Profile/);
  assert.doesNotMatch(appRoot.innerHTML, /app-loading|尚未发现系统 Chrome Profile/);
});

test("a failed Profile scan keeps tools visible with an explicit retry", t => {
  const { renderer, store, appRoot } = fixture(t);
  store.profileLoadError = "Profile scan unavailable";
  renderer.render();
  assert.match(appRoot.innerHTML, /Profile scan unavailable/);
  assert.match(appRoot.innerHTML, /data-action="refresh-browser-extension"/);
  assert.match(appRoot.innerHTML, /id="management-cli-title"/);
  assert.doesNotMatch(appRoot.innerHTML, /app-loading|正在读取系统 Chrome Profile/);
});
