const assert = require("node:assert/strict");
const test = require("node:test");

const { loadTsModule } = require("./helpers/load-ts-module.js");
const {
  buildProfileReadinessReceipt,
  compareVersions
} = loadTsModule("src/main/profile-readiness.ts");

function profile(overrides = {}) {
  return {
    id: "isolated:work",
    source: "isolated",
    name: "PPE 验证",
    running: true,
    cdpPort: 9223,
    cdpUrl: "http://127.0.0.1:9223",
    fixedCdpPort: 9223,
    userName: "person@example.test",
    agentAccessDisabled: false,
    bifrostProxy: {
      listenerPort: 18888,
      rules: ["worktree-a"],
      groupRules: [],
      disabledRules: [],
      disabledGroupRules: []
    },
    upstreamProxy: null,
    directConnection: false,
    livePrimaryUrl: "https://ppe.example.test/editor",
    windowActivation: "background",
    gatewayControl: {
      publicPort: 9223,
      ownership: "agent",
      sessionStatus: "active",
      driverState: "connected",
      ownerSessionId: "cx-12345678-1234-1234-1234-123456789abc",
      agentTarget: {
        targetId: "target-1",
        url: "https://ppe.example.test/editor"
      },
      pendingUserAction: null
    },
    agentBrowserOccupancy: null,
    ...overrides
  };
}

function bifrostSnapshot(overrides = {}) {
  return {
    installed: true,
    running: true,
    ports: [{ name: "profilepilot:work", port: 18888 }],
    upstreamHealth: {},
    systemProxy: { mode: "direct" },
    ...overrides
  };
}

test("readiness receipt proves the requested Profile, route, proxy, extension and canonical Session", () => {
  const receipt = buildProfileReadinessReceipt({
    profile: profile(),
    expectation: {
      requireRunning: true,
      requireCdp: true,
      requireAgentControl: true,
      expectedLogicalPort: 9223,
      expectedProxyKind: "bifrost",
      requiredBifrostRules: ["worktree-a"],
      expectedTargetUrlIncludes: "ppe.example.test",
      requiredExtensions: [{ id: "ext-one", name: "Verifier", minVersion: "2.4.0" }]
    },
    proxySnapshot: bifrostSnapshot(),
    extensions: [{ id: "ext-one", name: "Verifier", version: "2.4.1", enabled: true }],
    sessionIdentity: {
      canonicalSessionId: "codex:12345678-1234-1234-1234-123456789abc",
      engine: "codex",
      nativeSessionId: "12345678-1234-1234-1234-123456789abc",
      representations: [
        {
          source: "default-codex-home",
          filePath: "/tmp/.codex/sessions/rollout.jsonl",
          mtimeMs: 1,
          sizeBytes: 10
        },
        {
          source: "orca-codex-home",
          filePath: "/tmp/orca/sessions/rollout.jsonl",
          mtimeMs: 2,
          sizeBytes: 10
        }
      ],
      diagnostics: []
    }
  });

  assert.equal(receipt.overall, "ready");
  assert.deepEqual(receipt.blockerCodes, []);
  assert.equal(receipt.target.profileId, "isolated:work");
  assert.equal(receipt.checks.find((check) => check.id === "proxy").code, "BIFROST_ROUTE_READY");
  assert.equal(receipt.checks.find((check) => check.id === "session-identity").code, "SESSION_IDENTITY_CANONICAL");
  assert.match(receipt.checks.find((check) => check.id === "session-identity").evidence, /2 个来源表示/);
});

test("readiness receipt blocks mismatched logical requirements without guessing", () => {
  const receipt = buildProfileReadinessReceipt({
    profile: profile({
      windowActivation: "background",
      gatewayControl: {
        publicPort: 9223,
        ownership: "user",
        sessionStatus: "active",
        driverState: "quiesced",
        ownerSessionId: "cx-12345678-1234-1234-1234-123456789abc",
        agentTarget: { targetId: "target-1", url: "https://prod.example.test/" },
        pendingUserAction: "登录 PPE"
      }
    }),
    expectation: {
      requireAgentControl: true,
      requireForeground: true,
      expectedLogicalPort: 9226,
      expectedProxyKind: "bifrost",
      requiredBifrostRules: ["missing-rule"],
      expectedTargetUrlIncludes: "ppe.example.test"
    },
    proxySnapshot: bifrostSnapshot(),
    sessionIdentity: null
  });

  assert.equal(receipt.overall, "blocked");
  assert.ok(receipt.blockerCodes.includes("CDP_LOGICAL_PORT_MISMATCH"));
  assert.ok(receipt.blockerCodes.includes("BIFROST_RULE_MISMATCH"));
  assert.ok(receipt.blockerCodes.includes("TARGET_ROUTE_MISMATCH"));
  assert.ok(receipt.blockerCodes.includes("USER_OWNS_PROFILE"));
  assert.ok(receipt.blockerCodes.includes("PROFILE_BACKGROUND"));
});

test("site login remains unknown until a site-specific verifier supplies evidence", () => {
  const receipt = buildProfileReadinessReceipt({
    profile: profile({ bifrostProxy: null }),
    expectation: { expectedLoginLabel: "PPE 测试账号" },
    proxySnapshot: bifrostSnapshot(),
    sessionIdentity: null
  });

  assert.equal(receipt.overall, "degraded");
  const login = receipt.checks.find((check) => check.id === "login");
  assert.equal(login.code, "SITE_LOGIN_REQUIRES_VERIFICATION");
  assert.equal(login.status, "unknown");
  assert.match(login.action, /Cookies 或 Chrome 账号不能替代站点级验证/);
});

test("readiness recognizes an explicit direct connection as distinct from system proxy", () => {
  const receipt = buildProfileReadinessReceipt({
    profile: profile({ bifrostProxy: null, upstreamProxy: null, directConnection: true }),
    expectation: { expectedProxyKind: "direct" },
    proxySnapshot: bifrostSnapshot(),
    sessionIdentity: null
  });

  const proxy = receipt.checks.find((check) => check.id === "proxy");
  assert.equal(proxy.code, "DIRECT_CONNECTION_ENABLED");
  assert.equal(proxy.status, "pass");
  assert.match(proxy.actual, /绕过系统代理/);
});

test("readiness version comparison handles dotted extension versions", () => {
  assert.equal(compareVersions("2.4.1", "2.4.0"), 1);
  assert.equal(compareVersions("2.4", "2.4.0"), 0);
  assert.equal(compareVersions("2.3.9", "2.4.0"), -1);
});
