const assert = require("node:assert/strict");
const test = require("node:test");

const { loadTsModule } = require("./helpers/load-ts-module.js");

function loadModals(profiles) {
  const store = { state: { profiles } };
  const modals = loadTsModule("src/renderer/render/modals.ts", {
    stubs: {
      "../state": { store },
      "src/renderer/state": { store },
      "../busy": { isBusyAction: () => false },
      "src/renderer/busy": { isBusyAction: () => false }
    }
  });
  return modals;
}

function baseProfile(overrides = {}) {
  return {
    id: "p1",
    source: "isolated",
    name: "test-profile",
    running: false,
    fixedCdpPort: 9223,
    bifrostProxy: null,
    upstreamProxy: null,
    ...overrides
  };
}

const SNAPSHOT = {
  installed: true,
  running: true,
  version: "test",
  binaryPath: "/bin/bifrost",
  mainPort: 9900,
  ports: [],
  localRules: ["worktree-a"],
  error: null,
  upstreamHealth: {}
};

test("buildClashMergeTemplate emits listeners + IN-NAME rule for the given port", () => {
  const modals = loadModals([baseProfile()]);
  const yaml = modals.buildClashMergeTemplate(7811);
  assert.match(yaml, /name: pp-7811, type: mixed, port: 7811/);
  assert.match(yaml, /IN-NAME,pp-7811,PROXY-GROUP-NAME/);
});

test("buildClashMergeTemplate falls back to a placeholder port when none is given", () => {
  const modals = loadModals([baseProfile()]);
  assert.match(modals.buildClashMergeTemplate(null), /port: 7811/);
});

test("renderClashTemplateBlock derives the port from an upstream endpoint", () => {
  const modals = loadModals([baseProfile()]);
  const html = modals.renderClashTemplateBlock("upstream", "http://127.0.0.1:7897");
  assert.match(html, /pp-7897/);
  assert.match(html, /data-clash-template-code/);
  assert.match(html, /data-action="copy-clash-template"/);
});

test("proxy modal defaults to bifrost mode and shows the mode switch", () => {
  const modals = loadModals([baseProfile()]);
  const html = modals.renderBifrostProxyModal("p1", SNAPSHOT);
  assert.match(html, /data-proxy-mode="bifrost"/);
  assert.match(html, /data-bifrost-mode/);
  assert.match(html, /data-bifrost-mode-panel="upstream"/);
});

test("proxy modal reflects a saved upstream config in upstream mode", () => {
  const modals = loadModals([
    baseProfile({ upstreamProxy: { server: "http://127.0.0.1:7897", bypassList: "localhost" } })
  ]);
  const html = modals.renderBifrostProxyModal("p1", SNAPSHOT);
  assert.match(html, /data-proxy-mode="upstream"/);
  assert.match(html, /value="http:\/\/127\.0\.0\.1:7897"/);
  assert.match(html, /value="localhost"/);
});

test("proxy modal shows the Clash template only in upstream mode, not bifrost mode", () => {
  const modals = loadModals([
    baseProfile({ bifrostProxy: { listenerPort: 18888, rules: ["worktree-a"], groupRules: [] } })
  ]);
  const html = modals.renderBifrostProxyModal("p1", SNAPSHOT);
  assert.match(html, /data-proxy-mode="bifrost"/);
  // 三选一模型：Bifrost 模式不再有链式上游输入，也不展示 Clash 模板。
  assert.doesNotMatch(html, /data-bifrost-chain-upstream/);
  assert.doesNotMatch(html, /data-clash-template/);
});

test("running Bifrost Profile keeps structural settings locked but allows rule hot updates", () => {
  const modals = loadModals([
    baseProfile({
      running: true,
      bifrostProxy: { listenerPort: 18888, rules: ["worktree-a"], groupRules: [] }
    })
  ]);
  const html = modals.renderBifrostProxyModal("p1", SNAPSHOT);
  assert.match(html, /data-bifrost-hot-edit="true"/);
  assert.match(html, /正在运行，可热更新规则/);
  assert.match(html, /data-bifrost-listener-port readonly/);
  assert.match(html, /data-bifrost-mode checked disabled/);
  assert.doesNotMatch(html, /data-bifrost-config-fields disabled/);
  assert.match(html, /data-bifrost-submit-label >/);
});

test("running Profile without Bifrost remains fully locked", () => {
  const modals = loadModals([baseProfile({ running: true })]);
  const html = modals.renderBifrostProxyModal("p1", SNAPSHOT);
  assert.match(html, /data-bifrost-hot-edit="false"/);
  assert.match(html, /正在运行，配置已锁定/);
  assert.match(html, /data-bifrost-config-fields disabled/);
  assert.match(html, /data-bifrost-submit-label disabled/);
});
