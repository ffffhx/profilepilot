const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { loadTsModule } = require("./helpers/load-ts-module.js");

function loadProfilesRenderer(overrides = {}) {
  const store = {
    selectedId: null,
    busy: false,
    busyState: null,
    openProfileMenuId: null,
    liveView: {},
    liveActiveTab: {},
    ...overrides
  };
  const renderer = loadTsModule("src/renderer/render/profiles.ts", {
    stubs: {
      "../state": { store },
      "src/renderer/state": { store }
    }
  });
  return { renderer, store };
}

function profile(overrides = {}) {
  return {
    id: "p1",
    source: "isolated",
    name: "9223端口profile",
    dirName: "p1",
    path: "/tmp/p1",
    userDataDir: "/tmp/p1",
    profileDataPath: "/tmp/p1/Default",
    createdAt: "2026-07-15T00:00:00.000Z",
    lastLaunchedAt: "2026-07-15T00:00:00.000Z",
    userName: "user@example.com",
    isDefault: false,
    deletable: true,
    running: true,
    pids: [101],
    cdpPort: 9223,
    cdpUrl: "http://127.0.0.1:9223",
    fixedCdpPort: 9223,
    listeningPorts: [9223],
    pinnedToMini: false,
    quickLaunchSlot: null,
    clonedFromProfileId: null,
    clonedFromName: null,
    cloneCount: 0,
    projectTag: null,
    cdpClients: [],
    gatewayControl: null,
    agentBrowserOccupancy: null,
    livePrimaryUrl: null,
    liveTabCount: null,
    cdpContention: null,
    agentActivity: null,
    ...overrides
  };
}

test("Profile Registry renders one shared five-column track", () => {
  const { renderer } = loadProfilesRenderer();
  const html = renderer.renderProfilesPanel([
    profile({
      gatewayControl: {
        publicPort: 9223,
        ownership: "agent",
        sessionStatus: "active",
        agentHealth: "online",
        connectionActive: true,
        ownerSessionId: "cx-019f",
        daemonInstanceId: "daemon-1",
        daemonPid: 201,
        agent: "Codex",
        project: "coze-test-account-cli",
        agentTarget: null,
        pendingUserAction: null,
        updatedAt: "2026-07-15T00:00:00.000Z"
      },
      cdpClients: [{
        pid: 202,
        label: "agent-browser",
        agent: "Codex",
        project: "coze-test-account-cli",
        session: "cx-019f",
        lastActive: "2026-07-15T00:00:00.000Z"
      }]
    })
  ], []);

  assert.match(html, /<col class="profile-col-name" \/>[\s\S]*profile-col-status[\s\S]*profile-col-connection[\s\S]*profile-col-activity[\s\S]*profile-col-actions/);
  assert.match(html, /<th>Profile<\/th>[\s\S]*<th>Status<\/th>[\s\S]*<th>Connection<\/th>[\s\S]*<th>Agent Activity<\/th>[\s\S]*<th>Actions<\/th>/);
  assert.match(html, /:9223[\s\S]*Gateway[\s\S]*Codex 正在驱动[\s\S]*coze-test-account-cli/);
  assert.match(html, /profile-activity-track driving">\s*<span class="profile-activity-signal" aria-hidden="true"><\/span>\s*<span class="profile-activity-main action-tooltip"/);
  assert.match(html, /profile-primary-action[\s\S]*>\s*接管\s*<\/button>[\s\S]*profile-details-action[\s\S]*data-action="open-profile-details"[\s\S]*>详情<\/button>[\s\S]*profile-window-action[\s\S]*aria-label="显示"[\s\S]*>\s*↗\s*<\/button>[\s\S]*profile-menu-action/);
});

test("Profile Registry preserves empty activity and fixed action slots", () => {
  const { renderer } = loadProfilesRenderer();
  const html = renderer.renderProfileRow(profile({
    running: false,
    pids: [],
    cdpPort: null,
    cdpUrl: null,
    cdpClients: [],
    fixedCdpPort: 9226
  }));

  assert.match(html, /:9226[\s\S]*待启动/);
  assert.match(html, /profile-activity-empty">—<\/span>/);
  assert.match(html, /profile-primary-action[\s\S]*aria-label="启动"[\s\S]*>\s*启动\s*<\/button>/);
  assert.match(html, /aria-label="更多"[\s\S]*>⋮<\/button>/);
});

test("external instance group spans all Profile Registry columns", () => {
  const { renderer } = loadProfilesRenderer();
  const html = renderer.renderExternalRows([{
    userDataDir: "/tmp/external",
    label: "External Chrome",
    browser: "Google Chrome",
    pid: 303,
    startedAt: null,
    cdpPort: null,
    cdpUrl: null,
    cdpClients: [],
    agentActivity: null,
    headless: false
  }]);

  assert.match(html, /colspan="5"/);
  assert.match(html, /data-action="open-external-details"/);
});

test("Profile details stay in an explicit modal with the live cockpit", () => {
  const { renderer } = loadProfilesRenderer();
  const html = renderer.renderProfileDetailsModal(profile({
    running: true,
    cdpPort: 9223,
    cdpUrl: "http://127.0.0.1:9223"
  }));

  assert.match(html, /class="modal-backdrop profile-details-backdrop"/);
  assert.match(html, /class="profile-details-modal"/);
  assert.match(html, /data-profile-details-close/);
  assert.match(html, /class="profile-details-modal-body"/);
  assert.match(html, /data-live-view="p1"/);
});

test("main renderer omits the recent takeover panel and history modal", () => {
  const rendererRoot = readFileSync(path.join(__dirname, "..", "src", "renderer", "render", "render-root.ts"), "utf8");
  const modals = readFileSync(path.join(__dirname, "..", "src", "renderer", "render", "modals.ts"), "utf8");
  const rendererMain = readFileSync(path.join(__dirname, "..", "src", "renderer", "main.ts"), "utf8");
  const css = readFileSync(path.join(__dirname, "..", "public", "styles.src.css"), "utf8");
  const removedUi = [rendererRoot, modals, rendererMain, css].join("\n");

  assert.doesNotMatch(removedUi, /agent-takeover-notice|takeover-history|最近接管|接管历史/);
  assert.doesNotMatch(rendererMain, /loadTakeoverHistory|mergeAgentTakeoverHistory/);
});

test("Profile Registry CSS locks column and action alignment", () => {
  const css = readFileSync(path.join(__dirname, "..", "public", "styles.src.css"), "utf8");

  assert.match(css, /\.profiles-table\s*\{[\s\S]*?table-layout:\s*fixed;/);
  assert.match(css, /grid-template-columns:\s*66px 52px 34px 28px;/);
  assert.match(css, /\.profile-primary-action\s*\{\s*grid-column:\s*1;\s*grid-row:\s*1;/);
  assert.match(css, /\.profile-details-action\s*\{\s*grid-column:\s*2;\s*grid-row:\s*1;/);
  assert.match(css, /\.profile-window-action\s*\{\s*grid-column:\s*3;\s*grid-row:\s*1;/);
  assert.match(css, /\.profile-menu-action\s*\{\s*grid-column:\s*4;\s*grid-row:\s*1;/);
  assert.match(css, /\.profile-activity-meta\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto;/);
  assert.doesNotMatch(css, /\.profile-activity-signal\s*\{[^}]*border-left:/);
  assert.doesNotMatch(css, /\.profiles-table \.cdp-cell\.off\s*\{[^}]*padding-left:\s*0;/);
  assert.match(css, /\.profile-details-modal-body\s*\{[\s\S]*?grid-template-columns:\s*minmax\(270px, 0\.7fr\) minmax\(460px, 1\.65fr\);/);
});

test("live observation starts from the details modal, not row selection", () => {
  const main = readFileSync(path.join(__dirname, "..", "src", "renderer", "main.ts"), "utf8");
  const liveView = readFileSync(path.join(__dirname, "..", "src", "renderer", "render", "live-view.ts"), "utf8");
  const selectBlock = main.slice(main.indexOf('if (action === "select"'), main.indexOf('if (action === "select-external"'));

  assert.match(main, /action === "open-profile-details"[\s\S]*store\.modal = \{ kind: "profile-details", profileId: id \}[\s\S]*requestLiveViewNow\(id\)/);
  assert.doesNotMatch(selectBlock, /requestLiveViewNow/);
  assert.match(liveView, /store\.modal\?\.kind !== "profile-details" && store\.modal\?\.kind !== "live-zoom"/);
  assert.match(liveView, /function activeLiveProfileId\(\)[\s\S]*store\.modal\?\.kind === "profile-details"/);
  assert.match(liveView, /store\.liveActiveTab\[profile\.id\] \|\| profile\.gatewayControl\?\.agentTarget\?\.targetId/);
});
