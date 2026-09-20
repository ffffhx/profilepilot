const assert = require("node:assert/strict");
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  PROFILEPILOT_AGENT_BROWSER_HARD_STOP_EXIT_CODE,
  ensureConfiguredGatewayProfileRunning,
  prepareGatewayTransport,
  runAgentBrowserWrapper
} = require("../dist/main/agent-browser-wrapper.js");
const { acquireAgentBrowserProfileLeaseSync, readAgentBrowserProfileLeaseSync } = require("../dist/main/agent-browser-lease.js");
const { browserGatewaySocketPath, ensureBrowserGatewayDaemon, requestBrowserGateway, subscribeBrowserGatewayEvents } = require("../dist/main/browser-gateway-client.js");
const {
  BrowserGatewayDaemon,
  DEFAULT_DRIVER_RECONNECT_GRACE_MS
} = require("../dist/main/browser-gateway-daemon.js");

test("Gateway gives a waiting Agent enough time to reconnect after user return", () => {
  assert.equal(DEFAULT_DRIVER_RECONNECT_GRACE_MS, 30_000);
});

test("Gateway client rejects unsafe Raw CDP before contacting a daemon during upgrade", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "pp-raw-policy-"));
  try {
    for (const method of ["Network.deleteCookies", "Network.deleteDeviceBoundSessions", "Page.crash", "Target.closeTarget", "DOM.unknownFutureMethod"]) {
      await assert.rejects(requestBrowserGateway({
        action: "raw-cdp", publicPort: 9223, sessionId: "test", daemonInstanceId: "test", method
      }, { homeDir: home }), (error) => error.code === "RAW_CDP_METHOD_DENIED");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Gateway stops an active Session and rejects future acquire when Agent access is disabled", async () => {
  // Keep the Unix socket path below macOS's sockaddr_un limit.
  const home = mkdtempSync(path.join(os.tmpdir(), "pp-gap-"));
  const fakeChrome = writeFakeChrome(home);
  const port = await freePort();
  const daemon = testGatewayDaemon(home);
  await daemon.start();
  try {
    await requestBrowserGateway({
      action: "launch-profile",
      profileId: "profile-private",
      profileName: "Private Profile",
      publicPort: port,
      executable: process.execPath,
      args: [fakeChrome],
      agentAccessDisabled: false
    }, { homeDir: home });
    await requestBrowserGateway({
      action: "acquire",
      publicPort: port,
      sessionId: "cx-policy",
      daemonInstanceId: "daemon-policy",
      driverKind: "chrome-devtools-mcp"
    }, { homeDir: home });

    const updated = await requestBrowserGateway({
      action: "update-profile-agent-settings",
      publicPort: port,
      profileId: "profile-private",
      profileName: "Private Profile",
      agentAccessDisabled: true
    }, { homeDir: home });
    assert.equal(updated.stoppedSessionId, "cx-policy");

    const status = await requestBrowserGateway({ action: "status" }, { homeDir: home });
    const managed = status.managedProfiles.find((profile) => profile.publicPort === port);
    const profile = status.state.profiles.find((candidate) => candidate.publicPort === port);
    assert.equal(managed.agentAccessDisabled, true);
    assert.equal(profile.sessionStatus, "stopped");
    await assert.rejects(() => requestBrowserGateway({
      action: "acquire",
      publicPort: port,
      sessionId: "cx-policy-next",
      daemonInstanceId: "daemon-policy-next"
    }, { homeDir: home }), (error) =>
      error.code === "PROFILE_AGENT_ACCESS_DISABLED" &&
      String(error.message).includes("Private Profile")
    );
  } finally {
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("gatewayd owns the Chrome pipe, control socket and public ticketed WebSocket end to end", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-gateway-daemon-"));
  const fakeChrome = writeFakeChrome(home);
  const unpackedExtension = writeUnpackedExtension(home);
  const chromeCallsPath = path.join(home, "fake-chrome-calls.ndjson");
  const port = await freePort();
  const daemon = testGatewayDaemon(home);
  await daemon.start();
  const controlEvents = [];
  const subscription = subscribeBrowserGatewayEvents({
    onEvent: (message) => controlEvents.push(message.controlEvent)
  }, { homeDir: home });
  try {
    await subscription.ready;
    const ping = await requestBrowserGateway({ action: "ping" }, { homeDir: home });
    assert.equal(ping.ok, true);
    const launched = await requestBrowserGateway({
      action: "launch-profile",
      profileId: "profile-a",
      profileName: "Profile A",
      publicPort: port,
      executable: process.execPath,
      args: [fakeChrome],
      env: { FAKE_CHROME_CALLS_PATH: chromeCallsPath }
    }, { homeDir: home });
    assert.equal(launched.ok, true);
    await waitFor(() => controlEvents.some((event) => event.reason === "register-profile"), "launch event delivered");

    const acquired = await requestBrowserGateway({
      action: "acquire",
      publicPort: port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one"
    }, { homeDir: home });
    assert.equal(acquired.connectionActive, false);
    const internalVersion = await fetch(`http://127.0.0.1:${port}/json/version`, {
      headers: { "x-profilepilot-internal": readFileSync(path.join(home, ".profilepilot", "gateway", "internal.secret"), "utf8").trim() }
    }).then((response) => response.json());
    const internalWs = await openWebSocket(internalVersion.webSocketDebuggerUrl);
    const ws = await openWebSocket(acquired.webSocketUrl);
    await waitFor(() => controlEvents.some((event) => event.reason === "agent-connected"), "connection event delivered");
    const connectedStatus = await requestBrowserGateway({ action: "status" }, { homeDir: home });
    assert.equal(connectedStatus.state.profiles.find((profile) => profile.publicPort === port).connectionActive, true);
    const response = nextMessage(ws);
    ws.send(JSON.stringify({ id: 9, method: "Browser.getVersion", params: {} }));
    assert.deepEqual(await response, { id: 9, result: { echoed: "Browser.getVersion" } });

    const active = await requestBrowserGateway({
      action: "acquire",
      publicPort: port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one"
    }, { homeDir: home });
    assert.equal(active.connectionActive, true);

    const raw = await requestBrowserGateway({
      action: "raw-cdp",
      publicPort: port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one",
      method: "Target.activateTarget",
      params: { targetId: "page-1" }
    }, { homeDir: home });
    assert.deepEqual(raw.result, {});
    assert.equal(
      readJsonLines(chromeCallsPath).some((message) => message.method === "Target.activateTarget"),
      false,
      "Agent Raw CDP activation must stay logical"
    );

    const revealed = await requestBrowserGateway({
      action: "activate-agent-target",
      publicPort: port
    }, { homeDir: home });
    assert.equal(revealed.target.targetId, "page-1");
    assert.equal(
      readJsonLines(chromeCallsPath).filter((message) => message.method === "Target.activateTarget").length,
      1,
      "ProfilePilot's trusted reveal path must still activate Chrome"
    );

    const loaded = await requestBrowserGateway({
      action: "load-unpacked-extension",
      publicPort: port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one",
      extensionPath: unpackedExtension
    }, { homeDir: home });
    assert.deepEqual(loaded.result, { echoed: "Extensions.loadUnpacked" });
    assert.equal(loaded.extension.path, realpathSync(unpackedExtension));
    assert.equal(loaded.extension.name, "Fixture Extension");

    const triggered = await requestBrowserGateway({
      action: "trigger-extension-action",
      publicPort: port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one",
      extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      targetId: "page-1"
    }, { homeDir: home });
    assert.deepEqual(triggered.result, {
      extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      targetId: "page-1",
      actionTargetId: "tab-1"
    });
    assert.equal(
      readJsonLines(chromeCallsPath).some((message) => message.method === "Extensions.triggerAction"),
      true
    );

    const emulated = await requestBrowserGateway({
      action: "device-emulation",
      publicPort: port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one",
      command: "emulate",
      preset: "iphone-16-pro"
    }, { homeDir: home });
    assert.equal(emulated.active, true);
    assert.deepEqual(
      {
        preset: emulated.deviceEmulation.preset,
        width: emulated.deviceEmulation.width,
        height: emulated.deviceEmulation.height,
        mobile: emulated.deviceEmulation.mobile,
        platform: emulated.deviceEmulation.platform
      },
      { preset: "iphone-16-pro", width: 402, height: 874, mobile: true, platform: "iPhone" }
    );
    assert.match(emulated.deviceEmulation.userAgent, /iPhone/);
    assert.equal(
      readJsonLines(chromeCallsPath).some(
        (message) => message.method === "Emulation.setDeviceMetricsOverride"
      ),
      true
    );

    let agentSocketClosed = false;
    ws.addEventListener("close", () => { agentSocketClosed = true; }, { once: true });
    await requestBrowserGateway({ action: "control", sessionId: "cx-one", command: "takeover" }, { homeDir: home });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(agentSocketClosed, false, "takeover must park the agent-browser socket in place");
    assert.equal(
      controlEvents.some((event) => event.reason === "agent-disconnected"),
      false,
      "parking must not start a reconnect cycle"
    );
    assert.equal(
      readJsonLines(chromeCallsPath).some(
        (message) => message.method === "Emulation.clearDeviceMetricsOverride"
      ),
      true,
      "takeover must clear the Agent-owned device viewport before user control"
    );
    assert.equal(
      readJsonLines(chromeCallsPath).some(
        (message) =>
          message.method === "Emulation.setUserAgentOverride" &&
          message.params?.userAgent === ""
      ),
      true,
      "takeover must clear the Agent-owned mobile UA before user control"
    );
    const internalResponse = nextMessage(internalWs);
    internalWs.send(JSON.stringify({ id: 10, method: "Browser.getVersion", params: {} }));
    assert.deepEqual(await internalResponse, { id: 10, result: { echoed: "Browser.getVersion" } });
    await assert.rejects(() => requestBrowserGateway({
      action: "raw-cdp",
      publicPort: port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one",
      method: "Runtime.evaluate",
      params: { expression: "1+1" }
    }, { homeDir: home }), (error) => error.code === "AGENT_USER_IN_CONTROL");
    internalWs.close();

    process.kill(Number(launched.chromePid), "SIGTERM");
    await waitFor(async () => {
      const current = await requestBrowserGateway({ action: "status" }, { homeDir: home });
      return !current.ports.includes(port) && !current.state.profiles.some((profile) => profile.publicPort === port);
    }, "crashed Chrome route cleanup");
    await assert.rejects(() => prepareGatewayTransport(
      "/does/not/matter",
      ["--cdp", String(port), "snapshot"],
      { ...process.env, HOME: home, AGENT_BROWSER_SESSION: "cx-after-crash" },
      port
    ), (error) => error.code === "GATEWAY_PROFILE_NOT_RUNNING");
    const relaunched = await requestBrowserGateway({
      action: "launch-profile",
      profileId: "profile-a",
      profileName: "Profile A",
      publicPort: port,
      executable: process.execPath,
      args: [fakeChrome]
    }, { homeDir: home });
    assert.equal(relaunched.ok, true);
    const reacquired = await requestBrowserGateway({
      action: "acquire",
      publicPort: port,
      sessionId: "cx-two",
      daemonInstanceId: "daemon-two"
    }, { homeDir: home });
    assert.equal(reacquired.profile.ownerSessionId, "cx-two");
  } finally {
    subscription.close();
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("Gateway takeover disconnects a driver whose CDP request never settles", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-gateway-stuck-takeover-"));
  const fakeChrome = writeFakeChrome(home);
  const chromeCallsPath = path.join(home, "fake-chrome-calls.ndjson");
  const port = await freePort();
  const daemon = testGatewayDaemon(home, { agentCommandQuiesceTimeoutMs: 60 });
  let ws;
  await daemon.start();
  try {
    await requestBrowserGateway({
      action: "launch-profile",
      profileId: "profile-stuck",
      profileName: "Profile Stuck",
      publicPort: port,
      executable: process.execPath,
      args: [fakeChrome],
      env: {
        FAKE_CHROME_CALLS_PATH: chromeCallsPath,
        FAKE_CHROME_HANG_METHOD: "Browser.getVersion"
      }
    }, { homeDir: home });
    const acquired = await requestBrowserGateway({
      action: "acquire",
      publicPort: port,
      sessionId: "cx-stuck",
      daemonInstanceId: "daemon-stuck",
      driverKind: "agent-browser"
    }, { homeDir: home });
    ws = await openWebSocket(acquired.webSocketUrl);
    const closed = new Promise((resolve) => ws.addEventListener("close", resolve, { once: true }));
    ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion", params: {} }));
    await waitFor(
      () => readJsonLines(chromeCallsPath).some((message) => message.method === "Browser.getVersion"),
      "stuck CDP request reaches Chrome"
    );

    const startedAt = Date.now();
    const takeover = await requestBrowserGateway({
      action: "control",
      sessionId: "cx-stuck",
      command: "takeover"
    }, { homeDir: home, timeoutMs: 1_000 });
    await closed;

    assert.equal(takeover.forcedAgentDisconnects, 1);
    assert.ok(Date.now() - startedAt >= 50, "takeover must first allow a graceful drain window");
    const status = await requestBrowserGateway({ action: "status" }, { homeDir: home });
    const profile = status.state.profiles.find((candidate) => candidate.publicPort === port);
    assert.equal(profile.ownership, "user");
    assert.equal(profile.sessionStatus, "active");
    assert.equal(profile.driverState, "parked");
    assert.equal(profile.connectionActive, false);
  } finally {
    ws?.close();
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("agent-browser wrapper transparently connects through a Gateway ticket and strips direct CDP", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-gateway-wrapper-"));
  const fakeChrome = writeFakeChrome(home);
  const unpackedExtension = writeUnpackedExtension(home);
  const chromeCallsPath = path.join(home, "fake-chrome-calls.ndjson");
  const fakeAgentBrowser = path.join(home, "fake-agent-browser.js");
  const callsPath = path.join(home, "agent-browser-calls.ndjson");
  const envCallsPath = path.join(home, "agent-browser-env.ndjson");
  const holderPidPath = path.join(home, "holder.pid");
  const readyPath = path.join(home, "holder.ready");
  writeFileSync(fakeAgentBrowser, `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(args) + "\\n");
fs.appendFileSync(process.env.ENV_CALLS_PATH, JSON.stringify({
  HTTP_PROXY: process.env.HTTP_PROXY || null,
  HTTPS_PROXY: process.env.HTTPS_PROXY || null,
  ALL_PROXY: process.env.ALL_PROXY || null,
  AGENT_BROWSER_PROXY: process.env.AGENT_BROWSER_PROXY || null,
  NO_PROXY: process.env.NO_PROXY || null
}) + "\\n");
const connectIndex = args.indexOf("connect");
if (connectIndex >= 0) {
  const url = args[connectIndex + 1];
  const code = \`const fs=require("node:fs");const ws=new WebSocket(\${JSON.stringify(url)});ws.addEventListener("open",()=>fs.writeFileSync(\${JSON.stringify(process.env.READY_PATH)},"ready"));ws.addEventListener("close",()=>process.exit(0));setInterval(()=>{},1000);\`;
  const child = spawn(process.execPath, ["-e", code], { detached: true, stdio: "ignore" });
  child.unref();
  fs.writeFileSync(process.env.HOLDER_PID_PATH, String(child.pid));
  fs.mkdirSync(require("node:path").join(process.env.HOME, ".agent-browser"), { recursive: true });
  fs.writeFileSync(require("node:path").join(process.env.HOME, ".agent-browser", process.env.AGENT_BROWSER_SESSION + ".pid"), String(child.pid));
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(process.env.READY_PATH) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 20);
  if (!fs.existsSync(process.env.READY_PATH)) process.exit(2);
}
`);
  chmodSync(fakeAgentBrowser, 0o755);
  const port = await freePort();
  const daemon = testGatewayDaemon(home);
  await daemon.start();
  try {
    await requestBrowserGateway({
      action: "launch-profile",
      profileId: "profile-a",
      profileName: "Profile A",
      publicPort: port,
      executable: process.execPath,
      args: [fakeChrome],
      env: { FAKE_CHROME_CALLS_PATH: chromeCallsPath }
    }, { homeDir: home });
    const env = {
      ...process.env,
      HOME: home,
      AGENT_BROWSER_SESSION: "cx-wrapper",
      CALLS_PATH: callsPath,
      ENV_CALLS_PATH: envCallsPath,
      HOLDER_PID_PATH: holderPidPath,
      READY_PATH: readyPath,
      HTTP_PROXY: "http://127.0.0.1:7897",
      HTTPS_PROXY: "http://127.0.0.1:7897",
      ALL_PROXY: "socks5://127.0.0.1:7897",
      AGENT_BROWSER_PROXY: "http://controller.test:8080",
      NO_PROXY: "127.0.0.1,localhost",
      PROFILEPILOT_AGENT_BROWSER_REAL: fakeAgentBrowser
    };
    const prepared = await prepareGatewayTransport(
      fakeAgentBrowser,
      ["--cdp", String(port), "snapshot", "--json"],
      env,
      port
    );
    assert.deepEqual(prepared, ["--session", "cx-wrapper", "snapshot", "--json"]);
    const calls = readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 1);
    assert.deepEqual(readJsonLines(envCallsPath), [{
      HTTP_PROXY: null,
      HTTPS_PROXY: null,
      ALL_PROXY: null,
      AGENT_BROWSER_PROXY: null,
      NO_PROXY: "127.0.0.1,localhost"
    }]);
    assert.deepEqual(calls[0].slice(0, 3), ["--session", "cx-wrapper", "connect"]);
    assert.match(calls[0][3], new RegExp(`^ws://127\\.0\\.0\\.1:${port}/devtools/browser/gateway\\?ticket=`));
    const status = await requestBrowserGateway({ action: "status" }, { homeDir: home });
    const profile = status.state.profiles.find((item) => item.publicPort === port);
    assert.equal(profile.ownerSessionId, "cx-wrapper");
    assert.equal(profile.ownership, "agent");
    assert.equal(profile.daemonPid, Number(readFileSync(holderPidPath, "utf8")));
    assert.deepEqual(profile.agentActivity, {
      generation: 0,
      lastCdpAt: null,
      lastCdpMethod: null
    });
    assert.equal(acquireAgentBrowserProfileLeaseSync({
      cdpPort: port,
      session: "cx-wrapper",
      holderPid: process.pid,
      daemonPid: profile.daemonPid,
      profileId: "profile-a",
      profileName: "Profile A",
      command: "snapshot"
    }, home).ok, true);
    assert.equal(await runAgentBrowserWrapper([
      "--cdp",
      String(port),
      "profilepilot",
      "extension",
      "load-unpacked",
      unpackedExtension
    ], env), 0);
    assert.equal(readAgentBrowserProfileLeaseSync(port, home).session, "cx-wrapper");
    await requestBrowserGateway({
      action: "raw-cdp",
      publicPort: port,
      sessionId: "cx-wrapper",
      daemonInstanceId: profile.daemonInstanceId,
      method: "Target.attachToTarget",
      params: { targetId: "page-1", flatten: true }
    }, { homeDir: home });
    const activationCountBeforeHandoff = readJsonLines(chromeCallsPath)
      .filter((message) => message.method === "Target.activateTarget").length;
    assert.equal(await runAgentBrowserWrapper([
      "profilepilot",
      "handoff",
      "--reason",
      "手动加载未打包扩展"
    ], env), 0);
    const handedOffStatus = await requestBrowserGateway({ action: "status" }, { homeDir: home });
    const handedOffProfile = handedOffStatus.state.profiles.find((item) => item.publicPort === port);
    assert.equal(handedOffProfile.ownerSessionId, "cx-wrapper");
    assert.equal(handedOffProfile.ownership, "user");
    assert.equal(handedOffProfile.sessionStatus, "active");
    assert.equal(handedOffProfile.pendingUserAction, "手动加载未打包扩展");
    assert.equal(readAgentBrowserProfileLeaseSync(port, home).delegatedToUser, true);
    assert.equal(
      readJsonLines(chromeCallsPath).filter((message) => message.method === "Target.activateTarget").length,
      activationCountBeforeHandoff + 1,
      "Agent-initiated handoff must reveal the logical target through the trusted path"
    );
    const repeatedHandoff = await requestBrowserGateway({
      action: "control",
      sessionId: "cx-wrapper",
      command: "takeover",
      pendingUserAction: "手动加载未打包扩展",
      revealAgentTarget: true
    }, { homeDir: home });
    assert.equal(repeatedHandoff.handoffTransitioned, false);
    assert.equal(repeatedHandoff.revealAttempted, false);
    assert.equal(repeatedHandoff.revealedTarget, null);
    assert.equal(repeatedHandoff.profileFocused, false);
    assert.equal(
      readJsonLines(chromeCallsPath).filter((message) => message.method === "Target.activateTarget").length,
      activationCountBeforeHandoff + 1,
      "repeating an already-user-owned handoff must not focus Chrome again"
    );
    const repeatedWrites = captureProcessWrites();
    try {
      assert.equal(await runAgentBrowserWrapper([
        "profilepilot",
        "handoff",
        "--reason",
        "手动加载未打包扩展"
      ], env), 0);
    } finally {
      repeatedWrites.restore();
    }
    const repeatedChunk = repeatedWrites.stdout.find((chunk) => (
      chunk.includes('"session": "cx-wrapper"') && chunk.includes('"action": "handoff"')
    ));
    assert.ok(repeatedChunk, "wrapper must emit the repeated handoff result");
    const repeatedOutput = JSON.parse(repeatedChunk);
    assert.equal(repeatedOutput.handoff_transitioned, false);
    assert.equal(repeatedOutput.reveal_attempted, false);
    assert.equal(repeatedOutput.reveal_confirmed, false);
    assert.equal(repeatedOutput.reveal_skipped, "already_user_owned");
    assert.doesNotMatch(repeatedOutput.message, /已带到台前/);

    assert.equal(
      await runAgentBrowserWrapper(["profilepilot", "complete"], env),
      75,
      "complete must not release a Session that is waiting for user action"
    );
    assert.equal(readAgentBrowserProfileLeaseSync(port, home).session, "cx-wrapper");
    assert.equal(await runAgentBrowserWrapper(["profilepilot", "resume"], env), 0);
    const resumedStatus = await requestBrowserGateway({ action: "status" }, { homeDir: home });
    const resumedProfile = resumedStatus.state.profiles.find((item) => item.publicPort === port);
    assert.equal(resumedProfile.ownership, "agent");
    assert.equal(resumedProfile.pendingUserAction, undefined);
    assert.equal(await runAgentBrowserWrapper(["profilepilot", "complete"], env), 0);
    await waitFor(() => !isPidAlive(Number(readFileSync(holderPidPath, "utf8"))), "holder exits after completion");
    const completedStatus = await requestBrowserGateway({ action: "status" }, { homeDir: home });
    const completedProfile = completedStatus.state.profiles.find((item) => item.publicPort === port);
    assert.equal(completedProfile.sessionStatus, "stopped");
    assert.equal(completedProfile.ownerSessionId, undefined);
    assert.equal(readAgentBrowserProfileLeaseSync(port, home), null);
  } finally {
    if (existsSync(holderPidPath)) {
      try { process.kill(Number(readFileSync(holderPidPath, "utf8")), "SIGKILL"); } catch {}
    }
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("managed wrapper uses the same isolated proxy env and fails closed when a command bypasses Gateway", async () => {
  for (const detached of [false, true]) {
    const home = mkdtempSync(path.join(os.tmpdir(), `profilepilot-gateway-activity-${detached ? "detached" : "connected"}-`));
    const fakeChrome = writeFakeChrome(home);
    const fakeAgentBrowser = writeGatewayAwareFakeAgentBrowser(home);
    const callsPath = path.join(home, "calls.ndjson");
    const envCallsPath = path.join(home, "env.ndjson");
    const holderPidPath = path.join(home, "holder.pid");
    const daemon = testGatewayDaemon(home);
    await daemon.start();
    const port = await freePort();
    const env = {
      ...process.env,
      HOME: home,
      AGENT_BROWSER_SESSION: `cx-activity-${detached ? "detached" : "connected"}`,
      PROFILEPILOT_AGENT_BROWSER_REAL: fakeAgentBrowser,
      CALLS_PATH: callsPath,
      ENV_CALLS_PATH: envCallsPath,
      HOLDER_PID_PATH: holderPidPath,
      READY_PATH: path.join(home, "ready"),
      TRIGGER_PATH: path.join(home, "trigger"),
      ACK_PATH: path.join(home, "ack"),
      HTTP_PROXY: "http://127.0.0.1:7897",
      HTTPS_PROXY: "http://127.0.0.1:7897",
      ALL_PROXY: "socks5://127.0.0.1:7897",
      AGENT_BROWSER_PROXY: "http://controller.test:8080",
      NO_PROXY: "127.0.0.1,localhost",
      ...(detached ? { FAKE_DETACHED: "1" } : {})
    };
    const writes = captureProcessWrites();
    try {
      await requestBrowserGateway({
        action: "launch-profile",
        profileId: `profile-activity-${detached}`,
        profileName: `Profile Activity ${detached}`,
        publicPort: port,
        executable: process.execPath,
        args: [fakeChrome]
      }, { homeDir: home });

      const exitCode = await runAgentBrowserWrapper([
        "--cdp",
        String(port),
        "snapshot"
      ], env);
      const childEnvs = readJsonLines(envCallsPath);
      assert.equal(childEnvs.length, 2, "connect and command must both use the wrapper environment");
      for (const childEnv of childEnvs) {
        assert.deepEqual(childEnv, {
          HTTP_PROXY: null,
          HTTPS_PROXY: null,
          ALL_PROXY: null,
          AGENT_BROWSER_PROXY: null,
          NO_PROXY: "127.0.0.1,localhost"
        });
      }

      const status = await requestBrowserGateway({ action: "status" }, { homeDir: home });
      const profile = status.state.profiles.find((item) => item.publicPort === port);
      if (detached) {
        assert.equal(exitCode, PROFILEPILOT_AGENT_BROWSER_HARD_STOP_EXIT_CODE);
        assert.match(writes.stderr.join(""), /AGENT_BROWSER_DETACHED_FROM_GATEWAY/);
        assert.equal(profile.sessionStatus, "stopped");
        assert.equal(profile.ownerSessionId, undefined);
      } else {
        assert.equal(exitCode, 0);
        assert.equal(profile.connectionActive, true);
        assert.ok(profile.agentActivity.generation > 0);
        assert.equal(profile.agentActivity.lastCdpMethod, "Browser.getVersion");
        assert.equal(await runAgentBrowserWrapper(["profilepilot", "complete"], env), 0);
      }
    } finally {
      writes.restore();
      if (existsSync(holderPidPath)) {
        try { process.kill(Number(readFileSync(holderPidPath, "utf8")), "SIGKILL"); } catch {}
      }
      await daemon.stop();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("unexpected driver disconnect reconnects within the grace window without releasing ownership", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-gateway-reconnect-success-"));
  const fakeChrome = writeFakeChrome(home);
  const port = await freePort();
  const daemon = testGatewayDaemon(home, { driverReconnectGraceMs: 250 });
  let firstWs;
  let secondWs;
  await daemon.start();
  try {
    await requestBrowserGateway({
      action: "launch-profile",
      profileId: "profile-reconnect",
      profileName: "Profile Reconnect",
      publicPort: port,
      executable: process.execPath,
      args: [fakeChrome]
    }, { homeDir: home });
    const acquired = await requestBrowserGateway({
      action: "acquire",
      publicPort: port,
      sessionId: "cx-reconnect-success",
      daemonInstanceId: "daemon-reconnect-success"
    }, { homeDir: home });
    firstWs = await openWebSocket(acquired.webSocketUrl);
    await waitFor(async () => {
      const current = await requestBrowserGateway({ action: "status" }, { homeDir: home });
      return current.state.profiles.find((profile) => profile.publicPort === port)?.driverState === "connected";
    }, "initial Gateway driver connection");

    firstWs.close();
    await waitFor(async () => {
      const current = await requestBrowserGateway({ action: "status" }, { homeDir: home });
      const profile = current.state.profiles.find((item) => item.publicPort === port);
      return profile?.ownership === "agent" && profile?.driverState === "reconnecting";
    }, "Gateway reconnecting state");

    const retry = await requestBrowserGateway({
      action: "acquire",
      publicPort: port,
      sessionId: "cx-reconnect-success",
      daemonInstanceId: "daemon-reconnect-success"
    }, { homeDir: home });
    secondWs = await openWebSocket(retry.webSocketUrl);
    await waitFor(async () => {
      const current = await requestBrowserGateway({ action: "status" }, { homeDir: home });
      const profile = current.state.profiles.find((item) => item.publicPort === port);
      return profile?.connectionActive === true && profile?.driverState === "connected";
    }, "Gateway driver reconnection");
    await new Promise((resolve) => setTimeout(resolve, 320));
    const finalStatus = await requestBrowserGateway({ action: "status" }, { homeDir: home });
    const profile = finalStatus.state.profiles.find((item) => item.publicPort === port);
    assert.equal(profile.ownerSessionId, "cx-reconnect-success");
    assert.equal(profile.sessionStatus, "active");
    assert.equal(profile.driverState, "connected");

    await requestBrowserGateway({
      action: "control",
      sessionId: "cx-reconnect-success",
      command: "takeover"
    }, { homeDir: home });
    await new Promise((resolve) => setTimeout(resolve, 320));
    const takenOverStatus = await requestBrowserGateway({ action: "status" }, { homeDir: home });
    const takenOver = takenOverStatus.state.profiles.find((item) => item.publicPort === port);
    assert.equal(takenOver.ownerSessionId, "cx-reconnect-success");
    assert.equal(takenOver.ownership, "user");
    assert.equal(takenOver.sessionStatus, "active");
    assert.equal(takenOver.driverState, "parked", "intentional takeover must not trigger reconnect release");
  } finally {
    firstWs?.close();
    secondWs?.close();
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("reconnect timeout releases the old Session and leaves a terminal Agent notice", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-gateway-reconnect-timeout-"));
  const fakeChrome = writeFakeChrome(home);
  const port = await freePort();
  const daemon = testGatewayDaemon(home, { driverReconnectGraceMs: 120 });
  let ws;
  await daemon.start();
  try {
    await requestBrowserGateway({
      action: "launch-profile",
      profileId: "profile-timeout",
      profileName: "Profile Timeout",
      publicPort: port,
      executable: process.execPath,
      args: [fakeChrome]
    }, { homeDir: home });
    const acquired = await requestBrowserGateway({
      action: "acquire",
      publicPort: port,
      sessionId: "cx-reconnect-timeout",
      daemonInstanceId: "daemon-reconnect-timeout",
      driverKind: "agent-browser"
    }, { homeDir: home });
    assert.equal(acquireAgentBrowserProfileLeaseSync({
      cdpPort: port,
      session: "cx-reconnect-timeout",
      holderPid: process.pid,
      profileId: "profile-timeout",
      profileName: "Profile Timeout",
      command: "snapshot"
    }, home).ok, true);
    ws = await openWebSocket(acquired.webSocketUrl);
    ws.close();

    await waitFor(async () => {
      const current = await requestBrowserGateway({ action: "status" }, { homeDir: home });
      const profile = current.state.profiles.find((item) => item.publicPort === port);
      return profile?.sessionStatus === "stopped" && !profile?.ownerSessionId;
    }, "Gateway releases reconnect timeout", 3_000);
    assert.equal(readAgentBrowserProfileLeaseSync(port, home), null);
    const notice = JSON.parse(readFileSync(
      path.join(home, ".profilepilot", "agent-control", "cx-reconnect-timeout.json"),
      "utf8"
    ));
    assert.equal(notice.code, "AGENT_DRIVER_RECONNECT_FAILED");
    assert.equal(notice.reason, "driver_reconnect_exhausted");
    assert.equal(notice.hardStop, true);
    assert.equal(notice.ownership, "user");

    const replacement = await requestBrowserGateway({
      action: "acquire",
      publicPort: port,
      sessionId: "cx-replacement",
      daemonInstanceId: "daemon-replacement"
    }, { homeDir: home });
    assert.equal(replacement.profile.ownerSessionId, "cx-replacement");
  } finally {
    ws?.close();
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("agent-browser wrapper retries Gateway transport at most three times and recovers", async () => {
  // Keep the Unix control socket below macOS' sockaddr_un path limit.
  const home = mkdtempSync(path.join(os.tmpdir(), "pp-gw-retry-"));
  const fakeChrome = writeFakeChrome(home);
  const fakeAgentBrowser = path.join(home, "retry-agent-browser.js");
  const callsPath = path.join(home, "retry-calls.ndjson");
  const holderPidPath = path.join(home, "retry-holder.pid");
  const readyPath = path.join(home, "retry-holder.ready");
  writeFileSync(fakeAgentBrowser, `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(args) + "\\n");
const attempts = fs.readFileSync(process.env.CALLS_PATH, "utf8").trim().split("\\n").length;
if (attempts < 3) process.exit(7);
const connectIndex = args.indexOf("connect");
const url = args[connectIndex + 1];
const code = \`const fs=require("node:fs");const ws=new WebSocket(\${JSON.stringify(url)});ws.addEventListener("open",()=>fs.writeFileSync(\${JSON.stringify(process.env.READY_PATH)},"ready"));ws.addEventListener("close",()=>process.exit(0));setInterval(()=>{},1000);\`;
const child = spawn(process.execPath, ["-e", code], { detached: true, stdio: "ignore" });
child.unref();
fs.writeFileSync(process.env.HOLDER_PID_PATH, String(child.pid));
fs.mkdirSync(require("node:path").join(process.env.HOME, ".agent-browser"), { recursive: true });
fs.writeFileSync(require("node:path").join(process.env.HOME, ".agent-browser", process.env.AGENT_BROWSER_SESSION + ".pid"), String(child.pid));
const wait = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 2000;
while (!fs.existsSync(process.env.READY_PATH) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 20);
process.exit(fs.existsSync(process.env.READY_PATH) ? 0 : 8);
`);
  chmodSync(fakeAgentBrowser, 0o755);
  const port = await freePort();
  const daemon = testGatewayDaemon(home, { driverReconnectGraceMs: 3_000 });
  await daemon.start();
  try {
    await requestBrowserGateway({
      action: "launch-profile",
      profileId: "profile-wrapper-retry",
      profileName: "Profile Wrapper Retry",
      publicPort: port,
      executable: process.execPath,
      args: [fakeChrome]
    }, { homeDir: home });
    const prepared = await prepareGatewayTransport(
      fakeAgentBrowser,
      ["--cdp", String(port), "snapshot"],
      {
        ...process.env,
        HOME: home,
        AGENT_BROWSER_SESSION: "cx-wrapper-retry",
        CALLS_PATH: callsPath,
        HOLDER_PID_PATH: holderPidPath,
        READY_PATH: readyPath
      },
      port,
      { quietConnect: true }
    );
    assert.deepEqual(prepared, ["--session", "cx-wrapper-retry", "snapshot"]);
    assert.equal(readFileSync(callsPath, "utf8").trim().split("\n").length, 3);
    const status = await requestBrowserGateway({ action: "status" }, { homeDir: home });
    const profile = status.state.profiles.find((item) => item.publicPort === port);
    assert.equal(profile.driverState, "connected");
    assert.equal(profile.ownerSessionId, "cx-wrapper-retry");
  } finally {
    if (existsSync(holderPidPath)) {
      try { process.kill(Number(readFileSync(holderPidPath, "utf8")), "SIGKILL"); } catch {}
    }
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("handoff reveal has one abortable deadline while takeover ownership remains committed", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "pp-gw-deadline-"));
  const fakeChrome = writeFakeChrome(home);
  const chromeCallsPath = path.join(home, "fake-chrome-calls.ndjson");
  const port = await freePort();
  let focusAborted = false;
  let focusStartedResolve;
  const focusStarted = new Promise((resolve) => { focusStartedResolve = resolve; });
  const daemon = new BrowserGatewayDaemon(home, {
    handoffRevealDeadlineMs: 80,
    focusProfileWindow: async (_pids, signal) => {
      focusStartedResolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          focusAborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    }
  });
  await daemon.start();
  try {
    await requestBrowserGateway({
      action: "launch-profile",
      profileId: "profile-deadline",
      profileName: "Profile Deadline",
      publicPort: port,
      executable: process.execPath,
      args: [fakeChrome],
      env: { FAKE_CHROME_CALLS_PATH: chromeCallsPath }
    }, { homeDir: home });
    await requestBrowserGateway({
      action: "acquire",
      publicPort: port,
      sessionId: "cx-handoff-deadline",
      daemonInstanceId: "daemon-handoff-deadline"
    }, { homeDir: home });
    await requestBrowserGateway({
      action: "raw-cdp",
      publicPort: port,
      sessionId: "cx-handoff-deadline",
      daemonInstanceId: "daemon-handoff-deadline",
      method: "Target.activateTarget",
      params: { targetId: "page-1" }
    }, { homeDir: home });

    const startedAt = Date.now();
    const handoff = requestBrowserGateway({
      action: "control",
      sessionId: "cx-handoff-deadline",
      command: "takeover",
      pendingUserAction: "完成登录",
      revealAgentTarget: true
    }, { homeDir: home, timeoutMs: 1_000 });
    await focusStarted;
    const result = await handoff;

    assert.equal(result.handoffTransitioned, true);
    assert.equal(result.revealAttempted, true);
    assert.ok(result.revealedTarget);
    assert.equal(result.profileFocused, false);
    assert.match(result.revealError, /超过 80ms 截止时间/);
    assert.equal(focusAborted, true, "deadline must abort the in-flight Profile focus operation");
    assert.ok(Date.now() - startedAt < 800, "daemon must answer before the wrapper-side timeout");
    const status = await requestBrowserGateway({ action: "status" }, { homeDir: home });
    const profile = status.state.profiles.find((item) => item.publicPort === port);
    assert.equal(profile.ownership, "user", "focus timeout must not roll back a committed takeover");
  } finally {
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("handoff reveal is serialized before the same Session can return to Agent control", async () => {
  // Keep the Unix control socket below macOS' sockaddr_un path limit.
  const home = mkdtempSync(path.join(os.tmpdir(), "pp-gw-race-"));
  const fakeChrome = writeFakeChrome(home);
  const chromeCallsPath = path.join(home, "fake-chrome-calls.ndjson");
  const port = await freePort();
  let announceFocusStarted;
  const focusStarted = new Promise((resolve) => {
    announceFocusStarted = resolve;
  });
  let releaseFocus;
  const focusGate = new Promise((resolve) => {
    releaseFocus = resolve;
  });
  const daemon = new BrowserGatewayDaemon(home, {
    focusProfileWindow: async () => {
      announceFocusStarted();
      await focusGate;
      return true;
    }
  });
  await daemon.start();
  try {
    await requestBrowserGateway({
      action: "launch-profile",
      profileId: "profile-race",
      profileName: "Profile Race",
      publicPort: port,
      executable: process.execPath,
      args: [fakeChrome],
      env: { FAKE_CHROME_CALLS_PATH: chromeCallsPath }
    }, { homeDir: home });
    await requestBrowserGateway({
      action: "acquire",
      publicPort: port,
      sessionId: "cx-handoff-race",
      daemonInstanceId: "daemon-handoff-race"
    }, { homeDir: home });
    await requestBrowserGateway({
      action: "raw-cdp",
      publicPort: port,
      sessionId: "cx-handoff-race",
      daemonInstanceId: "daemon-handoff-race",
      method: "Target.activateTarget",
      params: { targetId: "page-1" }
    }, { homeDir: home });

    const handoff = requestBrowserGateway({
      action: "control",
      sessionId: "cx-handoff-race",
      command: "takeover",
      pendingUserAction: "完成登录",
      revealAgentTarget: true
    }, { homeDir: home, timeoutMs: 8_000 });
    await focusStarted;
    let returnFinished = false;
    const returned = requestBrowserGateway({
      action: "control",
      sessionId: "cx-handoff-race",
      command: "return"
    }, { homeDir: home, timeoutMs: 8_000 }).then((value) => {
      returnFinished = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(returnFinished, false, "return must wait until the trusted handoff reveal finishes");
    releaseFocus();
    const [handoffResult, returnResult] = await Promise.all([handoff, returned]);
    assert.equal(handoffResult.profileFocused, true);
    assert.equal(returnResult.profile.ownership, "agent");
    assert.equal(
      readJsonLines(chromeCallsPath).filter((message) => message.method === "Target.activateTarget").length,
      1,
      "only the trusted handoff transition may activate the tab"
    );
  } finally {
    releaseFocus?.();
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("explicit Agent target reveal is serialized before the same Session can stop", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "pp-gw-show-race-"));
  const fakeChrome = writeFakeChrome(home);
  const chromeCallsPath = path.join(home, "fake-chrome-calls.ndjson");
  const port = await freePort();
  let announceFocusStarted;
  const focusStarted = new Promise((resolve) => { announceFocusStarted = resolve; });
  let releaseFocus;
  const focusGate = new Promise((resolve) => { releaseFocus = resolve; });
  const daemon = new BrowserGatewayDaemon(home, {
    focusProfileWindow: async () => {
      announceFocusStarted();
      await focusGate;
      return true;
    }
  });
  await daemon.start();
  try {
    await requestBrowserGateway({
      action: "launch-profile",
      profileId: "profile-show-race",
      profileName: "Profile Show Race",
      publicPort: port,
      executable: process.execPath,
      args: [fakeChrome],
      env: { FAKE_CHROME_CALLS_PATH: chromeCallsPath }
    }, { homeDir: home });
    await requestBrowserGateway({
      action: "acquire",
      publicPort: port,
      sessionId: "cx-show-race",
      daemonInstanceId: "daemon-show-race"
    }, { homeDir: home });
    await requestBrowserGateway({
      action: "raw-cdp",
      publicPort: port,
      sessionId: "cx-show-race",
      daemonInstanceId: "daemon-show-race",
      method: "Target.activateTarget",
      params: { targetId: "page-1" }
    }, { homeDir: home });

    const reveal = requestBrowserGateway({
      action: "activate-agent-target",
      publicPort: port
    }, { homeDir: home, timeoutMs: 8_000 });
    await focusStarted;
    let stopFinished = false;
    const stopped = requestBrowserGateway({
      action: "control",
      sessionId: "cx-show-race",
      command: "stop"
    }, { homeDir: home, timeoutMs: 8_000 }).then((value) => {
      stopFinished = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(stopFinished, false, "stop must wait until explicit Agent target reveal finishes");
    releaseFocus();
    const [revealResult, stopResult] = await Promise.all([reveal, stopped]);
    assert.equal(revealResult.profileFocused, true);
    assert.equal(stopResult.profile.sessionStatus, "stopped");
    assert.equal(
      readJsonLines(chromeCallsPath).filter((message) => message.method === "Target.activateTarget").length,
      1,
      "only the generation-bound trusted reveal may activate the tab"
    );
  } finally {
    releaseFocus?.();
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("agent-browser request auto-starts a configured Profile whose Gateway port is idle", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-gateway-auto-launch-"));
  const dataDir = path.join(home, "profilepilot-data");
  const fakeChrome = writeFakeChrome(home);
  const port = await freePort();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, "profiles.json"), `${JSON.stringify({
    profiles: [{
      id: "configured-profile",
      name: "按需启动 Profile",
      dirName: "configured-profile-data",
      createdAt: "2026-07-11T00:00:00.000Z",
      lastLaunchedAt: null,
      fixedCdpPort: port,
      lastCdpPort: port
    }]
  })}\n`);
  const daemon = testGatewayDaemon(home);
  await daemon.start();
  try {
    const initial = await requestBrowserGateway({ action: "status" }, { homeDir: home });
    assert.equal(initial.ports.includes(port), false);
    const status = await ensureConfiguredGatewayProfileRunning(port, initial, {
      ...process.env,
      HOME: home,
      CPM_DATA_DIR: dataDir,
      CHROME_BINARY: fakeChrome
    }, home);
    assert.equal(status.ports.includes(port), true);
    assert.equal(status.managedPorts.includes(port), true);
    assert.equal(status.state.profiles.find((profile) => profile.publicPort === port).profileName, "按需启动 Profile");
    assert.equal(existsSync(path.join(dataDir, "profiles", "configured-profile-data")), true);
    const denied = await fetch(`http://127.0.0.1:${port}/json/version`);
    assert.equal(denied.status, 401);
  } finally {
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a Session bound to one Profile cannot auto-start a second configured Profile", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-gateway-single-profile-"));
  const dataDir = path.join(home, "profilepilot-data");
  const fakeChrome = writeFakeChrome(home);
  const [firstPort, secondPort] = await Promise.all([freePort(), freePort()]);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, "profiles.json"), `${JSON.stringify({
    profiles: [
      {
        id: "first-profile",
        name: "第一个 Profile",
        dirName: "first-profile-data",
        createdAt: "2026-07-11T00:00:00.000Z",
        lastLaunchedAt: null,
        fixedCdpPort: firstPort,
        lastCdpPort: firstPort
      },
      {
        id: "second-profile",
        name: "第二个 Profile",
        dirName: "second-profile-data",
        createdAt: "2026-07-11T00:00:00.000Z",
        lastLaunchedAt: null,
        fixedCdpPort: secondPort,
        lastCdpPort: secondPort
      }
    ]
  })}\n`);
  const daemon = testGatewayDaemon(home);
  await daemon.start();
  try {
    const initial = await requestBrowserGateway({ action: "status" }, { homeDir: home });
    await ensureConfiguredGatewayProfileRunning(firstPort, initial, {
      ...process.env,
      HOME: home,
      CPM_DATA_DIR: dataDir,
      CHROME_BINARY: fakeChrome
    }, home);
    await requestBrowserGateway({
      action: "acquire",
      publicPort: firstPort,
      sessionId: "cx-single-profile",
      daemonInstanceId: "daemon-single-profile"
    }, { homeDir: home });

    await assert.rejects(
      () => prepareGatewayTransport(
        "/does/not/matter",
        ["--cdp", String(secondPort), "snapshot"],
        {
          ...process.env,
          HOME: home,
          CPM_DATA_DIR: dataDir,
          CHROME_BINARY: fakeChrome,
          AGENT_BROWSER_SESSION: "cx-single-profile"
        },
        secondPort
      ),
      (error) => error.code === "SESSION_ALREADY_BOUND" && String(error.message).includes(String(firstPort))
    );
    const finalStatus = await requestBrowserGateway({ action: "status" }, { homeDir: home });
    assert.equal(finalStatus.ports.includes(secondPort), false, "rejected Profile must not be auto-started");
  } finally {
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("agent-browser request reports a clear error when an idle port has no configured Profile", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-gateway-missing-profile-"));
  const dataDir = path.join(home, "profilepilot-data");
  const port = await freePort();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, "profiles.json"), `${JSON.stringify({ profiles: [] })}\n`);
  const daemon = testGatewayDaemon(home);
  await daemon.start();
  try {
    const initial = await requestBrowserGateway({ action: "status" }, { homeDir: home });
    await assert.rejects(
      () => ensureConfiguredGatewayProfileRunning(port, initial, {
        ...process.env,
        HOME: home,
        CPM_DATA_DIR: dataDir
      }, home),
      (error) => error.code === "GATEWAY_PROFILE_NOT_CONFIGURED" && String(error.message).includes(String(port))
    );
  } finally {
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("Gateway protects every registered port instead of special-casing 9223", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-gateway-multi-port-"));
  const fakeChrome = writeFakeChrome(home);
  const ports = await Promise.all([freePort(), freePort(), freePort()]);
  const daemon = testGatewayDaemon(home);
  await daemon.start();
  try {
    let firstWebSocketUrl = "";
    for (const [index, publicPort] of ports.entries()) {
      await requestBrowserGateway({
        action: "launch-profile",
        profileId: `profile-${index}`,
        profileName: `Profile ${index}`,
        publicPort,
        executable: process.execPath,
        args: [fakeChrome]
      }, { homeDir: home });
    }

    const status = await requestBrowserGateway({ action: "status" }, { homeDir: home });
    assert.deepEqual(status.ports, [...ports].sort((a, b) => a - b));
    assert.deepEqual(status.managedPorts, [...ports].sort((a, b) => a - b));

    for (const [index, publicPort] of ports.entries()) {
      const denied = await fetch(`http://127.0.0.1:${publicPort}/json/version`);
      assert.equal(denied.status, 401, `port ${publicPort} must reject direct CDP discovery`);
      const acquired = await requestBrowserGateway({
        action: "acquire",
        publicPort,
        sessionId: `cx-port-${index}`,
        daemonInstanceId: `daemon-port-${index}`,
        daemonPid: 9000 + index
      }, { homeDir: home });
      assert.match(acquired.webSocketUrl, new RegExp(`127\\.0\\.0\\.1:${publicPort}`));
      if (index === 0) firstWebSocketUrl = acquired.webSocketUrl;
    }

    const ws = await openWebSocket(firstWebSocketUrl);
    ws.close();
    await waitFor(async () => {
      const current = await requestBrowserGateway({ action: "status" }, { homeDir: home });
      return current.state.profiles.find((profile) => profile.publicPort === ports[0])?.agentHealth === "offline";
    }, "Gateway marks a disconnected Agent offline");
  } finally {
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("parallel Gateway ensure calls converge on exactly one daemon", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-gateway-ensure-"));
  const daemonScriptPath = path.join(__dirname, "..", "dist", "main", "browser-gateway-daemon.js");
  try {
    const results = await Promise.all(Array.from({ length: 6 }, () => ensureBrowserGatewayDaemon({
      homeDir: home,
      runtimePath: process.execPath,
      daemonScriptPath,
      timeoutMs: 5_000
    })));
    const pids = new Set(results.map((result) => result.pid));
    assert.equal(pids.size, 1);
    const status = await requestBrowserGateway({ action: "status" }, { homeDir: home });
    assert.equal(status.pid, results[0].pid);
    await requestBrowserGateway({ action: "shutdown" }, { homeDir: home });
    await waitFor(() => !isPidAlive(Number(results[0].pid)), "gateway daemon shutdown", 5_000);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ensure waits out a shutting-down daemon and returns a fresh process", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-gateway-restart-"));
  const daemonScriptPath = path.join(__dirname, "..", "dist", "main", "browser-gateway-daemon.js");
  try {
    const first = await ensureBrowserGatewayDaemon({
      homeDir: home,
      runtimePath: process.execPath,
      daemonScriptPath,
      timeoutMs: 5_000
    });
    await requestBrowserGateway({ action: "shutdown" }, { homeDir: home });
    const second = await ensureBrowserGatewayDaemon({
      homeDir: home,
      runtimePath: process.execPath,
      daemonScriptPath,
      timeoutMs: 5_000
    });
    assert.notEqual(second.pid, first.pid);
    assert.equal(second.shuttingDown, false);
    await requestBrowserGateway({ action: "shutdown" }, { homeDir: home });
    await waitFor(() => !isPidAlive(Number(second.pid)), "replacement gateway shutdown", 5_000);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ensure defers a protocol upgrade while the old Gateway still owns live Chrome pipes", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-gateway-deferred-upgrade-"));
  const gatewayRoot = path.join(home, ".profilepilot", "gateway");
  const socketPath = browserGatewaySocketPath(home);
  mkdirSync(gatewayRoot, { recursive: true });
  let shutdownRequested = false;
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const boundary = buffer.indexOf("\n");
      if (boundary < 0) return;
      const request = JSON.parse(buffer.slice(0, boundary));
      if (request.action === "shutdown") shutdownRequested = true;
      socket.end(`${JSON.stringify({
        ok: true,
        pid: process.pid,
        shuttingDown: false,
        ports: [9223],
        managedPorts: [9223]
      })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    const status = await ensureBrowserGatewayDaemon({ homeDir: home, timeoutMs: 1_000 });
    assert.equal(status.protocolUpgradeDeferred, true);
    assert.equal(shutdownRequested, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});

function testGatewayDaemon(home, options = {}) {
  return new BrowserGatewayDaemon(home, {
    focusProfileWindow: async () => true,
    ...options
  });
}

function writeGatewayAwareFakeAgentBrowser(home) {
  const fakeAgentBrowser = path.join(home, "gateway-aware-agent-browser.js");
  writeFileSync(fakeAgentBrowser, `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--gateway-holder") {
  const ws = new WebSocket(args[1]);
  let sent = false;
  ws.addEventListener("open", () => fs.writeFileSync(process.env.READY_PATH, "ready"));
  ws.addEventListener("message", () => fs.writeFileSync(process.env.ACK_PATH, "ack"));
  ws.addEventListener("close", () => process.exit(0));
  setInterval(() => {
    if (!sent && fs.existsSync(process.env.TRIGGER_PATH)) {
      sent = true;
      ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion", params: {} }));
    }
  }, 10);
} else {
  fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(args) + "\\n");
  fs.appendFileSync(process.env.ENV_CALLS_PATH, JSON.stringify({
    HTTP_PROXY: process.env.HTTP_PROXY || null,
    HTTPS_PROXY: process.env.HTTPS_PROXY || null,
    ALL_PROXY: process.env.ALL_PROXY || null,
    AGENT_BROWSER_PROXY: process.env.AGENT_BROWSER_PROXY || null,
    NO_PROXY: process.env.NO_PROXY || null
  }) + "\\n");
  const connectIndex = args.indexOf("connect");
  if (connectIndex >= 0) {
    const child = spawn(process.execPath, [process.argv[1], "--gateway-holder", args[connectIndex + 1]], {
      detached: true,
      stdio: "ignore",
      env: process.env
    });
    child.unref();
    fs.writeFileSync(process.env.HOLDER_PID_PATH, String(child.pid));
    fs.mkdirSync(require("node:path").join(process.env.HOME, ".agent-browser"), { recursive: true });
    fs.writeFileSync(require("node:path").join(process.env.HOME, ".agent-browser", process.env.AGENT_BROWSER_SESSION + ".pid"), String(child.pid));
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(process.env.READY_PATH) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 20);
    if (!fs.existsSync(process.env.READY_PATH)) process.exit(2);
  } else if (process.env.FAKE_DETACHED !== "1") {
    fs.writeFileSync(process.env.TRIGGER_PATH, "send");
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(process.env.ACK_PATH) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 20);
    if (!fs.existsSync(process.env.ACK_PATH)) process.exit(3);
  }
}
`);
  chmodSync(fakeAgentBrowser, 0o755);
  return fakeAgentBrowser;
}

function writeFakeChrome(home) {
  const fakeChrome = path.join(home, "fake-pipe-chrome.js");
  writeFileSync(fakeChrome, `#!${process.execPath}
const fs = require("node:fs");
const input = fs.createReadStream(null, { fd: 3 });
const output = fs.createWriteStream(null, { fd: 4 });
let pending = Buffer.alloc(0);
input.on("data", (chunk) => {
  pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
  while (true) {
    const boundary = pending.indexOf(0);
    if (boundary < 0) break;
    const frame = pending.subarray(0, boundary);
    pending = pending.subarray(boundary + 1);
    if (!frame.length) continue;
    const message = JSON.parse(frame.toString("utf8"));
    if (process.env.FAKE_CHROME_CALLS_PATH) {
      fs.appendFileSync(process.env.FAKE_CHROME_CALLS_PATH, JSON.stringify(message) + "\\n");
    }
    if (message.method === process.env.FAKE_CHROME_HANG_METHOD) continue;
    const result = message.method === "Target.getTargets"
      ? message.params?.filter
        ? {
            targetInfos: [{
              targetId: "tab-1",
              type: "tab",
              title: "Fixture",
              url: "https://example.test/",
              browserContextId: "context-1",
              embedderData: { tabActive: true }
            }]
          }
        : {
            targetInfos: [{
              targetId: "page-1",
              type: "page",
              title: "Fixture",
              url: "https://example.test/",
              browserContextId: "context-1"
            }]
          }
      : message.method === "Extensions.getExtensions"
        ? { extensions: [{ id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", enabled: true }] }
      : message.method === "Target.attachToTarget"
        ? { sessionId: "fake-flat-page-1" }
      : { echoed: message.method };
    output.write(JSON.stringify({ id: message.id, result }) + "\\0");
  }
});
`);
  chmodSync(fakeChrome, 0o755);
  return fakeChrome;
}

function readJsonLines(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function writeUnpackedExtension(home) {
  const extensionPath = path.join(home, "fixture-extension");
  mkdirSync(extensionPath, { recursive: true });
  writeFileSync(path.join(extensionPath, "manifest.json"), `${JSON.stringify({
    manifest_version: 3,
    name: "Fixture Extension",
    version: "1.0.0"
  })}\n`);
  return extensionPath;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function openWebSocket(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return ws;
}

async function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.addEventListener("message", (event) => {
      try {
        resolve(JSON.parse(String(event.data)));
      } catch (error) {
        reject(error);
      }
    }, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
}

async function waitFor(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function isPidAlive(pid) {
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
  process.stdout.write = (chunk) => {
    stdout.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
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

test("agent-browser wrapper rejects a failed connect even when the Gateway socket is live", async () => {
  // Keep the Unix control socket below macOS' sockaddr_un path limit.
  const home = mkdtempSync(path.join(os.tmpdir(), "pp-gw-retry-"));
  const fakeChrome = writeFakeChrome(home);
  const fakeAgentBrowser = path.join(home, "retry-agent-browser.js");
  const callsPath = path.join(home, "retry-calls.ndjson");
  const holderPidPath = path.join(home, "retry-holder.pid");
  const readyPath = path.join(home, "retry-holder.ready");
  writeFileSync(fakeAgentBrowser, `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(args) + "\\n");
const attempts = fs.readFileSync(process.env.CALLS_PATH, "utf8").trim().split("\\n").length;

const connectIndex = args.indexOf("connect");
const url = args[connectIndex + 1];
const code = \`const fs=require("node:fs");const ws=new WebSocket(\${JSON.stringify(url)});ws.addEventListener("open",()=>fs.writeFileSync(\${JSON.stringify(process.env.READY_PATH)},"ready"));ws.addEventListener("close",()=>process.exit(0));setInterval(()=>{},1000);\`;
const child = spawn(process.execPath, ["-e", code], { detached: true, stdio: "ignore" });
child.unref();
fs.writeFileSync(process.env.HOLDER_PID_PATH, String(child.pid));
fs.mkdirSync(require("node:path").join(process.env.HOME, ".agent-browser"), { recursive: true });
fs.writeFileSync(require("node:path").join(process.env.HOME, ".agent-browser", process.env.AGENT_BROWSER_SESSION + ".pid"), String(child.pid));
const wait = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 2000;
while (!fs.existsSync(process.env.READY_PATH) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 20);
console.error("tab is not responding and did not recover after activation");
process.exit(1);
`);
  chmodSync(fakeAgentBrowser, 0o755);
  const port = await freePort();
  const daemon = testGatewayDaemon(home, { driverReconnectGraceMs: 3_000 });
  await daemon.start();
  try {
    await requestBrowserGateway({
      action: "launch-profile",
      profileId: "profile-wrapper-retry",
      profileName: "Profile Wrapper Retry",
      publicPort: port,
      executable: process.execPath,
      args: [fakeChrome]
    }, { homeDir: home });
    await assert.rejects(() => prepareGatewayTransport(
      fakeAgentBrowser,
      ["--cdp", String(port), "snapshot"],
      {
        ...process.env,
        HOME: home,
        AGENT_BROWSER_SESSION: "cx-wrapper-retry",
        CALLS_PATH: callsPath,
        HOLDER_PID_PATH: holderPidPath,
        READY_PATH: readyPath
      },
      port,
      { quietConnect: true }
    ), (error) => error.code === "AGENT_TARGET_UNRESPONSIVE");
    assert.equal(readFileSync(callsPath, "utf8").trim().split("\n").length, 1);
    const status = await requestBrowserGateway({ action: "status" }, { homeDir: home });
    const profile = status.state.profiles.find((item) => item.publicPort === port);
    assert.equal(profile.connectionActive, false);
    assert.notEqual(profile.ownership, "agent");
  } finally {
    if (existsSync(holderPidPath)) {
      try { process.kill(Number(readFileSync(holderPidPath, "utf8")), "SIGKILL"); } catch {}
    }
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
