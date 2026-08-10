const assert = require("node:assert/strict");
const { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadTsModule } = require("./helpers/load-ts-module.js");
const {
  bifrostProxyChromeArgs,
  bifrostRuleArgs,
  canHotUpdateProfileBifrostProxy,
  combineBifrostRuleDestinations,
  disableBifrostRule,
  ensureProfileBifrostProxy,
  normalizeStoredBifrostProxy,
  normalizeStoredUpstreamProxy,
  parseBifrostPortBinding,
  parseBifrostRuleDestination,
  parseBifrostRuleList,
  parseBifrostStatus,
  startBifrostIfNeeded,
  upstreamProxyChromeArgs,
  validateBifrostProxyConfig,
  validateUpstreamProxyConfig
} = loadTsModule("src/main/bifrost-proxy.ts");

test("Bifrost rule list parser keeps local rules and excludes global Default", () => {
  const rules = parseBifrostRuleList(`Rules (4):
  Default [enabled, global, protected]
  worktree-a [disabled]
  worktree b [enabled]
  example/host [disabled]
`);
  assert.deepEqual(rules, ["worktree-a", "worktree b", "example/host"]);
});

test("Bifrost rule destination parser summarizes localhost ports and domain mappings", () => {
  const destination = parseBifrostRuleDestination("space-local", `Rule: space-local
Status: disabled
Content:
line\`
bots-boe.bytedance.net/ http://127.0.0.1:3001
excludeFilter://h:x-stop-bifrost=1
\`

line\`
code.bots-boe.bytedance.net/
http://127.0.0.1:8081
\`
`);
  assert.deepEqual(destination, {
    kind: "local",
    label: "本地 · :3001 / :8081",
    details: [
      "bots-boe.bytedance.net → localhost:3001",
      "code.bots-boe.bytedance.net → localhost:8081"
    ]
  });
});

test("Bifrost rule destination parser recognizes PPE and BOE environment headers", () => {
  assert.deepEqual(
    parseBifrostRuleDestination("profile-ppe", `Content:
code.coze.cn/ reqHeaders://(x-tt-env-fe=ppe_7349236909)
www.coze.cn/ reqHeaders://(x-tt-env-fe=ppe_7349236909)
`),
    {
      kind: "ppe",
      label: "PPE · 7349236909",
      details: [
        "code.coze.cn → x-tt-env-fe · PPE ppe_7349236909",
        "www.coze.cn → x-tt-env-fe · PPE ppe_7349236909"
      ]
    }
  );
  assert.deepEqual(
    parseBifrostRuleDestination("profile-boe", 'coze.cn/ reqHeaders://{"x-tt-env":"boe_alpha"}'),
    {
      kind: "boe",
      label: "BOE · alpha",
      details: ["coze.cn → x-tt-env · BOE boe_alpha"]
    }
  );
});

test("Bifrost rule destination parser distinguishes frontend routing from backend environment switching", () => {
  const destination = parseBifrostRuleDestination("frontend-and-backend", `Content:
# 代理 https://code.bots-boe.bytedance.net/ 到本地前端
line\`
code.bots-boe.bytedance.net/ http://127.0.0.1:8080
includeFilter://m:GET
excludeFilter://code.bots-boe.bytedance.net/api/
excludeFilter://code.bots-boe.bytedance.net/open_api/
\`
code.bots-boe.bytedance.net/api/marketplace/trade/ reqHeaders://{"x-tt-env":"boe_coze_optimize_subs"}
`);
  assert.deepEqual(destination, {
    kind: "mixed",
    label: "本地 · :8080 + BOE · coze_optimize_subs",
    details: [
      "前端（GET · 排除 API 等） · code.bots-boe.bytedance.net → localhost:8080",
      "后端（/api/marketplace/trade/） · code.bots-boe.bytedance.net → x-tt-env · BOE boe_coze_optimize_subs"
    ]
  });
});

test("Bifrost rule destinations combine localhost, PPE and BOE for the main rule view", () => {
  assert.deepEqual(
    combineBifrostRuleDestinations([
      {
        kind: "local",
        label: "本地 · :3000 / :8080",
        details: [
          "bots-boe.bytedance.net → localhost:3000",
          "code.bots-boe.bytedance.net → localhost:8080"
        ]
      },
      {
        kind: "ppe",
        label: "PPE · optimize_subs",
        details: ["code.coze.cn → x-tt-env-fe · PPE ppe_optimize_subs"]
      },
      {
        kind: "boe",
        label: "BOE · optimize_subs",
        details: ["code.bots-boe.bytedance.net → x-tt-env · BOE boe_optimize_subs"]
      }
    ]),
    {
      kind: "mixed",
      label: "本地 · :3000 / :8080 + PPE + BOE",
      details: [
        "bots-boe.bytedance.net → localhost:3000",
        "code.bots-boe.bytedance.net → localhost:8080",
        "code.coze.cn → x-tt-env-fe · PPE ppe_optimize_subs",
        "code.bots-boe.bytedance.net → x-tt-env · BOE boe_optimize_subs"
      ]
    }
  );
});

test("Bifrost status parser extracts main and temporary listener ports with binding metadata", () => {
  const status = parseBifrostStatus(JSON.stringify({
    version: "0.0.158",
    running: true,
    listener: { host: "0.0.0.0", port: 9900 },
    ports: [
      18888,
      { port: 18889, host: "127.0.0.1", name: "profilepilot:profile-a", status: "running" },
      { listener_port: 18890 }
    ],
    active_rules: [
      { group: "Default", rule_count: 0, enabled: true },
      { group: "local-target", rule_count: 8, enabled: true },
      { group: "disabled-target", rule_count: 3, enabled: false }
    ]
  }));
  assert.deepEqual(status, {
    running: true,
    version: "0.0.158",
    mainPort: 9900,
    ports: [
      { port: 18888, host: null, name: null, status: null },
      { port: 18889, host: "127.0.0.1", name: "profilepilot:profile-a", status: "running" },
      { port: 18890, host: null, name: null, status: null }
    ],
    activeRules: [{ name: "local-target", ruleCount: 8 }]
  });
});

test("stored Bifrost config is normalized and unsafe or invalid refs are removed", () => {
  const config = normalizeStoredBifrostProxy({
    listenerPort: 18888,
    rules: [" worktree-a ", "Default", "worktree-a", "--bad"],
    groupRules: ["7152084678483132446/shared-auth", "invalid"],
    disabledRules: ["worktree-a", "missing"],
    disabledGroupRules: ["invalid"]
  });
  assert.deepEqual(config, {
    listenerPort: 18888,
    rules: ["worktree-a"],
    groupRules: ["7152084678483132446/shared-auth"],
    disabledRules: ["worktree-a"]
  });
  assert.equal(normalizeStoredBifrostProxy({ listenerPort: 990, rules: ["a"] }), null);
  assert.equal(normalizeStoredBifrostProxy({ listenerPort: 18888, rules: [], groupRules: [] }), null);
});

test("validated Bifrost config builds isolated listener and Chrome args", () => {
  const config = validateBifrostProxyConfig({
    listenerPort: 18888,
    rules: ["worktree-a", "shared-auth"],
    groupRules: ["7152084678483132446/team-rule"],
    disabledRules: ["worktree-a"]
  });
  assert.deepEqual(bifrostRuleArgs(config), [
    "--rule", "shared-auth",
    "--group-rule", "7152084678483132446/team-rule"
  ]);
  assert.deepEqual(bifrostProxyChromeArgs(config), ["--proxy-server=http://127.0.0.1:18888"]);
});

test("validated Bifrost config rejects a dedicated view with every managed rule paused", () => {
  assert.throws(
    () => validateBifrostProxyConfig({
      listenerPort: 18888,
      rules: ["worktree-a"],
      groupRules: [],
      disabledRules: ["worktree-a"]
    }),
    /至少需要保留一条启用规则/
  );
});

test("Bifrost port metadata parser identifies ProfilePilot ownership and loopback host", () => {
  assert.deepEqual(parseBifrostPortBinding(`Temporary port: 127.0.0.1:18888
Name: profilepilot:profile-a
Status: Running
Rules:
  - local:worktree-a
`), {
    host: "127.0.0.1",
    name: "profilepilot:profile-a"
  });
});

// —— ensureProfileBifrostProxy 状态机（fake-binary 模式）——
// 用一段假 bifrost shell 脚本按 argv 分派预置输出，并把每次调用记录进日志文件，
// 逐分支断言「探测 → 绑定/更新/重建/拒绝」的调用序列。

const STATE_MACHINE_CONFIG = { listenerPort: 18888, rules: ["worktree-a"], groupRules: [] };

test("running Profile only hot-updates Bifrost rules on the same listener", () => {
  assert.equal(canHotUpdateProfileBifrostProxy(
    STATE_MACHINE_CONFIG,
    { ...STATE_MACHINE_CONFIG, rules: ["worktree-b"] }
  ), true);
  assert.equal(canHotUpdateProfileBifrostProxy(
    STATE_MACHINE_CONFIG,
    { ...STATE_MACHINE_CONFIG, listenerPort: 18889 }
  ), false);
  assert.equal(canHotUpdateProfileBifrostProxy(STATE_MACHINE_CONFIG, null), false);
  assert.equal(canHotUpdateProfileBifrostProxy(null, STATE_MACHINE_CONFIG), false);
});

function makeFakeBifrost({
  statusJson,
  portShowStdout = null,
  portShowExit = 1,
  startTransitionsToRunning = false
}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "pp-bifrost-fake-"));
  const binary = path.join(home, "bin", "bifrost");
  const callsPath = path.join(home, "bifrost-calls.log");
  const startedPath = path.join(home, "bifrost-started");
  const runningStatusJson = { ...statusJson, running: true };
  mkdirSync(path.dirname(binary), { recursive: true });
  writeFileSync(binary, `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(callsPath)}
if [ "$1" = status ]; then
  if [ -f ${JSON.stringify(startedPath)} ]; then
    printf '%s\n' '${JSON.stringify(runningStatusJson)}'
    exit 0
  fi
  printf '%s\n' '${JSON.stringify(statusJson)}'
  exit 0
fi
if [ "$1" = start ]; then
${startTransitionsToRunning ? `  touch ${JSON.stringify(startedPath)}` : "  :"}
  exit 0
fi
if [ "$1" = port ] && [ "$2" = show ]; then
${portShowStdout ? `  printf '%s\n' '${portShowStdout}'` : "  :"}
  exit ${portShowExit}
fi
exit 0
`);
  chmodSync(binary, 0o755);
  return {
    home,
    env: { BIFROST_BINARY: binary, PATH: process.env.PATH, HOME: home },
    calls: () => readFileSync(callsPath, "utf8").trim().split("\n"),
    dispose: () => rmSync(home, { recursive: true, force: true })
  };
}

const RUNNING_STATUS = { running: true, version: "test", listener: { host: "0.0.0.0", port: 9900 }, ports: [] };

test("ensureProfileBifrostProxy binds a brand-new isolated listener", async () => {
  const fake = makeFakeBifrost({ statusJson: RUNNING_STATUS, portShowExit: 1 });
  try {
    const args = await ensureProfileBifrostProxy("profile-a", STATE_MACHINE_CONFIG, fake.env);
    assert.deepEqual(args, ["--proxy-server=http://127.0.0.1:18888"]);
    assert.deepEqual(fake.calls(), [
      "status --format json",
      "port show 18888",
      "port bind --port 18888 -H 127.0.0.1 --name profilepilot:profile-a --rule worktree-a"
    ]);
  } finally {
    fake.dispose();
  }
});

test("ensureProfileBifrostProxy updates an existing binding owned by the same Profile", async () => {
  const fake = makeFakeBifrost({
    statusJson: RUNNING_STATUS,
    portShowStdout: "Temporary port: 127.0.0.1:18888\nName: profilepilot:profile-a",
    portShowExit: 0
  });
  try {
    const args = await ensureProfileBifrostProxy("profile-a", STATE_MACHINE_CONFIG, fake.env);
    assert.deepEqual(args, ["--proxy-server=http://127.0.0.1:18888"]);
    assert.deepEqual(fake.calls(), [
      "status --format json",
      "port show 18888",
      "port update 18888 --name profilepilot:profile-a --rule worktree-a"
    ]);
  } finally {
    fake.dispose();
  }
});

test("ensureProfileBifrostProxy rebinds when the owned listener is not on loopback", async () => {
  const fake = makeFakeBifrost({
    statusJson: RUNNING_STATUS,
    portShowStdout: "Temporary port: 0.0.0.0:18888\nName: profilepilot:profile-a",
    portShowExit: 0
  });
  try {
    await ensureProfileBifrostProxy("profile-a", STATE_MACHINE_CONFIG, fake.env);
    assert.deepEqual(fake.calls(), [
      "status --format json",
      "port show 18888",
      "port destroy 18888",
      "port bind --port 18888 -H 127.0.0.1 --name profilepilot:profile-a --rule worktree-a"
    ]);
  } finally {
    fake.dispose();
  }
});

test("ensureProfileBifrostProxy refuses a listener owned by another binding name", async () => {
  const fake = makeFakeBifrost({
    statusJson: RUNNING_STATUS,
    portShowStdout: "Temporary port: 127.0.0.1:18888\nName: profilepilot:other-profile",
    portShowExit: 0
  });
  try {
    await assert.rejects(
      () => ensureProfileBifrostProxy("profile-a", STATE_MACHINE_CONFIG, fake.env),
      (error) => error.code === "BIFROST_PORT_IN_USE"
    );
    // 拒绝后不得再发出 bind/update/destroy，避免抢占别人的端口。
    assert.deepEqual(fake.calls(), ["status --format json", "port show 18888"]);
  } finally {
    fake.dispose();
  }
});

test("ensureProfileBifrostProxy refuses the Bifrost main proxy port", async () => {
  const fake = makeFakeBifrost({ statusJson: RUNNING_STATUS });
  try {
    await assert.rejects(
      () => ensureProfileBifrostProxy("profile-a", { ...STATE_MACHINE_CONFIG, listenerPort: 9900 }, fake.env),
      (error) => error.code === "BIFROST_PORT_IS_MAIN"
    );
    assert.deepEqual(fake.calls(), ["status --format json"]);
  } finally {
    fake.dispose();
  }
});

test("ensureProfileBifrostProxy fails fast when Bifrost is not running", async () => {
  const fake = makeFakeBifrost({ statusJson: { ...RUNNING_STATUS, running: false } });
  try {
    await assert.rejects(
      () => ensureProfileBifrostProxy("profile-a", STATE_MACHINE_CONFIG, fake.env),
      (error) => error.code === "BIFROST_NOT_RUNNING"
    );
    assert.deepEqual(fake.calls(), ["status --format json"]);
  } finally {
    fake.dispose();
  }
});

test("ProfilePilot can start Bifrost daemon, restore the listener, and then inject proxy args", async () => {
  const fake = makeFakeBifrost({
    statusJson: { ...RUNNING_STATUS, running: false },
    portShowExit: 1,
    startTransitionsToRunning: true
  });
  try {
    await startBifrostIfNeeded(fake.env);
    const args = await ensureProfileBifrostProxy("profile-a", STATE_MACHINE_CONFIG, fake.env);
    assert.deepEqual(args, ["--proxy-server=http://127.0.0.1:18888"]);
    assert.deepEqual(fake.calls(), [
      "status --format json",
      "start --daemon",
      "status --format json",
      "status --format json",
      "port show 18888",
      "port bind --port 18888 -H 127.0.0.1 --name profilepilot:profile-a --rule worktree-a"
    ]);
  } finally {
    fake.dispose();
  }
});

test("disableBifrostRule only disables a rule reported as currently active", async () => {
  const fake = makeFakeBifrost({
    statusJson: {
      ...RUNNING_STATUS,
      active_rules: [
        { group: "worktree-a", rule_count: 8, enabled: true },
        { group: "worktree-b", rule_count: 3, enabled: false }
      ]
    }
  });
  try {
    await disableBifrostRule("worktree-a", fake.env);
    assert.deepEqual(fake.calls(), [
      "status --format json",
      "rule disable worktree-a"
    ]);

    await assert.rejects(
      () => disableBifrostRule("worktree-b", fake.env),
      (error) => error.code === "BIFROST_RULE_NOT_ACTIVE"
    );
    assert.deepEqual(fake.calls(), [
      "status --format json",
      "rule disable worktree-a",
      "status --format json"
    ]);
  } finally {
    fake.dispose();
  }
});

test("disableBifrostRule rejects Default and unsafe rule names before invoking Bifrost", async () => {
  await assert.rejects(
    () => disableBifrostRule("Default", {}),
    (error) => error.code === "BIFROST_RULE_INVALID"
  );
  await assert.rejects(
    () => disableBifrostRule("--help", {}),
    (error) => error.code === "BIFROST_RULE_INVALID"
  );
});

// —— Phase 2：直连 Clash 上游模式 ——

test("upstream proxy config normalizes bare host:port and rejects unparseable input", () => {
  assert.deepEqual(normalizeStoredUpstreamProxy({ server: "127.0.0.1:7897" }), {
    server: "http://127.0.0.1:7897"
  });
  assert.deepEqual(normalizeStoredUpstreamProxy({ server: "socks5://127.0.0.1:7891", bypassList: " localhost , *.local " }), {
    server: "socks5://127.0.0.1:7891",
    bypassList: "localhost,*.local"
  });
  assert.equal(normalizeStoredUpstreamProxy({ server: "not a url" }), null);
  assert.equal(normalizeStoredUpstreamProxy({ server: "ftp://127.0.0.1:21" }), null);
  assert.equal(normalizeStoredUpstreamProxy({}), null);
});

test("validateUpstreamProxyConfig throws on invalid server, keeps bypass optional", () => {
  assert.throws(
    () => validateUpstreamProxyConfig({ server: "??" }),
    (error) => error.code === "INVALID_UPSTREAM_PROXY"
  );
  assert.deepEqual(validateUpstreamProxyConfig({ server: "http://127.0.0.1:7897" }), {
    server: "http://127.0.0.1:7897"
  });
});

test("upstreamProxyChromeArgs emits proxy-server (scheme-stripped for http) and optional bypass", () => {
  assert.deepEqual(upstreamProxyChromeArgs({ server: "http://127.0.0.1:7897" }), [
    "--proxy-server=127.0.0.1:7897"
  ]);
  assert.deepEqual(upstreamProxyChromeArgs({ server: "socks5://127.0.0.1:7891", bypassList: "localhost,*.local" }), [
    "--proxy-server=socks5://127.0.0.1:7891",
    "--proxy-bypass-list=localhost,*.local"
  ]);
  assert.deepEqual(upstreamProxyChromeArgs(null), []);
});
