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
    profileReadiness: {},
    profileReadinessLoading: {},
    ...overrides
  };
  const renderer = loadTsModule("src/renderer/render/profiles.ts", {
    stubs: {
      "../state": { store, dateFormatter: { format: (value) => value.toISOString() } },
      "src/renderer/state": { store, dateFormatter: { format: (value) => value.toISOString() } }
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
    bifrostProxy: null,
    upstreamProxy: null,
    directConnection: false,
    listeningPorts: [9223],
    pinnedToMini: false,
    quickLaunchSlot: null,
    clonedFromProfileId: null,
    clonedFromName: null,
    cloneCount: 0,
    projectTag: null,
    agentAccessDisabled: false,
    cdpClients: [],
    gatewayControl: null,
    agentBrowserOccupancy: null,
    livePrimaryUrl: null,
    liveTabCount: null,
    cdpContention: null,
    agentActivity: null,
    windowActivation: "background",
    ...overrides
  };
}

test("Profile Inspector separates logical ownership from frontmost window state", () => {
  const readiness = {
    version: 1,
    receiptId: "p1:now",
    generatedAt: "2026-08-01T00:00:00.000Z",
    overall: "blocked",
    target: {
      profileId: "p1",
      profileName: "9223端口profile",
      expectedLogicalPort: 9223,
      expectedProxyKind: null,
      expectedTargetUrl: null,
      expectedLogin: null
    },
    checks: [
      {
        id: "ownership",
        code: "USER_OWNS_PROFILE",
        label: "逻辑控制权",
        status: "fail",
        required: true,
        expected: "Agent",
        actual: "用户 · 等待完成：登录 PPE",
        evidence: "Session cx-one",
        action: "完成后显式交还 Agent"
      },
      {
        id: "foreground",
        code: "PROFILE_BACKGROUND",
        label: "窗口前台",
        status: "pass",
        required: false,
        expected: "允许后台运行",
        actual: "后台",
        evidence: null,
        action: null
      }
    ],
    blockerCodes: ["USER_OWNS_PROFILE"],
    unknownCodes: [],
    sessionIdentity: null
  };
  const { renderer } = loadProfilesRenderer({
    profileReadiness: { p1: readiness },
    profileReadinessLoading: { p1: false }
  });
  const html = renderer.renderProfileDetailsModal(profile({
    gatewayControl: {
      publicPort: 9223,
      ownership: "user",
      sessionStatus: "active",
      driverState: "quiesced",
      ownerSessionId: "cx-one",
      pendingUserAction: "登录 PPE",
      agentTarget: null
    },
    windowActivation: "background"
  }));

  assert.match(html, /逻辑控制权[\s\S]*用户 · 等待完成：登录 PPE/);
  assert.match(html, /窗口前台[\s\S]*后台/);
  assert.match(html, /data-action="return-agent-control"[\s\S]*>交还 Agent<\/button>/);
});

test("Profile Registry renders one shared six-column track", () => {
  const { renderer } = loadProfilesRenderer({ openProfileMenuId: "p1" });
  const html = renderer.renderProfilesPanel([
    profile({
      gatewayControl: {
        publicPort: 9223,
        ownership: "agent",
        sessionStatus: "active",
        agentHealth: "online",
        driverState: "connected",
        reconnectAttempt: null,
        reconnectDeadlineAt: null,
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

  assert.match(html, /<col class="profile-col-name" \/>[\s\S]*profile-col-status[\s\S]*profile-col-route[\s\S]*profile-col-connection[\s\S]*profile-col-activity[\s\S]*profile-col-actions/);
  assert.match(html, /<th>Profile<\/th>[\s\S]*<th>Status<\/th>[\s\S]*<th>Proxy Route<\/th>[\s\S]*<th>Connection<\/th>[\s\S]*<th>Agent Activity<\/th>[\s\S]*<th>Actions<\/th>/);
  assert.match(html, /系统代理[\s\S]*正在读取系统代理[\s\S]*:9223[\s\S]*Gateway[\s\S]*Codex 正在驱动[\s\S]*coze-test-account-cli/);
  assert.match(html, /profile-activity-track driving">\s*<span class="profile-activity-signal" aria-hidden="true"><\/span>\s*<span class="profile-activity-main action-tooltip"/);
  assert.match(html, /profile-primary-action[\s\S]*>\s*接管\s*<\/button>[\s\S]*profile-window-action[\s\S]*aria-label="显示"[\s\S]*>\s*↗\s*<\/button>[\s\S]*profile-menu-action[\s\S]*data-action="open-profile-details"[\s\S]*>查看详情<\/button>/);
  assert.doesNotMatch(html, /profile-details-action/);
});

test("Profile Registry distinguishes a reconnecting driver from an Agent ownership lock", () => {
  const { renderer } = loadProfilesRenderer();
  const html = renderer.renderProfileRow(profile({
    gatewayControl: {
      publicPort: 9223,
      ownership: "agent",
      sessionStatus: "active",
      agentHealth: "offline",
      driverState: "reconnecting",
      reconnectAttempt: 2,
      reconnectDeadlineAt: "2026-07-15T00:00:10.000Z",
      connectionActive: false,
      ownerSessionId: "cx-reconnecting",
      daemonInstanceId: "daemon-reconnecting",
      daemonPid: 201,
      driverKind: "agent-browser",
      driverLabel: "agent-browser",
      agent: "Codex",
      project: "profilepilot",
      agentTarget: null,
      pendingUserAction: null,
      updatedAt: "2026-07-15T00:00:00.000Z"
    }
  }));

  assert.match(html, /浏览器驱动重连中/);
  assert.match(html, /正在等待驱动重连（2\/3）/);
  assert.doesNotMatch(html, /conn-idle">空闲/);
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
  assert.doesNotMatch(html, /data-action="open-profile-details"/);
});

test("Profile Registry exposes the Agent access switch inline and uses the name as AI selection hint", () => {
  const { renderer } = loadProfilesRenderer({ openProfileMenuId: "p1" });
  const configured = profile({
    running: false,
    pids: [],
    cdpPort: null,
    cdpUrl: null,
    agentAccessDisabled: true
  });
  const row = renderer.renderProfileRow(configured);
  const details = renderer.renderDetails(configured, false);

  assert.match(row, /data-action="toggle-agent-access"[^>]*aria-pressed="true"[^>]*>[\s\S]*NO AGENT[\s\S]*<\/button>/);
  assert.match(row, /profile-activity-empty agent-disabled">Agent 已禁用<\/span>/);
  assert.doesNotMatch(row, /configure-agent-settings|Agent 使用设置|>TIP</);
  assert.match(details, /Agent 访问[\s\S]*禁止连接[\s\S]*AI 选择提示[\s\S]*9223端口profile/);
});

test("Profile Registry never describes a stopped Profile as user-controlled", () => {
  const { renderer } = loadProfilesRenderer();
  const html = renderer.renderProfileRow(profile({
    running: false,
    pids: [],
    cdpPort: null,
    cdpUrl: null,
    fixedCdpPort: 9223,
    agentBrowserOccupancy: {
      cdpPort: 9223,
      profileId: "p1",
      profileName: "9223端口profile",
      session: "cx-stale",
      ownership: "user",
      agent: "Codex",
      project: "coze-test-account-cli",
      command: "snapshot",
      holderPid: 101,
      daemonPid: 201,
      updatedAt: "2026-07-15T00:00:00.000Z"
    }
  }));

  assert.match(html, /:9223[\s\S]*待启动[\s\S]*Session 残留/);
  assert.doesNotMatch(html, /用户已接管/);
});

test("configured Profile exposes its Bifrost rules and listener in the row, menu and details", () => {
  const { renderer } = loadProfilesRenderer({ openProfileMenuId: "p1" });
  const configured = profile({
    running: false,
    pids: [],
    cdpPort: null,
    cdpUrl: null,
    bifrostProxy: {
      listenerPort: 18888,
      rules: ["worktree-a"],
      groupRules: ["7152084678483132446/shared-auth"]
    }
  });
  const row = renderer.renderProfileRow(configured);
  const details = renderer.renderDetails(configured, false);

  assert.match(row, /profile-route-track bifrost unknown action-tooltip structured-tooltip[^>]*aria-label="[^"]*启用规则：worktree-a · 7152084678483132446\/shared-auth"/);
  assert.match(row, /route-tip-scroll" role="region" aria-label="Bifrost 路由详情"/);
  assert.match(row, /route-tip-horizontal-scroll" tabindex="0" aria-label="Bifrost 规则，可左右滚动查看完整内容"[\s\S]*route-tip-horizontal-scroll-content/);
  assert.match(row, /profile-bifrost-rule-name">worktree-a<\/span>[\s\S]*data-action="remove-profile-bifrost-rule"[\s\S]*data-rule-kind="local"[\s\S]*data-rule-ref="worktree-a"/);
  assert.match(row, /profile-bifrost-rule-name">7152084678483132446\/shared-auth<\/span>[\s\S]*data-action="remove-profile-bifrost-rule"[\s\S]*data-rule-kind="group"[\s\S]*data-rule-ref="7152084678483132446\/shared-auth"/);
  assert.equal((row.match(/data-action="remove-profile-bifrost-rule"/g) || []).length, 2);
  assert.match(row, /<strong>Bifrost <em>:18888<\/em><\/strong>[\s\S]*<small>worktree-a · shared-auth<\/small>/);
  assert.match(row, /data-action="configure-bifrost-proxy"[^>]*>[\s\S]*代理分流 · Bifrost :18888/);
  assert.match(details, /Bifrost 分流[\s\S]*127\.0\.0\.1:18888[\s\S]*worktree-a[\s\S]*7152084678483132446\/shared-auth/);
});

test("a Profile with only one dedicated Bifrost rule keeps its stop action disabled", () => {
  const { renderer } = loadProfilesRenderer();
  const row = renderer.renderProfileRow(profile({
    bifrostProxy: {
      listenerPort: 18888,
      rules: ["worktree-a"],
      groupRules: []
    }
  }));

  assert.match(row, /data-action="remove-profile-bifrost-rule"[\s\S]*data-rule-ref="worktree-a"[\s\S]*title="专属分流至少需要保留一条启用规则"[\s\S]*disabled[\s\S]*>\s*停用<\/button>/);
});

test("a paused dedicated Bifrost rule stays visible and can be enabled again", () => {
  const { renderer } = loadProfilesRenderer();
  const row = renderer.renderProfileRow(profile({
    bifrostProxy: {
      listenerPort: 18888,
      rules: ["worktree-a", "worktree-b"],
      groupRules: [],
      disabledRules: ["worktree-a"]
    }
  }));

  assert.match(row, /aria-label="[^"]*启用规则：worktree-b[^"]*已停用：worktree-a"/);
  assert.match(row, /profile-bifrost-rule-item disabled[\s\S]*profile-bifrost-rule-name">worktree-a<\/span>[\s\S]*data-action="enable-profile-bifrost-rule"[\s\S]*data-rule-ref="worktree-a"[\s\S]*>\s*启用<\/button>/);
  assert.match(row, /profile-bifrost-rule-item enabled[\s\S]*profile-bifrost-rule-name">worktree-b<\/span>[\s\S]*data-action="remove-profile-bifrost-rule"[\s\S]*disabled[\s\S]*>\s*停用<\/button>/);
});

test("configured upstream Profile names Clash Verge and explains where its rules live", () => {
  const { renderer } = loadProfilesRenderer({ openProfileMenuId: "p1" });
  const configured = profile({
    running: false,
    pids: [],
    cdpPort: null,
    cdpUrl: null,
    bifrostProxy: null,
    upstreamProxy: { server: "http://127.0.0.1:7897", bypassList: null }
  });
  const row = renderer.renderProfileRow(configured);
  const details = renderer.renderDetails(configured, false);

  assert.match(row, /profile-route-track upstream provider-clash action-tooltip[^>]*data-tooltip="[^"]*具体规则由 Clash Verge 决定"/);
  assert.match(row, /<strong>Clash Verge <em>:7897<\/em><\/strong>[\s\S]*<small>规则由 Clash 决定<\/small>/);
  assert.match(row, /data-action="configure-bifrost-proxy"[^>]*>[\s\S]*代理分流 · Clash Verge :7897/);
  assert.match(details, /Clash Verge[\s\S]*127\.0\.0\.1:7897/);
});

test("configured Bifrost main entry is not mislabeled as Clash", () => {
  const server = "http://127.0.0.1:9900";
  const { renderer } = loadProfilesRenderer({
    openProfileMenuId: "p1",
    bifrostSnapshot: bifrostSnapshot({
      upstreamHealth: { [server]: true },
      mainRules: [
        { name: "FlowPD-FE-BotStudio", ruleCount: 24 },
        { name: "FlowPD-FE-BotStudio-BOE", ruleCount: 27 }
      ],
      mainRuleDestination: {
        kind: "mixed",
        label: "本地 · :3000 / :8080 + PPE + BOE",
        details: [
          "bots-boe.bytedance.net → localhost:3000",
          "code.coze.cn → x-tt-env-fe · PPE ppe_optimize_subs"
        ]
      }
    })
  });
  const configured = profile({
    running: false,
    pids: [],
    cdpPort: null,
    cdpUrl: null,
    upstreamProxy: { server, bypassList: null }
  });
  const row = renderer.renderProfileRow(configured);
  const details = renderer.renderDetails(configured, false);

  assert.match(row, /profile-route-track upstream provider-bifrost ok action-tooltip structured-tooltip/);
  assert.match(row, /aria-label="Bifrost 主入口可达 · http:\/\/127\.0\.0\.1:9900[\s\S]*启用规则去向：本地 · :3000 \/ :8080 \+ PPE \+ BOE[\s\S]*启用规则：FlowPD-FE-BotStudio · FlowPD-FE-BotStudio-BOE[\s\S]*所有使用 :9900 的 Profile 共享这些规则"/);
  assert.match(row, /<strong>Bifrost <em>:9900<\/em><\/strong>[\s\S]*system-rule-summary">启用规则 · [\s\S]*本地 · :3000 \/ :8080[\s\S]*PPE[\s\S]*BOE/);
  assert.match(row, /route-tip-status system[\s\S]*Bifrost :9900/);
  assert.match(row, /route-tip-tag">映射<\/span>[\s\S]*bots-boe.bytedance.net[\s\S]*localhost:3000/);
  assert.match(row, /route-tip-tag">规则<\/span>[\s\S]*system-proxy-rule-count">2 份启用/);
  assert.match(row, /system-proxy-rule-name">FlowPD-FE-BotStudio<\/span>[\s\S]*system-proxy-rule-name">FlowPD-FE-BotStudio-BOE<\/span>/);
  assert.match(row, /route-tip-tag">兜底<\/span>[\s\S]*未命中规则 → 直连原目标/);
  assert.match(row, /此 Profile 显式连接主入口；所有使用 :9900 的 Profile 共享这些规则/);
  assert.doesNotMatch(row, /使用主入口规则/);
  assert.match(row, /data-action="configure-bifrost-proxy"[^>]*>[\s\S]*代理分流 · Bifrost :9900/);
  assert.doesNotMatch(row, /Clash Verge|规则由 Clash 决定/);
  assert.match(details, /Bifrost 主入口[\s\S]*Bifrost 可达[\s\S]*127\.0\.0\.1:9900[\s\S]*启用规则 · 本地 · :3000 \/ :8080 \+ PPE \+ BOE[\s\S]*规则：FlowPD-FE-BotStudio · FlowPD-FE-BotStudio-BOE[\s\S]*共享这些规则/);
  assert.doesNotMatch(details, /直连 Clash|Clash 可达/);
});

test("configured custom upstream stays labeled as a custom proxy", () => {
  const server = "socks5://127.0.0.1:18080";
  const { renderer } = loadProfilesRenderer({
    openProfileMenuId: "p1",
    bifrostSnapshot: bifrostSnapshot({ upstreamHealth: { [server]: true } })
  });
  const configured = profile({
    running: false,
    pids: [],
    cdpPort: null,
    cdpUrl: null,
    upstreamProxy: { server, bypassList: null }
  });
  const row = renderer.renderProfileRow(configured);
  const details = renderer.renderDetails(configured, false);

  assert.match(row, /<strong>指定代理 <em>:18080<\/em><\/strong>[\s\S]*<small>规则由目标代理决定<\/small>/);
  assert.match(row, /代理分流 · 指定代理 :18080/);
  assert.doesNotMatch(row, /Clash Verge|Bifrost <em>/);
  assert.match(details, /指定代理[\s\S]*代理可达[\s\S]*127\.0\.0\.1:18080/);
});

test("configured direct Profile clearly shows that every proxy is bypassed", () => {
  const { renderer } = loadProfilesRenderer({ openProfileMenuId: "p1" });
  const configured = profile({
    running: false,
    pids: [],
    cdpPort: null,
    cdpUrl: null,
    directConnection: true
  });
  const row = renderer.renderProfileRow(configured);
  const details = renderer.renderDetails(configured, false);

  assert.match(row, /profile-route-track direct action-tooltip/);
  assert.match(row, /<strong>直接联网<\/strong>[\s\S]*<small>已绕过所有代理<\/small>/);
  assert.match(row, /代理分流 · 直接联网/);
  assert.match(details, /直接联网[\s\S]*--no-proxy-server[\s\S]*不连接 Bifrost 或 Clash/);
});

function bifrostSnapshot(overrides = {}) {
  return {
    installed: true,
    running: true,
    version: "0.0.165",
    binaryPath: "/usr/local/bin/bifrost",
    mainPort: 9900,
    ports: [],
    localRules: ["worktree-a"],
    error: null,
    ...overrides
  };
}

test("unconfigured isolated Profile shows the actual system proxy route", () => {
  const { renderer, store } = loadProfilesRenderer();
  store.bifrostSnapshot = bifrostSnapshot({
    mainPort: 9900,
    systemProxy: {
      mode: "proxy",
      routes: [
        { protocol: "http", kind: "http", endpoint: "127.0.0.1:9900" },
        { protocol: "https", kind: "http", endpoint: "127.0.0.1:9900" }
      ]
    },
    mainRules: [
      { name: "FlowPD-FE-BotStudio", ruleCount: 24 },
      { name: "FlowPD-FE-BotStudio-BOE", ruleCount: 27 }
    ],
    mainRuleDestination: {
      kind: "mixed",
      label: "本地 · :3000 / :8080 + PPE + BOE",
      details: [
        "bots-boe.bytedance.net → localhost:3000",
        "前端（GET · 排除 API 等） · code.bots-boe.bytedance.net → localhost:8080",
        "code.coze.cn → x-tt-env-fe · PPE ppe_optimize_subs",
        "后端（/api/marketplace/trade/） · code.bots-boe.bytedance.net → x-tt-env · BOE boe_optimize_subs"
      ]
    }
  });

  const configured = profile({ bifrostProxy: null, upstreamProxy: null });
  const row = renderer.renderProfileRow(configured);
  const details = renderer.renderDetails(configured, false);

  assert.match(row, /profile-route-track system system-proxy-active provider-bifrost action-tooltip structured-tooltip/);
  assert.match(row, /<strong>Bifrost :9900<\/strong>/);
  assert.match(row, /system-rule-summary">启用规则 · [\s\S]*本地 · :3000 \/ :8080[\s\S]*PPE[\s\S]*BOE/);
  assert.match(row, /route-tip-status system[\s\S]*Bifrost :9900/);
  assert.match(row, /route-tip-scroll" role="region" aria-label="代理路由详情"/);
  assert.match(row, /route-tip-horizontal-scroll" tabindex="0" aria-label="已启用规则，可左右滚动查看完整内容"[\s\S]*route-tip-horizontal-scroll-content/);
  assert.match(row, /route-tip-tag">HTTPS<\/span>[\s\S]*system-proxy-tip-kind">HTTP<\/span>[\s\S]*127\.0\.0\.1:9900/);
  assert.match(row, /route-tip-tag">HTTP<\/span>[\s\S]*system-proxy-tip-kind">HTTP<\/span>[\s\S]*127\.0\.0\.1:9900/);
  assert.match(row, /route-tip-tag">生效<\/span>[\s\S]*本地 · :3000 \/ :8080[\s\S]*PPE[\s\S]*BOE/);
  assert.match(row, /route-tip-tag">映射<\/span>[\s\S]*bots-boe.bytedance.net[\s\S]*localhost:3000/);
  assert.match(row, /route-tip-role frontend">前端<\/span>[\s\S]*route-tip-scope">GET · 排除 API 等<\/span>[\s\S]*code.bots-boe.bytedance.net[\s\S]*target-local">localhost:8080/);
  assert.match(row, /route-tip-role frontend">前端<\/span>[\s\S]*code.coze.cn[\s\S]*route-tip-header-key">x-tt-env-fe<\/code>[\s\S]*target-ppe">PPE ppe_optimize_subs/);
  assert.match(row, /route-tip-role backend">后端<\/span>[\s\S]*route-tip-scope">\/api\/marketplace\/trade\/<\/span>[\s\S]*code.bots-boe.bytedance.net[\s\S]*route-tip-header-key">x-tt-env<\/code>[\s\S]*target-boe">BOE boe_optimize_subs/);
  assert.match(row, /route-tip-tag">规则<\/span>[\s\S]*system-proxy-rule-count">2 份启用/);
  assert.match(row, /system-proxy-rule-name">FlowPD-FE-BotStudio<\/span>[\s\S]*data-action="disable-bifrost-rule"[\s\S]*data-rule-name="FlowPD-FE-BotStudio"[\s\S]*data-rule-count="24"/);
  assert.match(row, /system-proxy-rule-name">FlowPD-FE-BotStudio-BOE<\/span>[\s\S]*data-action="disable-bifrost-rule"[\s\S]*data-rule-name="FlowPD-FE-BotStudio-BOE"[\s\S]*data-rule-count="27"/);
  assert.equal((row.match(/data-action="disable-bifrost-rule"/g) || []).length, 2);
  assert.match(row, /route-tip-tag">兜底<\/span>[\s\S]*未命中规则 → 直连原目标/);
  assert.match(details, /Bifrost :9900[\s\S]*启用规则 · 本地 · :3000 \/ :8080 \+ PPE \+ BOE/);
});

test("native Chrome Profile shows its actual system proxy while explaining it cannot be configured independently", () => {
  const { renderer, store } = loadProfilesRenderer();
  store.bifrostSnapshot = bifrostSnapshot({
    mainPort: 9900,
    systemProxy: {
      mode: "proxy",
      routes: [
        { protocol: "http", kind: "http", endpoint: "127.0.0.1:9900" },
        { protocol: "https", kind: "http", endpoint: "127.0.0.1:9900" }
      ]
    },
    mainRules: [{ name: "FlowPD-FE-BotStudio", ruleCount: 24 }],
    mainRuleDestination: {
      kind: "local",
      label: "本地 · :3000 / :8080",
      details: ["code.coze.cn → localhost:8080"]
    }
  });

  const row = renderer.renderProfileRow(profile({ source: "native", isDefault: true }));

  assert.match(row, /profile-route-track system system-proxy-active provider-bifrost action-tooltip structured-tooltip/);
  assert.match(row, /<strong>Bifrost :9900<\/strong>/);
  assert.match(row, /system-rule-summary">启用规则 · [\s\S]*本地 · :3000 \/ :8080/);
  assert.match(row, /系统 Chrome Profile 跟随系统代理，不支持单独配置/);
  assert.match(row, /route-tip-tag">HTTPS<\/span>[\s\S]*127\.0\.0\.1:9900/);
  assert.doesNotMatch(row, /<strong>Chrome 设置<\/strong>|<small>不可单独配置<\/small>/);
});

test("system proxy routed through Clash does not inherit unrelated Bifrost rules", () => {
  const { renderer, store } = loadProfilesRenderer();
  store.bifrostSnapshot = bifrostSnapshot({
    mainPort: 9900,
    systemProxy: {
      mode: "proxy",
      routes: [
        { protocol: "http", kind: "http", endpoint: "127.0.0.1:7897" },
        { protocol: "https", kind: "http", endpoint: "127.0.0.1:7897" }
      ]
    },
    mainRules: [{ name: "FlowPD-FE-BotStudio", ruleCount: 24 }],
    mainRuleDestination: {
      kind: "local",
      label: "本地 · :3000 / :8080",
      details: ["code.coze.cn → localhost:8080"]
    }
  });

  const configured = profile({ bifrostProxy: null, upstreamProxy: null });
  const row = renderer.renderProfileRow(configured);
  const details = renderer.renderDetails(configured, false);

  assert.match(row, /profile-route-track system system-proxy-active provider-clash action-tooltip structured-tooltip/);
  assert.match(row, /<strong>Clash Verge :7897<\/strong>[\s\S]*<small>规则由 Clash 决定<\/small>/);
  assert.match(row, /route-tip-status system[\s\S]*Clash Verge :7897[\s\S]*127\.0\.0\.1:7897/);
  assert.doesNotMatch(row, /system-proxy-rule-list|system-proxy-direct-fallback/);
  assert.doesNotMatch(row, /Bifrost :9900|FlowPD-FE-BotStudio|本地 · :3000 \/ :8080|localhost:8080|未命中规则 → 直连原目标/);
  assert.match(details, /Clash Verge :7897[\s\S]*规则由 Clash 决定/);
  assert.doesNotMatch(details, /Bifrost :9900|FlowPD-FE-BotStudio|本地 · :3000 \/ :8080|localhost:8080/);
});

test("unconfigured isolated Profile identifies system DIRECT mode", () => {
  const { renderer, store } = loadProfilesRenderer();
  store.bifrostSnapshot = bifrostSnapshot({
    systemProxy: {
      mode: "direct",
      routes: [
        { protocol: "http", kind: "direct", endpoint: null },
        { protocol: "https", kind: "direct", endpoint: null }
      ]
    }
  });

  const row = renderer.renderProfileRow(profile());
  assert.match(row, /profile-route-track system system-proxy-direct action-tooltip structured-tooltip/);
  assert.match(row, /<small>未启用 · DIRECT<\/small>/);
});

test("Bifrost route state resolves ok / stale / down from the status snapshot", () => {
  const { renderer } = loadProfilesRenderer();
  const configured = profile({
    id: "isolated:p1",
    bifrostProxy: { listenerPort: 18888, rules: ["worktree-a"], groupRules: [] }
  });

  // 绿：Bifrost 在跑且端口绑定名归属本 Profile（PublicProfile id 的 isolated: 前缀要剥掉再比对）。
  assert.equal(renderer.bifrostRouteState(configured, bifrostSnapshot({
    ports: [{ port: 18888, host: "127.0.0.1", name: "profilepilot:p1", status: "running" }]
  })), "ok");
  // 黄：在跑但端口未绑，或绑定名不属于本 Profile（启动时会自动重绑）。
  assert.equal(renderer.bifrostRouteState(configured, bifrostSnapshot()), "stale");
  assert.equal(renderer.bifrostRouteState(configured, bifrostSnapshot({
    ports: [{ port: 18888, host: "127.0.0.1", name: "profilepilot:other", status: "running" }]
  })), "stale");
  // 红：Bifrost 未运行 / 未安装。
  assert.equal(renderer.bifrostRouteState(configured, bifrostSnapshot({ running: false })), "down");
  assert.equal(renderer.bifrostRouteState(configured, bifrostSnapshot({ installed: false, running: false })), "down");
  // 未知：还没拿到快照，或该 Profile 根本没配置分流。
  assert.equal(renderer.bifrostRouteState(configured, null), "unknown");
  assert.equal(renderer.bifrostRouteState(profile(), bifrostSnapshot()), "unknown");
});

test("Bifrost route readout carries the tri-state class, listener and rule", () => {
  const { renderer, store } = loadProfilesRenderer();
  const configured = profile({
    id: "isolated:p1",
    bifrostProxy: { listenerPort: 18888, rules: ["worktree-a"], groupRules: [] }
  });

  store.bifrostSnapshot = bifrostSnapshot({
    ports: [{ port: 18888, host: "127.0.0.1", name: "profilepilot:p1", status: "running" }]
  });
  assert.match(renderer.renderProfileRow(configured), /profile-route-track bifrost ok action-tooltip structured-tooltip"[^>]*aria-label="Bifrost 独立分流生效中 · 127\.0\.0\.1:18888\s+启用规则：worktree-a"/);
  assert.match(renderer.renderProfileRow(configured), /route-tip-status ok[\s\S]*Bifrost · 独立分流生效中[\s\S]*<code>127\.0\.0\.1:18888<\/code>/);
  assert.match(renderer.renderProfileRow(configured), /<strong>Bifrost <em>:18888<\/em><\/strong>[\s\S]*<small>worktree-a<\/small>/);

  store.bifrostSnapshot = bifrostSnapshot();
  assert.match(renderer.renderProfileRow(configured), /profile-route-track bifrost stale action-tooltip structured-tooltip"[^>]*aria-label="[^"]*启动时会自动重绑[^"]*启用规则：worktree-a"/);
  assert.match(renderer.renderProfileRow(configured), /route-tip-status stale[\s\S]*Bifrost · 等待端口重绑/);
  assert.match(renderer.renderDetails(configured, false), /bifrost-route-state stale[^>]*>待重绑 · 启动时自动恢复</);

  store.bifrostSnapshot = bifrostSnapshot({ installed: false, running: false });
  assert.match(renderer.renderProfileRow(configured), /profile-route-track bifrost down action-tooltip structured-tooltip"[^>]*aria-label="[^"]*本次直连启动[^"]*启用规则：worktree-a"/);
  assert.match(renderer.renderProfileRow(configured), /route-tip-status down[\s\S]*Bifrost · 服务不可用/);
  assert.match(renderer.renderDetails(configured, false), /bifrost-route-state down[^>]*>Bifrost 未运行</);

  store.bifrostSnapshot = null;
  assert.match(renderer.renderProfileRow(configured), /profile-route-track bifrost unknown action-tooltip structured-tooltip"[^>]*aria-label="[^"]*启用规则：worktree-a"/);
});

test("Bifrost route readout shows the resolved localhost destination instead of only its rule name", () => {
  const { renderer, store } = loadProfilesRenderer();
  const configured = profile({
    id: "isolated:p1",
    bifrostProxy: {
      listenerPort: 18888,
      rules: ["space-local"],
      groupRules: []
    }
  });
  store.bifrostSnapshot = bifrostSnapshot({
    ruleDestinations: {
      "local:space-local": {
        kind: "local",
        label: "本地 · :3001 / :8081",
        details: [
          "bots-boe.bytedance.net → localhost:3001",
          "code.bots-boe.bytedance.net → localhost:8081"
        ]
      }
    }
  });

  const row = renderer.renderProfileRow(configured);
  assert.match(row, /profile-route-track bifrost stale destination-local action-tooltip structured-tooltip/);
  assert.match(row, /<small>本地 · :3001 \/ :8081<\/small>/);
  assert.match(row, /aria-label="[^"]*去向：本地 · :3001 \/ :8081[^"]*bots-boe.bytedance.net → localhost:3001[^"]*启用规则：space-local"/);
  assert.match(row, /route-tip-destination[\s\S]*destination-local">本地 · :3001 \/ :8081/);
  assert.match(row, /route-tip-mapping-source">bots-boe.bytedance.net<\/span>[\s\S]*route-tip-mapping-arrow[^>]*>→<\/span>[\s\S]*route-tip-mapping-target target-local">localhost:3001<\/span>/);
  assert.match(row, /route-tip-mapping-source">code.bots-boe.bytedance.net<\/span>[\s\S]*route-tip-mapping-target target-local">localhost:8081<\/span>/);
});

test("Bifrost route readout shows the resolved PPE environment", () => {
  const { renderer, store } = loadProfilesRenderer();
  const configured = profile({
    id: "isolated:p1",
    bifrostProxy: {
      listenerPort: 18888,
      rules: ["profile-ppe"],
      groupRules: []
    }
  });
  store.bifrostSnapshot = bifrostSnapshot({
    ruleDestinations: {
      "local:profile-ppe": {
        kind: "ppe",
        label: "PPE · 7349236909",
        details: ["code.coze.cn → x-tt-env-fe · PPE ppe_7349236909"]
      }
    }
  });

  const row = renderer.renderProfileRow(configured);
  assert.match(row, /profile-route-track bifrost stale destination-ppe action-tooltip structured-tooltip/);
  assert.match(row, /<small>PPE · 7349236909<\/small>/);
  assert.match(row, /aria-label="[^"]*code.coze.cn → x-tt-env-fe · PPE ppe_7349236909/);
  assert.match(row, /route-tip-destination[\s\S]*destination-ppe">PPE · 7349236909/);
  assert.match(row, /route-tip-role frontend">前端<\/span>[\s\S]*route-tip-mapping-source">code.coze.cn<\/span>[\s\S]*route-tip-header-key">x-tt-env-fe<\/code>[\s\S]*target-ppe">PPE ppe_7349236909/);
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

  assert.match(html, /colspan="6"/);
  assert.match(html, /外部管理[\s\S]*代理规则未知/);
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
  assert.match(css, /\.profiles-table col\.profile-col-route\s*\{[\s\S]*?width:\s*19%;/);
  assert.match(css, /grid-template-columns:\s*66px 34px 28px;/);
  assert.match(css, /\.profile-primary-action\s*\{\s*grid-column:\s*1;\s*grid-row:\s*1;/);
  assert.match(css, /\.profile-window-action\s*\{\s*grid-column:\s*2;\s*grid-row:\s*1;/);
  assert.match(css, /\.profile-menu-action\s*\{\s*grid-column:\s*3;\s*grid-row:\s*1;/);
  assert.match(css, /\.external-profile-actions\s*\{[\s\S]*?grid-template-columns:\s*66px 52px 34px;/);
  assert.match(css, /\.profile-activity-meta\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto;/);
  assert.doesNotMatch(css, /\.profile-activity-signal\s*\{[^}]*border-left:/);
  assert.doesNotMatch(css, /\.profiles-table \.cdp-cell\.off\s*\{[^}]*padding-left:\s*0;/);
  assert.match(css, /\.profile-details-modal-body\s*\{[\s\S]*?grid-template-columns:\s*minmax\(270px, 0\.7fr\) minmax\(460px, 1\.65fr\);/);
  assert.match(css, /\.profile-route-track\.provider-bifrost \.profile-route-copy strong,[\s\S]*?color:\s*#86d2ff;/);
  assert.match(css, /\.profile-route-track\.provider-clash \.profile-route-copy strong,[\s\S]*?color:\s*#b9a8ff;/);
});

test("proxy route tooltip stays interactive and exposes its full horizontal content", () => {
  const css = readFileSync(path.join(__dirname, "..", "public", "styles.src.css"), "utf8");

  assert.match(css, /\.route-tip-card::before\s*\{[\s\S]*?bottom:\s*-11px;[\s\S]*?height:\s*11px;/);
  assert.match(css, /\.profile-route-track:hover \.route-tip-card,[\s\S]*?pointer-events:\s*auto;/);
  assert.match(css, /\.route-tip-scroll-content\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;/);
  assert.match(css, /\.route-tip-horizontal-scroll\s*\{[\s\S]*?overflow-x:\s*auto;/);
  assert.match(css, /\.route-tip-horizontal-scroll-content\s*\{[\s\S]*?padding-bottom:\s*12px;/);
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
