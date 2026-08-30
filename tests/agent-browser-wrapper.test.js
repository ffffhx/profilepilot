const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  PROFILEPILOT_AGENT_BROWSER_HARD_STOP_EXIT_CODE,
  PROFILEPILOT_AGENT_BROWSER_LEASE_CONFLICT_EXIT_CODE,
  PROFILEPILOT_AGENT_BROWSER_USAGE_EXIT_CODE,
  acquireProfileLeaseForCommandWithAutomaticSwitch,
  agentBrowserCommandName,
  assertManagedGatewayLaunchOptions,
  cdpPortFromAgentBrowserArgs,
  clearProfilePilotNoticesForSession,
  consumeProfilePilotReturnNotice,
  findActiveProfilePilotNotice,
  formatAutomaticProfileSwitch,
  formatControlReturnedNotice,
  formatHardStopNotice,
  formatProfileLeaseConflict,
  formatControlledRawCdpFailure,
  gatewaySupportsAgentActivity,
  managedGatewayAgentBrowserEnv,
  replaceCdpPortInAgentBrowserArgs,
  resolveProfilePilotUseArgs,
  resolveRealAgentBrowser,
  runAgentBrowserWrapper,
  sessionFromAgentBrowserArgs,
  shouldCheckProfilePilotNotice
} = require("../dist/main/agent-browser-wrapper.js");
const {
  acquireAgentBrowserProfileLeaseSync,
  findAgentBrowserProfileLeaseForSessionSync,
  readAgentBrowserProfileLeaseSync,
  setConfiguredAgentBrowserProfileBifrostProxySync,
  setAgentBrowserProfileLeasesDelegatedSync,
  writeAgentBrowserRuntimeProfilesSync
} = require("../dist/main/agent-browser-lease.js");
const {
  agentBrowserSessionActivityPaths,
  clearAgentBrowserCommandStateSync,
  readActiveAgentBrowserCommandStateSync,
  readActiveAgentBrowserControlWaitStateSync,
  readActiveAgentBrowserSessionActivityClientsByPort,
  repositoryIdentityFromCwd,
  writeAgentBrowserCommandStateSync,
  writeAgentBrowserSessionActivitySync
} = require("../dist/main/agent-browser-session.js");
const { browserGatewaySocketPath } = require("../dist/main/browser-gateway-client.js");

test("agent-browser wrapper resolves session from args before env", () => {
  assert.equal(sessionFromAgentBrowserArgs(["--session", "cx-arg", "open"], { AGENT_BROWSER_SESSION: "cx-env" }), "cx-arg");
  assert.equal(sessionFromAgentBrowserArgs(["--session=cx-inline", "open"], { AGENT_BROWSER_SESSION: "cx-env" }), "cx-inline");
  assert.equal(sessionFromAgentBrowserArgs(["open"], { AGENT_BROWSER_SESSION: "cx-env" }), "cx-env");
  assert.equal(sessionFromAgentBrowserArgs(["--session", "../bad", "open"], { AGENT_BROWSER_SESSION: "" }), undefined);
});

test("agent-browser wrapper checks notices only for browser operations", () => {
  assert.equal(agentBrowserCommandName(["--cdp", "9223", "open", "https://example.test"]), "open");
  assert.equal(agentBrowserCommandName(["--session=cx-one", "--cdp=9223", "snapshot"]), "snapshot");
  assert.equal(cdpPortFromAgentBrowserArgs(["--cdp", "9223", "open", "https://example.test"]), 9223);
  assert.equal(cdpPortFromAgentBrowserArgs(["--cdp=ws://127.0.0.1:9224/devtools/browser/one", "snapshot"]), 9224);
  assert.equal(cdpPortFromAgentBrowserArgs(["connect", "9225"]), 9225);
  assert.equal(shouldCheckProfilePilotNotice(["--cdp", "9223", "open", "https://example.test"]), true);
  assert.equal(shouldCheckProfilePilotNotice(["skills", "get", "core"]), false);
  assert.equal(shouldCheckProfilePilotNotice(["session", "list"]), false);
  assert.equal(shouldCheckProfilePilotNotice(["--version"]), false);
  assert.equal(agentBrowserCommandName(["--proxy", "http://127.0.0.1:7897", "open"]), "open");
});

test("managed Gateway child env isolates controller proxies case-insensitively without changing Profile routing", () => {
  const original = {
    HTTP_PROXY: "http://127.0.0.1:7897",
    https_proxy: "http://127.0.0.1:7897",
    All_Proxy: "socks5://127.0.0.1:7897",
    AGENT_BROWSER_PROXY: "http://controller.test:8080",
    agent_browser_proxy_bypass: "localhost",
    NO_PROXY: "127.0.0.1,localhost",
    PATH: "test-path"
  };
  const isolated = managedGatewayAgentBrowserEnv(original);

  assert.deepEqual(isolated, {
    NO_PROXY: "127.0.0.1,localhost",
    PATH: "test-path"
  });
  assert.equal(original.HTTP_PROXY, "http://127.0.0.1:7897", "the parent environment must remain unchanged");
});

test("managed Gateway rejects agent-browser launch proxy options and points to Profile proxy settings", () => {
  assert.throws(
    () => assertManagedGatewayLaunchOptions(["--proxy", "http://127.0.0.1:7897", "open"]),
    (error) => error.code === "GATEWAY_LAUNCH_OPTION_CONFLICT" && /目标 Profile/.test(error.message)
  );
  assert.throws(
    () => assertManagedGatewayLaunchOptions(["--proxy-bypass=localhost", "snapshot"]),
    (error) => error.code === "GATEWAY_LAUNCH_OPTION_CONFLICT"
  );
  assert.doesNotThrow(() => assertManagedGatewayLaunchOptions(["open", "https://example.test"]));
});

test("activity verification waits for a running old Gateway route to upgrade safely", () => {
  assert.equal(gatewaySupportsAgentActivity({ ok: true, protocolVersion: 13 }), true);
  assert.equal(gatewaySupportsAgentActivity({ ok: true, protocolVersion: 12 }), false);
  assert.equal(gatewaySupportsAgentActivity({ ok: true }), false);
});

test("profilepilot profiles uses Profile names as selection hints and publishes blocked access", async () => {
  const home = path.join(os.tmpdir(), `profilepilot-agent-catalog-${process.pid}-${Date.now()}`);
  writeAgentBrowserRuntimeProfilesSync([
    {
      profileId: "isolated:ppe",
      profileName: "PPE 验证",
      cdpPort: 9223,
      running: false
    },
    {
      profileId: "isolated:private",
      profileName: "生产账号",
      cdpPort: 9224,
      running: true,
      agentAccessDisabled: true
    }
  ], home);
  const writes = captureProcessWrites();
  try {
    assert.equal(await runAgentBrowserWrapper(["profilepilot", "profiles"], { HOME: home }), 0);
    const output = JSON.parse(writes.stdout.join(""));
    assert.match(output.selection_guidance, /Profile 名称就是选择提示/);
    assert.deepEqual(output.profiles.map((profile) => ({
      cdpPort: profile.cdp_port,
      available: profile.available,
      access: profile.agent_access,
      selectionHint: profile.selection_hint
    })), [
      { cdpPort: 9223, available: true, access: "allowed", selectionHint: "PPE 验证" },
      { cdpPort: 9224, available: false, access: "blocked", selectionHint: "生产账号" }
    ]);
  } finally {
    writes.restore();
    rmSync(home, { recursive: true, force: true });
  }
});

test("profilepilot use resolves an exact Profile name into the protected Gateway connection", () => {
  const home = path.join(os.tmpdir(), `profilepilot-agent-use-${process.pid}-${Date.now()}`);
  writeAgentBrowserRuntimeProfilesSync([
    {
      profileId: "isolated:ppe",
      profileName: "PPE 验证",
      cdpPort: 9323,
      running: false
    }
  ], home);
  try {
    assert.deepEqual(
      resolveProfilePilotUseArgs(
        ["profilepilot", "use", "PPE 验证"],
        { HOME: home, AGENT_BROWSER_SESSION: "cx-use-profile" }
      ),
      ["--session", "cx-use-profile", "--cdp", "9323", "connect", "9323"]
    );
    assert.throws(
      () => resolveProfilePilotUseArgs(["profilepilot", "use", "PPE 验证"], { HOME: home }),
      /当前终端没有 Agent Session/
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("profilepilot readiness returns a structured hard stop when the target Profile is unresolved", async () => {
  const home = makeTempHome();
  const writes = captureProcessWrites();
  try {
    const exitCode = await runAgentBrowserWrapper([
      "--session",
      "cx-12345678-1234-1234-1234-123456789abc",
      "profilepilot",
      "readiness",
      "--expect-profile",
      "PPE 验证"
    ], { HOME: home });
    assert.equal(exitCode, PROFILEPILOT_AGENT_BROWSER_HARD_STOP_EXIT_CODE);
    const receipt = JSON.parse(writes.stderr.join(""));
    assert.equal(receipt.version, 1);
    assert.equal(receipt.overall, "blocked");
    assert.deepEqual(receipt.blocker_codes, ["TARGET_PROFILE_UNRESOLVED"]);
  } finally {
    writes.restore();
    rmSync(home, { recursive: true, force: true });
  }
});

test("raw CDP policy rejection is a controlled error rather than a hard stop", () => {
  const error = Object.assign(
    new Error("Raw CDP method denied: Target.closeTarget"),
    { code: "RAW_CDP_METHOD_DENIED" }
  );
  const output = formatControlledRawCdpFailure(
    error,
    ["--cdp", "9224", "profilepilot", "cdp", "call", "Target.closeTarget"],
    { AGENT_BROWSER_SESSION: "cx-one" }
  );

  assert.match(output, /"error_code": "RAW_CDP_METHOD_DENIED"/);
  assert.match(output, /"hard_stop": false/);
  assert.match(output, /"session": "cx-one"/);
  assert.match(output, /"cdp_port": 9224/);
});

test("a bounded raw CDP call timeout does not incorrectly hard-stop a healthy Gateway", () => {
  const error = Object.assign(
    new Error("CDP call Runtime.evaluate timed out"),
    { code: "CDP_CALL_TIMEOUT" }
  );
  const output = formatControlledRawCdpFailure(
    error,
    ["--cdp", "9224", "profilepilot", "cdp", "call", "Runtime.evaluate"],
    { AGENT_BROWSER_SESSION: "cx-one" }
  );

  assert.match(output, /"error_code": "CDP_CALL_TIMEOUT"/);
  assert.match(output, /"hard_stop": false/);
  assert.match(output, /调用已超时并被终止/);
});

test("a missing raw CDP page target is recoverable and does not hard-stop the Gateway", () => {
  const error = Object.assign(
    new Error("页面 Target stale-target 不存在"),
    { code: "AGENT_TARGET_NOT_FOUND" }
  );
  const output = formatControlledRawCdpFailure(
    error,
    [
      "--cdp",
      "9224",
      "profilepilot",
      "cdp",
      "call",
      "Runtime.evaluate",
      "--target",
      "stale-target"
    ],
    { AGENT_BROWSER_SESSION: "cx-one" }
  );

  assert.match(output, /"error_code": "AGENT_TARGET_NOT_FOUND"/);
  assert.match(output, /"hard_stop": false/);
  assert.match(output, /Target\.getTargets/);
});

test("a page-level raw CDP protocol error does not masquerade as a Gateway hard stop", () => {
  const error = Object.assign(
    new Error("Script not found"),
    {
      code: "GATEWAY_ERROR",
      detail: {
        error_code: "GATEWAY_ERROR",
        message: "Script not found"
      }
    }
  );
  const output = formatControlledRawCdpFailure(
    error,
    [
      "--cdp",
      "9224",
      "profilepilot",
      "cdp",
      "call",
      "Page.removeScriptToEvaluateOnNewDocument"
    ],
    { AGENT_BROWSER_SESSION: "cx-one" }
  );

  assert.match(output, /"error_code": "GATEWAY_ERROR"/);
  assert.match(output, /"hard_stop": false/);
  assert.match(output, /Gateway 连接仍可继续使用/);
});

test("agent-browser wrapper rewrites CDP arguments for an automatic Profile switch", () => {
  assert.deepEqual(
    replaceCdpPortInAgentBrowserArgs(["--cdp", "9223", "snapshot"], 9224),
    ["--cdp", "9224", "snapshot"]
  );
  assert.deepEqual(
    replaceCdpPortInAgentBrowserArgs(["--session=cx-one", "--cdp=9223", "click", "Save"], 9224),
    ["--session=cx-one", "--cdp=9224", "click", "Save"]
  );
  assert.deepEqual(replaceCdpPortInAgentBrowserArgs(["connect", "9223"], 9224), ["connect", "9224"]);
  assert.deepEqual(replaceCdpPortInAgentBrowserArgs(["snapshot"], 9224), ["--cdp", "9224", "snapshot"]);
});

test("ProfilePilot configures a stopped logical Profile with an isolated Bifrost listener", () => {
  const home = makeTempHome();
  const dataDir = path.join(home, "profilepilot-data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, "profiles.json"), `${JSON.stringify({
    profiles: [
      { id: "profile-a", name: "A", dirName: "a", createdAt: "", lastLaunchedAt: null, fixedCdpPort: 9223 },
      { id: "profile-b", name: "B", dirName: "b", createdAt: "", lastLaunchedAt: null, fixedCdpPort: 9226 }
    ]
  }, null, 2)}\n`);
  const env = { HOME: home, CPM_DATA_DIR: dataDir };

  const updated = setConfiguredAgentBrowserProfileBifrostProxySync(9226, {
    listenerPort: 18889,
    rules: ["FlowPD-FE-BotStudio-3001-8081"],
    groupRules: []
  }, env, home);
  assert.equal(updated.profileName, "B");
  assert.equal(updated.previous, null);
  assert.deepEqual(updated.current, {
    listenerPort: 18889,
    rules: ["FlowPD-FE-BotStudio-3001-8081"],
    groupRules: []
  });
  const registry = JSON.parse(readFileSync(path.join(dataDir, "profiles.json"), "utf8"));
  assert.deepEqual(registry.profiles[1].bifrostProxy, updated.current);

  const cleared = setConfiguredAgentBrowserProfileBifrostProxySync(9226, null, env, home);
  assert.deepEqual(cleared.previous, updated.current);
  assert.equal(cleared.current, null);
  rmSync(home, { recursive: true, force: true });
});

test("ProfilePilot rejects Bifrost listener collisions with another Profile", () => {
  const home = makeTempHome();
  const dataDir = path.join(home, "profilepilot-data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, "profiles.json"), `${JSON.stringify({
    profiles: [
      {
        id: "profile-a",
        name: "A",
        dirName: "a",
        createdAt: "",
        lastLaunchedAt: null,
        fixedCdpPort: 9223,
        bifrostProxy: { listenerPort: 18889, rules: ["worktree-a"], groupRules: [] }
      },
      { id: "profile-b", name: "B", dirName: "b", createdAt: "", lastLaunchedAt: null, fixedCdpPort: 9226 }
    ]
  }, null, 2)}\n`);
  const env = { HOME: home, CPM_DATA_DIR: dataDir };
  assert.throws(
    () => setConfiguredAgentBrowserProfileBifrostProxySync(9226, {
      listenerPort: 18889,
      rules: ["worktree-b"],
      groupRules: []
    }, env, home),
    (error) => error.code === "BIFROST_PORT_IN_USE"
  );
  rmSync(home, { recursive: true, force: true });
});

test("profilepilot bifrost command persists the rule without requiring an Agent session", async () => {
  const home = makeTempHome();
  const dataDir = path.join(home, "profilepilot-data");
  const fakeBifrost = path.join(home, "bin", "bifrost.js");
  const callsPath = path.join(home, "bifrost-calls.log");
  const cdpPort = await freeTcpPort();
  mkdirSync(path.dirname(fakeBifrost), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(fakeBifrost, fakeBifrostSource(callsPath, { portShowExit: 1 }));
  chmodSync(fakeBifrost, 0o755);
  writeFileSync(path.join(dataDir, "profiles.json"), `${JSON.stringify({
    profiles: [{
      id: "profile-b",
      name: "B",
      dirName: "b",
      createdAt: "",
      lastLaunchedAt: null,
      fixedCdpPort: cdpPort
    }]
  }, null, 2)}\n`);
  const capture = captureProcessWrites();
  try {
    const exitCode = await runAgentBrowserWrapper([
      "--cdp",
      String(cdpPort),
      "profilepilot",
      "bifrost",
      "--listener-port",
      "18889",
      "--rule",
      "FlowPD-FE-BotStudio-3001-8081"
    ], {
      HOME: home,
      CPM_DATA_DIR: dataDir,
      BIFROST_BINARY: fakeBifrost,
      PATH: process.env.PATH
    });
    assert.equal(exitCode, 0);
    assert.match(capture.stdout.join(""), /"listener_port": 18889/);
  } finally {
    capture.restore();
  }
  const registry = JSON.parse(readFileSync(path.join(dataDir, "profiles.json"), "utf8"));
  assert.deepEqual(registry.profiles[0].bifrostProxy, {
    listenerPort: 18889,
    rules: ["FlowPD-FE-BotStudio-3001-8081"],
    groupRules: []
  });
  assert.match(readFileSync(callsPath, "utf8"), /port bind --port 18889 -H 127\.0\.0\.1/);
  rmSync(home, { recursive: true, force: true });
});

test("profilepilot bifrost --clear removes a stopped Profile rule and destroys its listener", async () => {
  const home = makeTempHome();
  const dataDir = path.join(home, "profilepilot-data");
  const fakeBifrost = path.join(home, "bin", "bifrost.js");
  const callsPath = path.join(home, "bifrost-calls.log");
  const cdpPort = await freeTcpPort();
  mkdirSync(path.dirname(fakeBifrost), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(fakeBifrost, fakeBifrostSource(callsPath, { portShowExit: 0 }));
  chmodSync(fakeBifrost, 0o755);
  writeFileSync(path.join(dataDir, "profiles.json"), `${JSON.stringify({
    profiles: [{
      id: "profile-b",
      name: "B",
      dirName: "b",
      createdAt: "",
      lastLaunchedAt: null,
      fixedCdpPort: cdpPort,
      bifrostProxy: {
        listenerPort: 18889,
        rules: ["worktree-old"],
        groupRules: []
      }
    }]
  }, null, 2)}\n`);

  const capture = captureProcessWrites();
  try {
    const exitCode = await runAgentBrowserWrapper([
      "--cdp",
      String(cdpPort),
      "profilepilot",
      "bifrost",
      "--clear"
    ], {
      HOME: home,
      CPM_DATA_DIR: dataDir,
      BIFROST_BINARY: fakeBifrost,
      PATH: process.env.PATH
    });
    assert.equal(exitCode, 0);
    assert.match(capture.stdout.join(""), /"action": "bifrost-clear"/);
  } finally {
    capture.restore();
  }

  const registry = JSON.parse(readFileSync(path.join(dataDir, "profiles.json"), "utf8"));
  assert.equal(registry.profiles[0].bifrostProxy, null);
  assert.match(
    readFileSync(callsPath, "utf8"),
    /port destroy 18889/
  );
  rmSync(home, { recursive: true, force: true });
});

test("profilepilot bifrost command hot-updates rules for a running Profile on the same listener", async () => {
  const home = makeTempHome();
  const dataDir = path.join(home, "profilepilot-data");
  const fakeBifrost = path.join(home, "bin", "bifrost.js");
  const callsPath = path.join(home, "bifrost-calls.log");
  const cdpServer = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"webSocketDebuggerUrl":"ws://127.0.0.1/devtools/browser/test"}');
  });
  await new Promise((resolve, reject) => {
    cdpServer.once("error", reject);
    cdpServer.listen(0, "127.0.0.1", resolve);
  });
  const cdpAddress = cdpServer.address();
  const cdpPort = typeof cdpAddress === "object" && cdpAddress ? cdpAddress.port : 0;
  mkdirSync(path.dirname(fakeBifrost), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(fakeBifrost, fakeBifrostSource(callsPath, { portShowExit: 0 }));
  chmodSync(fakeBifrost, 0o755);
  writeFileSync(path.join(dataDir, "profiles.json"), `${JSON.stringify({
    profiles: [{
      id: "profile-b",
      name: "B",
      dirName: "b",
      createdAt: "",
      lastLaunchedAt: null,
      fixedCdpPort: cdpPort,
      bifrostProxy: {
        listenerPort: 18889,
        rules: ["worktree-old"],
        groupRules: []
      }
    }]
  }, null, 2)}\n`);

  const capture = captureProcessWrites();
  try {
    const exitCode = await runAgentBrowserWrapper([
      "--cdp",
      String(cdpPort),
      "profilepilot",
      "bifrost",
      "--listener-port",
      "18889",
      "--rule",
      "worktree-new"
    ], {
      HOME: home,
      CPM_DATA_DIR: dataDir,
      BIFROST_BINARY: fakeBifrost,
      PATH: process.env.PATH
    });
    assert.equal(exitCode, 0);
  } finally {
    capture.restore();
    await new Promise((resolve) => cdpServer.close(resolve));
  }

  const registry = JSON.parse(readFileSync(path.join(dataDir, "profiles.json"), "utf8"));
  assert.deepEqual(registry.profiles[0].bifrostProxy, {
    listenerPort: 18889,
    rules: ["worktree-new"],
    groupRules: []
  });
  assert.match(
    readFileSync(callsPath, "utf8"),
    /port update 18889 --name profilepilot:profile-b --rule worktree-new/
  );
  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper skips the managed child-shell launcher when resolving the real CLI", () => {
  const home = makeTempHome();
  const commandName = process.platform === "win32" ? "agent-browser.cmd" : "agent-browser";
  const managedLauncher = path.join(home, ".profilepilot", "bin", commandName);
  const realAgentBrowser = path.join(home, "real", commandName);
  mkdirSync(path.dirname(managedLauncher), { recursive: true });
  mkdirSync(path.dirname(realAgentBrowser), { recursive: true });
  writeFileSync(managedLauncher, process.platform === "win32" ? "@exit /b 99\r\n" : "#!/bin/sh\nexit 99\n", "utf8");
  writeFileSync(realAgentBrowser, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(managedLauncher, 0o755);
  chmodSync(realAgentBrowser, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = [path.dirname(managedLauncher), path.dirname(realAgentBrowser), process.env.PATH || ""].join(path.delimiter);
  try {
    assert.equal(resolveRealAgentBrowser({
      HOME: home,
      PATH: process.env.PATH,
      PROFILEPILOT_AGENT_BROWSER_LAUNCHER: managedLauncher
    }, path.join(home, "profilepilot-agent-browser-wrapper.cjs")), realAgentBrowser);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(home, { recursive: true, force: true });
  }
});

test("agent-browser session activity files become synthetic ProfilePilot clients", async () => {
  const home = makeTempHome();
  writeAgentBrowserSessionActivitySync({
    session: "cx-one",
    command: "open",
    cdpPort: 9223,
    pid: process.pid,
    cwd: "/tmp/profilepilot",
    daemonPid: process.pid
  }, home, Date.parse("2026-07-09T00:00:00.000Z"));

  const byPort = await readActiveAgentBrowserSessionActivityClientsByPort(
    [9223],
    home,
    Date.parse("2026-07-09T00:05:00.000Z")
  );
  const clients = byPort.get(9223);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].label, "agent-browser");
  assert.equal(clients[0].session, "cx-one");
  assert.equal(clients[0].agent, "Codex");
  assert.equal(clients[0].project, "profilepilot");

  rmSync(home, { recursive: true, force: true });
});

test("agent-browser resolves the repository project and branch instead of the workspace folder name", async () => {
  const home = makeTempHome();
  const cwd = path.join(home, "workspaces", "coze-monorepo", "master");
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "checkout", "-q", "-b", "feat/agent-overlay"]);
  execFileSync("git", ["-C", cwd, "remote", "add", "origin", "git@code.example:team/coze-monorepo.git"]);

  assert.deepEqual(repositoryIdentityFromCwd(cwd), {
    project: "coze-monorepo",
    branch: "feat/agent-overlay"
  });

  writeAgentBrowserSessionActivitySync({
    session: "cx-repository",
    command: "snapshot",
    cdpPort: 9223,
    pid: process.pid,
    cwd
  }, home, Date.parse("2026-07-09T00:00:00.000Z"));
  const clients = (await readActiveAgentBrowserSessionActivityClientsByPort(
    [9223],
    home,
    Date.parse("2026-07-09T00:05:00.000Z")
  )).get(9223);
  assert.equal(clients[0].project, "coze-monorepo");
  assert.equal(clients[0].branch, "feat/agent-overlay");

  rmSync(home, { recursive: true, force: true });
});

test("agent-browser session activity remains visible after command process exits", async () => {
  const home = makeTempHome();
  writeAgentBrowserSessionActivitySync({
    session: "cx-dead-command",
    command: "get cdp-url",
    cdpPort: 9224,
    pid: 99_999_999,
    cwd: "/tmp/profilepilot"
  }, home, Date.parse("2026-07-09T00:00:00.000Z"));

  const byPort = await readActiveAgentBrowserSessionActivityClientsByPort(
    [9224],
    home,
    Date.parse("2026-07-09T00:05:00.000Z")
  );
  const clients = byPort.get(9224);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].pid, 99_999_999);
  assert.equal(clients[0].label, "agent-browser");
  assert.equal(clients[0].session, "cx-dead-command");
  assert.match(clients[0].note, /按 Session 保持可见化/);

  rmSync(home, { recursive: true, force: true });
});

test("agent-browser command state tracks every parallel command in one Session", () => {
  const home = makeTempHome();
  const startedAt = new Date().toISOString();
  for (const [commandId, command] of [["cmd-one", "snapshot"], ["cmd-two", "click"]]) {
    writeAgentBrowserCommandStateSync({
      commandId,
      session: "cx-parallel",
      command,
      wrapperPid: process.pid,
      phase: "running",
      startedAt
    }, home);
  }

  assert.ok(readActiveAgentBrowserCommandStateSync("cx-parallel", home));
  clearAgentBrowserCommandStateSync("cx-parallel", "cmd-one", home);
  assert.equal(readActiveAgentBrowserCommandStateSync("cx-parallel", home).commandId, "cmd-two");
  clearAgentBrowserCommandStateSync("cx-parallel", "cmd-two", home);
  assert.equal(readActiveAgentBrowserCommandStateSync("cx-parallel", home), null);
  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper finds active ProfilePilot hard-stop notices", () => {
  const home = makeTempHome();
  const noticePath = path.join(home, ".agent-browser", "cx-one.profilepilot-control.json");
  mkdirSync(path.dirname(noticePath), { recursive: true });
  writeFileSync(
    noticePath,
    `${JSON.stringify({
      version: 1,
      code: "AGENT_USER_IN_CONTROL",
      reason: "user_takeover",
      ownership: "agentDelegatedToUser",
      message: "用户已接管这个 Profile，AI 浏览器命令已暂停",
      action: "停手",
      hardStop: true,
      profileId: "profile-1",
      profileName: "Profile One",
      pid: 101,
      label: "agent-browser",
      session: "cx-one",
      at: "2026-07-09T00:00:00.000Z",
      expiresAt: "2026-07-09T00:30:00.000Z"
    })}\n`
  );

  const match = findActiveProfilePilotNotice(["--cdp", "9223", "open", "https://example.test"], {
    HOME: home,
    AGENT_BROWSER_SESSION: "cx-one"
  }, Date.parse("2026-07-09T00:05:00.000Z"));

  assert.equal(match.path, noticePath);
  assert.equal(match.notice.code, "AGENT_USER_IN_CONTROL");
  assert.match(formatHardStopNotice(match), /"error_code": "AGENT_USER_IN_CONTROL"/);
  assert.equal(PROFILEPILOT_AGENT_BROWSER_HARD_STOP_EXIT_CODE, 75);

  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper hard-stops while Agent completion is still draining", () => {
  const home = makeTempHome();
  const noticePath = path.join(home, ".agent-browser", "cx-one.profilepilot-control.json");
  mkdirSync(path.dirname(noticePath), { recursive: true });
  writeFileSync(
    noticePath,
    `${JSON.stringify({
      version: 1,
      code: "AGENT_USER_IN_CONTROL",
      reason: "agent_complete",
      ownership: "agentDelegatedToUser",
      handoffState: "requested",
      message: "Agent 已完成当前任务，浏览器控制权已交还用户",
      action: "等待用户交还",
      hardStop: true,
      profileId: "profile-1",
      profileName: "Profile One",
      pid: 101,
      label: "agent-browser",
      session: "cx-one",
      at: "2026-07-09T00:00:00.000Z",
      expiresAt: "9999-12-31T23:59:59.999Z"
    })}\n`
  );

  const match = findActiveProfilePilotNotice(["snapshot"], {
    HOME: home,
    AGENT_BROWSER_SESSION: "cx-one"
  }, Date.parse("2099-07-10T08:00:00.000Z"));

  assert.equal(match.notice.reason, "agent_complete");
  assert.equal(match.notice.ownership, "agentDelegatedToUser");
  assert.match(formatHardStopNotice(match), /"reason": "agent_complete"/);
  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper permanently rejects a Session released after reconnect exhaustion", () => {
  const home = makeTempHome();
  const noticePath = path.join(home, ".profilepilot", "agent-control", "cx-expired.json");
  mkdirSync(path.dirname(noticePath), { recursive: true });
  writeFileSync(noticePath, `${JSON.stringify({
    version: 1,
    controlVersion: 4,
    code: "AGENT_DRIVER_RECONNECT_FAILED",
    reason: "driver_reconnect_exhausted",
    ownership: "user",
    message: "浏览器驱动重连失败，旧 Session 已释放",
    action: "创建新的 Agent Session",
    hardStop: true,
    profileId: "profile-expired",
    profileName: "Profile Expired",
    pid: 101,
    label: "agent-browser",
    session: "cx-expired",
    at: "2026-07-09T00:00:00.000Z",
    expiresAt: "9999-12-31T23:59:59.999Z"
  })}\n`);

  const match = findActiveProfilePilotNotice(["snapshot"], {
    HOME: home,
    AGENT_BROWSER_SESSION: "cx-expired"
  }, Date.parse("2099-07-10T08:00:00.000Z"));
  assert.equal(match.notice.code, "AGENT_DRIVER_RECONNECT_FAILED");
  assert.equal(match.notice.ownership, "user");
  assert.match(formatHardStopNotice(match), /"reason": "driver_reconnect_exhausted"/);
  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper surfaces a takeover created while the real command is running", async () => {
  const home = makeTempHome();
  mkdirSync(home, { recursive: true });
  const fakeAgentBrowser = path.join(home, "fake-agent-browser.js");
  writeFileSync(
    fakeAgentBrowser,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const session = process.env.AGENT_BROWSER_SESSION;
const noticePath = path.join(process.env.HOME, ".agent-browser", session + ".profilepilot-control.json");
fs.mkdirSync(path.dirname(noticePath), { recursive: true });
fs.writeFileSync(noticePath, JSON.stringify({
  version: 1,
  controlVersion: 1,
  code: "AGENT_USER_IN_CONTROL",
  reason: "user_takeover",
  ownership: "agentDelegatedToUser",
  handoffState: "requested",
  message: "用户已接管这个 Profile，AI 浏览器命令已暂停",
  hardStop: true,
  profileId: "profile-1",
  profileName: "Profile One",
  pid: process.pid,
  label: "agent-browser",
  session,
  at: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString()
}) + "\\n");
`
  );
  chmodSync(fakeAgentBrowser, 0o755);
  const writes = captureProcessWrites();
  try {
    const exitCode = await runAgentBrowserWrapper(["open", "https://example.test"], {
      ...process.env,
      HOME: home,
      AGENT_BROWSER_SESSION: "cx-one",
      PROFILEPILOT_AGENT_BROWSER_REAL: fakeAgentBrowser
    });
    assert.equal(exitCode, PROFILEPILOT_AGENT_BROWSER_HARD_STOP_EXIT_CODE);
  } finally {
    writes.restore();
  }
  assert.match(writes.stderr.join(""), /"error_code": "AGENT_USER_IN_CONTROL"/);
  const settledNotice = JSON.parse(readFileSync(
    path.join(home, ".agent-browser", "cx-one.profilepilot-control.json"),
    "utf8"
  ));
  assert.equal(settledNotice.handoffState, "quiesced");
  assert.equal(settledNotice.controlVersion, 2);
  assert.equal(readActiveAgentBrowserCommandStateSync("cx-one", home), null);
  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper completion releases the Session and Profile lease", async () => {
  const home = makeTempHome();
  acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9223,
    session: "cx-complete",
    holderPid: process.pid,
    profileId: "profile-1",
    profileName: "Profile One",
    project: "profilepilot",
    command: "snapshot"
  }, home);
  writeAgentBrowserSessionActivitySync({
    session: "cx-complete",
    command: "snapshot",
    cdpPort: 9223,
    pid: process.pid,
    cwd: "/tmp/profilepilot"
  }, home);

  const writes = captureProcessWrites();
  let exitCode;
  try {
    exitCode = await runAgentBrowserWrapper(["profilepilot", "complete"], {
      HOME: home,
      AGENT_BROWSER_SESSION: "cx-complete"
    });
  } finally {
    writes.restore();
  }

  assert.equal(exitCode, 0);
  assert.match(writes.stdout.join(""), /"ownership": "user"/);
  assert.match(writes.stdout.join(""), /"released_ports": \[/);
  assert.match(writes.stdout.join(""), /Session 和 Profile 租约已释放/);
  assert.equal(readAgentBrowserProfileLeaseSync(9223, home), null);
  assert.equal(agentBrowserSessionActivityPaths(home, "cx-complete").some((file) => existsSync(file)), false);
  assert.equal(existsSync(path.join(home, ".profilepilot", "agent-control", "cx-complete.json")), false);
  assert.equal(existsSync(path.join(home, ".agent-browser", "cx-complete.profilepilot-control.json")), false);
  rmSync(home, { recursive: true, force: true });
});

test("profilepilot close shuts down its own Gateway Profile and releases the Session", async () => {
  const home = makeTempHome();
  const session = "cx-close";
  const port = 9224;
  acquireAgentBrowserProfileLeaseSync({
    cdpPort: port,
    session,
    holderPid: process.pid,
    profileId: "profile-close",
    profileName: "Profile Close",
    project: "profilepilot",
    command: "snapshot"
  }, home);
  writeAgentBrowserSessionActivitySync({
    session,
    command: "snapshot",
    cdpPort: port,
    pid: process.pid,
    cwd: "/tmp/profilepilot"
  }, home);

  const requests = [];
  const socketPath = browserGatewaySocketPath(home);
  mkdirSync(path.dirname(socketPath), { recursive: true });
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const boundary = buffer.indexOf("\n");
      if (boundary < 0) return;
      const request = JSON.parse(buffer.slice(0, boundary));
      requests.push(request);
      if (request.action === "status") {
        socket.end(`${JSON.stringify({
          ok: true,
          state: {
            profiles: [{
              profileId: "profile-close",
              profileName: "Profile Close",
              publicPort: port,
              ownership: "agent",
              ownerSessionId: session,
              sessionStatus: "active"
            }]
          }
        })}\n`);
        return;
      }
      socket.end(`${JSON.stringify({ ok: true })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const writes = captureProcessWrites();
  try {
    const exitCode = await runAgentBrowserWrapper([
      "--cdp",
      String(port),
      "profilepilot",
      "close"
    ], {
      HOME: home,
      AGENT_BROWSER_SESSION: session
    });
    assert.equal(exitCode, 0);
  } finally {
    writes.restore();
    await new Promise((resolve) => server.close(resolve));
  }

  assert.deepEqual(
    requests.map((request) => request.action),
    ["status", "unregister-profile"]
  );
  assert.deepEqual(requests[1], {
    action: "unregister-profile",
    publicPort: port,
    closeChrome: true
  });
  assert.match(writes.stdout.join(""), /"action": "close"/);
  assert.match(writes.stdout.join(""), /Profile Close/);
  assert.equal(readAgentBrowserProfileLeaseSync(port, home), null);
  assert.equal(
    agentBrowserSessionActivityPaths(home, session).some((file) =>
      existsSync(file)
    ),
    false
  );
  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper requires an explicit reason for handoff", async () => {
  const home = makeTempHome();
  const writes = captureProcessWrites();
  let exitCode;
  try {
    exitCode = await runAgentBrowserWrapper(["profilepilot", "handoff"], {
      HOME: home,
      AGENT_BROWSER_SESSION: "cx-handoff"
    });
  } finally {
    writes.restore();
  }

  assert.equal(exitCode, PROFILEPILOT_AGENT_BROWSER_USAGE_EXIT_CODE);
  assert.match(writes.stderr.join(""), /handoff 必须通过 --reason/);
  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper reconciles its lease from Gateway ownership after a failed handoff response", async () => {
  const home = makeTempHome();
  const session = "cx-handoff-reconcile";
  const port = 9223;
  acquireAgentBrowserProfileLeaseSync({
    cdpPort: port,
    session,
    holderPid: process.pid,
    profileId: "profile-reconcile",
    profileName: "Profile Reconcile",
    project: "profilepilot",
    command: "snapshot"
  }, home);
  writeAgentBrowserSessionActivitySync({
    session,
    command: "snapshot",
    cdpPort: port,
    pid: process.pid,
    cwd: "/tmp/profilepilot"
  }, home);

  let ownership = "agent";
  const socketPath = browserGatewaySocketPath(home);
  mkdirSync(path.dirname(socketPath), { recursive: true });
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const boundary = buffer.indexOf("\n");
      if (boundary < 0) return;
      const request = JSON.parse(buffer.slice(0, boundary));
      const profile = {
        profileId: "profile-reconcile",
        profileName: "Profile Reconcile",
        publicPort: port,
        ownerSessionId: session,
        sessionStatus: "active",
        ownership,
        agentHealth: ownership === "user" ? "waiting" : "online",
        pendingUserAction: ownership === "user" ? "完成登录" : undefined,
        controlGeneration: ownership === "user" ? 2 : 1
      };
      if (request.action === "status") {
        socket.end(`${JSON.stringify({ ok: true, state: { profiles: [profile] } })}\n`);
        return;
      }
      if (request.action === "control" && request.command === "takeover") {
        ownership = "user";
        // Simulate an RPC failure after Gateway has durably committed ownership.
        socket.end(`${JSON.stringify({
          ok: false,
          error_code: "TEST_RESPONSE_LOST_AFTER_COMMIT",
          message: "response lost after takeover commit"
        })}\n`);
        return;
      }
      socket.end(`${JSON.stringify({ ok: false, error_code: "TEST_UNKNOWN", message: "unexpected request" })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const writes = captureProcessWrites();
  let exitCode;
  try {
    exitCode = await runAgentBrowserWrapper([
      "profilepilot",
      "handoff",
      "--reason",
      "完成登录"
    ], {
      HOME: home,
      AGENT_BROWSER_SESSION: session
    });
  } finally {
    writes.restore();
    await new Promise((resolve) => server.close(resolve));
  }

  assert.equal(exitCode, 0, "authoritative user ownership means the handoff itself succeeded");
  assert.equal(readAgentBrowserProfileLeaseSync(port, home).delegatedToUser, true);
  const notice = JSON.parse(readFileSync(
    path.join(home, ".profilepilot", "agent-control", `${session}.json`),
    "utf8"
  ));
  assert.equal(notice.handoffState, "quiesced");
  assert.equal(notice.ownership, "agentDelegatedToUser");
  const outputChunk = writes.stdout.find((chunk) => (
    chunk.includes(`"session": "${session}"`) && chunk.includes('"action": "handoff"')
  ));
  assert.ok(outputChunk, "wrapper must emit the reconciled handoff result");
  const output = JSON.parse(outputChunk);
  assert.equal(output.ownership, "user");
  assert.equal(output.reveal_confirmed, false);
  assert.match(output.reveal_error, /重新查询并确认控制权在用户侧/);
  assert.doesNotMatch(output.message, /已带到台前/);
  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper requires an absolute validated unpacked extension path", async () => {
  const home = makeTempHome();
  const writes = captureProcessWrites();
  let exitCode;
  try {
    exitCode = await runAgentBrowserWrapper([
      "--cdp",
      "9223",
      "profilepilot",
      "extension",
      "load-unpacked",
      "relative/extension"
    ], {
      HOME: home,
      AGENT_BROWSER_SESSION: "cx-extension"
    });
  } finally {
    writes.restore();
  }

  assert.equal(exitCode, PROFILEPILOT_AGENT_BROWSER_USAGE_EXIT_CODE);
  assert.match(writes.stderr.join(""), /"error_code": "EXTENSION_PATH_MUST_BE_ABSOLUTE"/);
  assert.equal(readAgentBrowserProfileLeaseSync(9223, home), null);
  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper waits for the durable user-return event without retiring the parked daemon", async () => {
  const home = makeTempHome();
  const fakeDaemonPath = path.join(home, "fixture-agent-browser-daemon.js");
  mkdirSync(home, { recursive: true });
  writeFileSync(fakeDaemonPath, "setInterval(() => {}, 1000);\n");
  const daemon = spawn(process.execPath, [fakeDaemonPath], { detached: true, stdio: "ignore" });
  daemon.unref();
  const daemonPid = daemon.pid;
  const daemonPidPath = path.join(home, ".agent-browser", "cx-wait.pid");
  mkdirSync(path.dirname(daemonPidPath), { recursive: true });
  writeFileSync(daemonPidPath, `${daemonPid}\n`);
  acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9223,
    session: "cx-wait",
    holderPid: process.pid,
    daemonPid,
    profileId: "profile-1",
    profileName: "Profile One",
    command: "snapshot"
  }, home);
  setAgentBrowserProfileLeasesDelegatedSync("cx-wait", true, home);
  const noticePath = path.join(home, ".profilepilot", "agent-control", "cx-wait.json");
  const mirrorPath = path.join(home, ".agent-browser", "cx-wait.profilepilot-control.json");
  const takeoverNotice = {
    version: 1,
    controlVersion: 1,
    code: "AGENT_USER_IN_CONTROL",
    reason: "user_takeover",
    ownership: "agentDelegatedToUser",
    handoffState: "quiesced",
    message: "用户已接管",
    action: "等待用户交还",
    hardStop: true,
    profileId: "profile-1",
    profileName: "Profile One",
    pid: process.pid,
    label: "agent-browser",
    session: "cx-wait",
    at: new Date().toISOString(),
    expiresAt: "9999-12-31T23:59:59.999Z"
  };
  for (const filePath of [noticePath, mirrorPath]) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(takeoverNotice)}\n`);
  }

  const writes = captureProcessWrites();
  let exitCode;
  try {
    let settled = false;
    const waiting = runAgentBrowserWrapper(["profilepilot", "wait-control"], {
      HOME: home,
      AGENT_BROWSER_SESSION: "cx-wait"
    });
    waiting.finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(settled, false, "wait-control must not have an implicit business timeout");
    assert.equal(readActiveAgentBrowserControlWaitStateSync("cx-wait", home)?.pid, process.pid);
    setAgentBrowserProfileLeasesDelegatedSync("cx-wait", false, home);
    const returned = {
      ...takeoverNotice,
      controlVersion: 2,
      code: "AGENT_CONTROL_RETURNED",
      reason: "user_return",
      ownership: "agent",
      hardStop: false,
      message: "用户已将浏览器控制权交还 Agent",
      action: "重新 snapshot 后继续",
      at: new Date().toISOString()
    };
    delete returned.handoffState;
    for (const filePath of [noticePath, mirrorPath]) {
      writeFileSync(filePath, `${JSON.stringify(returned)}\n`);
    }
    exitCode = await waiting;
  } finally {
    writes.restore();
  }

  assert.equal(exitCode, 0);
  assert.match(writes.stdout.join(""), /"event_code": "AGENT_CONTROL_RETURNED"/);
  assert.equal(existsSync(noticePath), false);
  assert.equal(existsSync(mirrorPath), false);
  assert.equal(existsSync(daemonPidPath), true);
  assert.equal(isProcessAlive(daemonPid), true);
  assert.equal(readActiveAgentBrowserControlWaitStateSync("cx-wait", home), null);
  assert.equal(readAgentBrowserProfileLeaseSync(9223, home).delegatedToUser, undefined);
  try { process.kill(daemonPid, "SIGKILL"); } catch {}
  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper can clear ProfilePilot notices for explicit resume", async () => {
  const home = makeTempHome();
  const noticePath = path.join(home, ".agent-browser", "cx-one.profilepilot-control.json");
  const mirrorPath = path.join(home, ".profilepilot", "agent-control", "cx-one.json");
  mkdirSync(path.dirname(noticePath), { recursive: true });
  mkdirSync(path.dirname(mirrorPath), { recursive: true });
  writeFileSync(noticePath, "{}\n");
  writeFileSync(mirrorPath, "{}\n");

  const cleared = clearProfilePilotNoticesForSession("cx-one", home);
  assert.deepEqual(cleared, [noticePath, mirrorPath]);
  assert.equal(findActiveProfilePilotNotice(["open", "https://example.test"], { HOME: home, AGENT_BROWSER_SESSION: "cx-one" }), null);
  writeAgentBrowserSessionActivitySync({
    session: "cx-one",
    command: "snapshot",
    cdpPort: 9223,
    pid: process.pid,
    cwd: "/tmp/profilepilot"
  }, home);
  const writes = captureProcessWrites();
  try {
    assert.equal(await runAgentBrowserWrapper(["profilepilot", "resume"], { HOME: home, AGENT_BROWSER_SESSION: "cx-one" }), 0);
    assert.equal(await runAgentBrowserWrapper(["profilepilot", "resume"], { HOME: home }), PROFILEPILOT_AGENT_BROWSER_USAGE_EXIT_CODE);
  } finally {
    writes.restore();
  }
  assert.match(writes.stdout.join(""), /"action": "resume"/);
  assert.match(writes.stderr.join(""), /找不到 AGENT_BROWSER_SESSION/);

  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper explicitly releases its Session and Profile lease", async () => {
  const home = makeTempHome();
  acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9223,
    session: "cx-one",
    holderPid: process.pid,
    profileId: "profile-1",
    profileName: "Profile One",
    project: "profilepilot",
    command: "snapshot"
  }, home);
  writeAgentBrowserSessionActivitySync({
    session: "cx-one",
    command: "snapshot",
    cdpPort: 9223,
    pid: process.pid,
    cwd: "/tmp/profilepilot"
  }, home);
  const completionNoticePath = path.join(home, ".agent-browser", "cx-one.profilepilot-control.json");
  mkdirSync(path.dirname(completionNoticePath), { recursive: true });
  writeFileSync(completionNoticePath, `${JSON.stringify({ reason: "agent_complete" })}\n`);
  assert.ok(agentBrowserSessionActivityPaths(home, "cx-one").some((file) => existsSync(file)));

  const writes = captureProcessWrites();
  let exitCode;
  try {
    exitCode = await runAgentBrowserWrapper(["profilepilot", "release"], {
      HOME: home,
      AGENT_BROWSER_SESSION: "cx-one"
    });
  } finally {
    writes.restore();
  }

  assert.equal(exitCode, 0);
  assert.match(writes.stdout.join(""), /"action": "release"/);
  assert.match(writes.stdout.join(""), /"ownership": "user"/);
  assert.match(writes.stdout.join(""), /"clearedNotices"/);
  assert.equal(findAgentBrowserProfileLeaseForSessionSync("cx-one", home), null);
  assert.equal(agentBrowserSessionActivityPaths(home, "cx-one").some((file) => existsSync(file)), false);
  assert.equal(existsSync(completionNoticePath), false);
  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper consumes and reports a user-return notice without hard-stopping", () => {
  const home = makeTempHome();
  const noticePath = path.join(home, ".agent-browser", "cx-one.profilepilot-control.json");
  const mirrorPath = path.join(home, ".profilepilot", "agent-control", "cx-one.json");
  const notice = {
    version: 1,
    code: "AGENT_CONTROL_RETURNED",
    reason: "user_return",
    ownership: "agent",
    message: "用户已将这个 Profile 的浏览器控制权交还 Agent",
    action: "先重新读取页面状态，再继续任务",
    hardStop: false,
    profileId: "profile-1",
    profileName: "Profile One",
    pid: 101,
    label: "agent-browser",
    session: "cx-one",
    at: "2026-07-09T00:10:00.000Z",
    expiresAt: "2026-07-09T00:30:00.000Z"
  };
  mkdirSync(path.dirname(noticePath), { recursive: true });
  mkdirSync(path.dirname(mirrorPath), { recursive: true });
  writeFileSync(noticePath, `${JSON.stringify(notice)}\n`);
  writeFileSync(mirrorPath, `${JSON.stringify(notice)}\n`);

  const match = consumeProfilePilotReturnNotice(
    ["--cdp", "9223", "snapshot"],
    { HOME: home, AGENT_BROWSER_SESSION: "cx-one" },
    Date.parse("2026-07-09T00:11:00.000Z")
  );

  assert.equal(match.notice.code, "AGENT_CONTROL_RETURNED");
  assert.match(formatControlReturnedNotice(match), /"hard_stop": false/);
  assert.match(formatControlReturnedNotice(match), /"event_code": "AGENT_CONTROL_RETURNED"/);
  assert.equal(
    consumeProfilePilotReturnNotice(
      ["snapshot"],
      { HOME: home, AGENT_BROWSER_SESSION: "cx-one" },
      Date.parse("2026-07-09T00:11:00.000Z")
    ),
    null
  );
  assert.equal(findActiveProfilePilotNotice(["snapshot"], { HOME: home, AGENT_BROWSER_SESSION: "cx-one" }), null);

  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper ignores expired notices", () => {
  const home = makeTempHome();
  const noticePath = path.join(home, ".profilepilot", "agent-control", "cx-one.json");
  mkdirSync(path.dirname(noticePath), { recursive: true });
  writeFileSync(
    noticePath,
    `${JSON.stringify({
      version: 1,
      code: "AGENT_TASK_STOPPED",
      reason: "user_stop",
      ownership: "user",
      message: "用户已终止这个 Profile 的 AI 浏览器任务",
      hardStop: true,
      profileId: "profile-1",
      profileName: "Profile One",
      pid: 101,
      label: "agent-browser",
      session: "cx-one",
      at: "2026-07-09T00:00:00.000Z",
      expiresAt: "2026-07-09T00:30:00.000Z"
    })}\n`
  );

  assert.equal(
    findActiveProfilePilotNotice(["open", "https://example.test"], { HOME: home, AGENT_BROWSER_SESSION: "cx-one" }, Date.parse("2026-07-09T00:31:00.000Z")),
    null
  );

  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper automatically switches a second Session to the next available Profile", () => {
  const home = makeTempHome();
  writeAgentBrowserRuntimeProfilesSync([
    {
      profileId: "isolated:work",
      profileName: "工作 Profile",
      cdpPort: 9223,
      projectTag: "first-project"
    },
    {
      profileId: "isolated:alternative",
      profileName: "备用 Profile",
      cdpPort: 9224,
      projectTag: "second-project",
      running: false
    }
  ], home);
  acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9223,
    session: "cx-owner",
    holderPid: process.pid,
    profileId: "isolated:work",
    profileName: "工作 Profile",
    project: "first-project",
    command: "open"
  }, home);
  writeAgentBrowserSessionActivitySync({
    session: "cc-second",
    command: "connect",
    cdpPort: 9223,
    pid: process.pid,
    cwd: "/tmp/second-project"
  }, home);

  const resolution = acquireProfileLeaseForCommandWithAutomaticSwitch(["snapshot"], {
    HOME: home,
    PWD: "/tmp/second-project",
    AGENT_BROWSER_SESSION: "cc-second"
  });

  assert.equal(resolution.lease.ok, true);
  assert.equal(resolution.lease.context.cdpPort, 9224);
  assert.deepEqual(resolution.args, ["--cdp", "9224", "snapshot"]);
  assert.equal(resolution.automaticSwitch.from.cdpPort, 9223);
  assert.equal(resolution.automaticSwitch.to.cdpPort, 9224);
  assert.equal(resolution.automaticSwitch.to.running, false);
  assert.equal(readAgentBrowserProfileLeaseSync(9224, home).session, "cc-second");

  const output = formatAutomaticProfileSwitch(resolution.automaticSwitch, resolution.args);
  assert.match(output, /"event_code": "PROFILE_AUTO_SWITCHED"/);
  assert.match(output, /"hard_stop": false/);
  assert.match(output, /"requires_user_confirmation": false/);
  assert.match(output, /"from_cdp_port": 9223/);
  assert.match(output, /"cdp_port": 9224/);
  assert.match(output, /"profile_started_on_demand": true/);
  assert.match(output, /"command": "agent-browser --cdp 9224 snapshot"/);

  rmSync(home, { recursive: true, force: true });
});

test("automatic Profile switch reuses the Profile already owned by the current Session", () => {
  const home = makeTempHome();
  writeAgentBrowserRuntimeProfilesSync([
    {
      profileId: "isolated:blocked",
      profileName: "被占用 Profile",
      cdpPort: 9223
    },
    {
      profileId: "isolated:free",
      profileName: "空闲 Profile",
      cdpPort: 9224
    },
    {
      profileId: "isolated:current",
      profileName: "当前 Session Profile",
      cdpPort: 9225
    }
  ], home);
  acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9223,
    session: "cx-owner",
    holderPid: process.pid,
    profileId: "isolated:blocked",
    profileName: "被占用 Profile"
  }, home);
  acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9225,
    session: "cx-requester",
    holderPid: process.pid,
    profileId: "isolated:current",
    profileName: "当前 Session Profile"
  }, home);

  const resolution = acquireProfileLeaseForCommandWithAutomaticSwitch(
    ["--cdp", "9223", "snapshot"],
    { HOME: home, AGENT_BROWSER_SESSION: "cx-requester" }
  );

  assert.equal(resolution.lease.ok, true);
  assert.equal(resolution.lease.context.cdpPort, 9225);
  assert.deepEqual(resolution.args, ["--cdp", "9225", "snapshot"]);
  assert.equal(resolution.automaticSwitch.to.alreadyOwnedBySession, true);
  assert.equal(readAgentBrowserProfileLeaseSync(9224, home), null);

  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper hard-stops when no available alternative Profile exists", () => {
  const home = makeTempHome();
  const output = formatProfileLeaseConflict({
    version: 1,
    cdpPort: 9223,
    profileId: "isolated:work",
    profileName: "工作 Profile",
    session: "cx-owner",
    holderPid: process.pid,
    acquiredAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    expiresAt: "2026-07-10T00:30:00.000Z"
  }, "cc-second", ["snapshot"], { HOME: home });

  assert.match(output, /"hard_stop": true/);
  assert.match(output, /"retryable_with_alternative_profile": false/);
  assert.match(output, /"requires_user_confirmation": false/);
  assert.match(output, /"auto_switch_allowed": false/);
  assert.match(output, /"recommended_command": null/);

  rmSync(home, { recursive: true, force: true });
});

function fakeBifrostSource(callsPath, { portShowExit }) {
  return `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, args.join(" ") + "\\n");
if (args[0] === "status") {
  process.stdout.write('{"running":true,"version":"test","listener":{"port":9900},"ports":[]}\\n');
  process.exit(0);
}
if (args[0] === "port" && args[1] === "show") {
  if (${portShowExit} === 0) {
    process.stdout.write("Temporary port: 127.0.0.1:18889\\nName: profilepilot:profile-b\\n");
  }
  process.exit(${portShowExit});
}
process.exit(0);
`;
}

function makeTempHome() {
  return path.join(
    process.platform === "win32" ? os.tmpdir() : "/tmp",
    `pp-abw-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
  );
}

function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function captureProcessWrites() {
  const stdout = [];
  const stderr = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = (chunk, ...args) => {
    stdout.push(String(chunk));
    return originalStdoutWrite.call(process.stdout, chunk, ...args);
  };
  process.stderr.write = (chunk, ...args) => {
    stderr.push(String(chunk));
    return originalStderrWrite.call(process.stderr, chunk, ...args);
  };
  return {
    stdout,
    stderr,
    restore() {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
  };
}
