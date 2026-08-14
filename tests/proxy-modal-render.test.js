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

function loadProxyHelpers() {
  return loadTsModule("src/renderer/proxy.ts");
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
    directConnection: false,
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
  upstreamHealth: {},
  systemProxy: {
    mode: "proxy",
    routes: [
      { protocol: "http", kind: "http", endpoint: "127.0.0.1:9900" },
      { protocol: "https", kind: "http", endpoint: "127.0.0.1:9900" }
    ]
  }
};

test("proxy presets use the detected Bifrost main port and the Clash 7897 default", () => {
  const proxy = loadProxyHelpers();
  assert.equal(proxy.bifrostMainProxyServer(SNAPSHOT), "http://127.0.0.1:9900");
  assert.equal(proxy.bifrostMainProxyServer(null), "http://127.0.0.1:9900");
  assert.equal(proxy.DEFAULT_CLASH_PROXY_SERVER, "http://127.0.0.1:7897");
  assert.equal(proxy.proxyServerUsesPort("http://localhost:9900", 9900), true);
  assert.equal(proxy.proxyServerUsesPort("http://127.0.0.1:7897", 9900), false);
});

test("unconfigured proxy modal shows the real system route instead of the proposed Bifrost port", () => {
  const modals = loadModals([baseProfile({ running: true })]);
  const html = modals.renderBifrostProxyModal("p1", SNAPSHOT);
  assert.match(html, /data-proxy-mode="bifrost-main"/);
  assert.match(html, /data-bifrost-mode/);
  assert.match(html, /data-bifrost-mode-panel="custom" hidden/);
  assert.match(html, /name="mode" value="custom"/);
  assert.match(html, /<strong>指定代理<\/strong><small>手动填写 HTTP \/ SOCKS5 地址<\/small>/);
  assert.match(html, /name="mode" value="bifrost-main"[^>]*checked/);
  assert.match(html, /<strong>Bifrost<\/strong><small>主入口 · 127\.0\.0\.1:9900<\/small>/);
  assert.match(html, /name="mode" value="clash"/);
  assert.match(html, /<strong>Clash<\/strong><small>默认 mixed · 127\.0\.0\.1:7897<\/small>/);
  assert.match(html, /name="mode" value="direct"/);
  assert.match(html, /<strong>直接联网<\/strong><small>绕过系统代理，不连接 Bifrost 或 Clash<\/small>/);
  assert.match(html, /data-bifrost-route-context[^>]*>\s*<span data-bifrost-route-badge>当前生效/);
  assert.match(html, /data-bifrost-route-middle-label>System proxy/);
  assert.match(html, /data-bifrost-route-port>127\.0\.0\.1:9900/);
  assert.match(html, /data-bifrost-route-count>Bifrost 主入口 :9900/);
  assert.doesNotMatch(html, /data-bifrost-route-port>127\.0\.0\.1:18888/);
  assert.doesNotMatch(html, /bifrost-mode-option selected/);
  assert.doesNotMatch(html, /Profile 专属入口端口/);
  assert.doesNotMatch(html, /name="listenerPort"/);
  assert.doesNotMatch(html, /data-bifrost-local-rules/);
  assert.doesNotMatch(html, /name="groupRules"/);
  assert.doesNotMatch(html, /data-upstream-proxy-preset/);
  assert.match(html, /data-bifrost-main-server="http:\/\/127\.0\.0\.1:9900"/);
  assert.match(html, /data-clash-server="http:\/\/127\.0\.0\.1:7897"/);
  assert.match(html, /name="upstreamServer"[^>]*value=""/);
  assert.doesNotMatch(html, /data-clash-template/);
});

test("Bifrost and Clash choices stay explicit instead of inheriting an unrelated system proxy", () => {
  const modals = loadModals([baseProfile()]);
  const html = modals.renderBifrostProxyModal("p1", {
    ...SNAPSHOT,
    systemProxy: {
      mode: "proxy",
      routes: [
        { protocol: "http", kind: "http", endpoint: "127.0.0.1:18080" },
        { protocol: "https", kind: "http", endpoint: "127.0.0.1:18080" }
      ]
    }
  });
  assert.match(html, /name="mode" value="bifrost-main"[^>]*checked/);
  assert.match(html, /主入口 · 127\.0\.0\.1:9900/);
  assert.match(html, /默认 mixed · 127\.0\.0\.1:7897/);
  assert.match(html, /name="upstreamServer"[^>]*value=""/);
  assert.doesNotMatch(html, /name="upstreamServer"[^>]*value="http:\/\/127\.0\.0\.1:18080"/);
});

test("blank upstream input resolves to the suggested default while invalid overrides still fail", () => {
  const proxy = loadProxyHelpers();
  assert.equal(
    proxy.resolveUpstreamProxyServerInput("", "http://127.0.0.1:7897"),
    "http://127.0.0.1:7897"
  );
  assert.equal(
    proxy.resolveUpstreamProxyServerInput("  ", "http://127.0.0.1:18080"),
    "http://127.0.0.1:18080"
  );
  assert.equal(proxy.resolveUpstreamProxyServerInput("not a proxy", "http://127.0.0.1:7897"), null);
});

test("unconfigured proxy modal identifies a non-Bifrost system proxy as an external entry", () => {
  const modals = loadModals([baseProfile({ running: true })]);
  const html = modals.renderBifrostProxyModal("p1", {
    ...SNAPSHOT,
    systemProxy: {
      mode: "proxy",
      routes: [
        { protocol: "http", kind: "http", endpoint: "127.0.0.1:7897" },
        { protocol: "https", kind: "http", endpoint: "127.0.0.1:7897" }
      ]
    }
  });
  assert.match(html, /data-bifrost-route-port>127\.0\.0\.1:7897/);
  assert.match(html, /data-bifrost-route-count>外部代理入口/);
  assert.doesNotMatch(html, /data-bifrost-route-count>Bifrost 主入口/);
});

test("proxy modal recognizes a saved Clash entry", () => {
  const modals = loadModals([
    baseProfile({ upstreamProxy: { server: "http://127.0.0.1:7897", bypassList: "localhost" } })
  ]);
  const html = modals.renderBifrostProxyModal("p1", SNAPSHOT);
  assert.match(html, /data-proxy-mode="clash"/);
  assert.match(html, /name="mode" value="clash"[^>]*checked/);
  assert.match(html, /value="localhost"/);
  assert.match(html, /data-bifrost-mode-panel="custom" hidden/);
  assert.doesNotMatch(html, /data-clash-template/);
});

test("proxy modal recognizes a saved Bifrost main entry without creating a dedicated listener", () => {
  const modals = loadModals([
    baseProfile({ upstreamProxy: { server: "http://127.0.0.1:9900", bypassList: null } })
  ]);
  const html = modals.renderBifrostProxyModal("p1", SNAPSHOT);
  assert.match(html, /data-proxy-mode="bifrost-main"/);
  assert.match(html, /name="mode" value="bifrost-main"[^>]*checked/);
  assert.doesNotMatch(html, /name="listenerPort"/);
  assert.match(html, /data-bifrost-route-count>Bifrost 主入口<\/strong>/);
  assert.match(html, /data-bifrost-route-target-note>使用主入口当前启用规则<\/small>/);
  assert.doesNotMatch(html, /data-clash-template/);
});

test("proxy modal keeps a saved custom proxy editable", () => {
  const modals = loadModals([
    baseProfile({ upstreamProxy: { server: "socks5://127.0.0.1:18080", bypassList: "localhost" } })
  ]);
  const html = modals.renderBifrostProxyModal("p1", SNAPSHOT);
  assert.match(html, /data-proxy-mode="custom"/);
  assert.match(html, /name="mode" value="custom"[^>]*checked/);
  assert.match(html, /data-bifrost-mode-panel="custom" >/);
  assert.match(html, /name="upstreamServer"[^>]*value="socks5:\/\/127\.0\.0\.1:18080"/);
  assert.match(html, /value="localhost"/);
  assert.doesNotMatch(html, /data-clash-template/);
});

test("proxy modal reflects a saved direct connection without a Bifrost or Clash route", () => {
  const modals = loadModals([baseProfile({ directConnection: true })]);
  const html = modals.renderBifrostProxyModal("p1", SNAPSHOT);
  assert.match(html, /data-proxy-mode="direct"/);
  assert.match(html, /name="mode" value="direct"[^>]*checked/);
  assert.match(html, /data-bifrost-route-port>DIRECT/);
  assert.match(html, /data-bifrost-route-middle-note>--no-proxy-server/);
  assert.match(html, /data-bifrost-route-count>直接访问目标/);
  assert.match(html, /不连接 Bifrost 或 Clash/);
  assert.doesNotMatch(html, /data-clash-template/);
});

test("legacy dedicated Bifrost config stays readable but its old controls are hidden", () => {
  const modals = loadModals([
    baseProfile({ bifrostProxy: { listenerPort: 18888, rules: ["worktree-a"], groupRules: [] } })
  ]);
  const html = modals.renderBifrostProxyModal("p1", SNAPSHOT);
  assert.match(html, /data-proxy-mode="bifrost-main"/);
  assert.match(html, /name="mode" value="bifrost-main"[^>]*checked/);
  assert.match(html, /data-bifrost-route-port>127\.0\.0\.1:18888/);
  assert.doesNotMatch(html, /name="listenerPort"/);
  assert.doesNotMatch(html, /data-bifrost-local-rules/);
  assert.doesNotMatch(html, /name="groupRules"/);
  assert.doesNotMatch(html, /data-clash-template/);
});

test("running legacy Bifrost Profile keeps all settings locked", () => {
  const modals = loadModals([
    baseProfile({
      running: true,
      bifrostProxy: { listenerPort: 18888, rules: ["worktree-a"], groupRules: [] }
    })
  ]);
  const html = modals.renderBifrostProxyModal("p1", SNAPSHOT);
  assert.match(html, /data-bifrost-hot-edit="false"/);
  assert.match(html, /正在运行，配置已锁定/);
  assert.match(html, /data-bifrost-route-badge>入口未监听/);
  assert.match(html, /data-bifrost-route-middle-label>Saved listener/);
  assert.match(html, /data-bifrost-route-target-label>Saved rules/);
  assert.doesNotMatch(html, /data-bifrost-route-target-label>Rule view/);
  assert.doesNotMatch(html, /data-bifrost-listener-port/);
  assert.match(html, /data-bifrost-mode checked disabled/);
  assert.match(html, /data-bifrost-config-fields disabled/);
  assert.match(html, /data-bifrost-submit-label disabled/);
});

test("running Bifrost Profile shows Rule view only when its listener is really bound", () => {
  const modals = loadModals([
    baseProfile({
      running: true,
      bifrostProxy: { listenerPort: 18888, rules: ["worktree-a"], groupRules: [] }
    })
  ]);
  const html = modals.renderBifrostProxyModal("p1", {
    ...SNAPSHOT,
    ports: [{ port: 18888, host: "127.0.0.1", name: "profilepilot:p1", status: "running" }]
  });
  assert.match(html, /data-bifrost-route-badge>当前生效/);
  assert.match(html, /data-bifrost-route-middle-label>Local listener/);
  assert.match(html, /data-bifrost-route-port>127\.0\.0\.1:18888/);
  assert.match(html, /data-bifrost-route-target-label>Rule view/);
  assert.match(html, /data-bifrost-route-target-note>自动包含 Default/);
});

test("running Profile without Bifrost remains fully locked", () => {
  const modals = loadModals([baseProfile({ running: true })]);
  const html = modals.renderBifrostProxyModal("p1", SNAPSHOT);
  assert.match(html, /data-bifrost-hot-edit="false"/);
  assert.match(html, /正在运行，配置已锁定/);
  assert.match(html, /data-action="prepare-bifrost-proxy"/);
  assert.match(html, /关闭后配置/);
  assert.match(html, /刷新网页不会改变启动参数/);
  assert.doesNotMatch(html, /data-bifrost-proxy-enabled[^>]*disabled/);
  assert.match(html, /data-bifrost-config-fields disabled/);
  assert.match(html, /data-bifrost-submit-label disabled/);
});

test("stopped Profile renders an editable native proxy toggle", () => {
  const modals = loadModals([baseProfile()]);
  const html = modals.renderBifrostProxyModal("p1", SNAPSHOT);
  assert.match(html, /data-bifrost-proxy-enabled/);
  assert.doesNotMatch(html, /data-action="prepare-bifrost-proxy"/);
});
