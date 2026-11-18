import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { buildSync } = require("esbuild");
const Module = require("node:module");

const tsCache = new Map();
function loadCli(relPath) {
  const source = path.resolve(import.meta.dirname, "..", relPath);
  if (tsCache.has(source)) return tsCache.get(source);
  const result = buildSync({
    entryPoints: [source],
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    write: false,
    logLevel: "silent"
  });
  const mod = new Module(source);
  mod.filename = source;
  mod.paths = Module._nodeModulePaths(path.dirname(source));
  mod._compile(result.outputFiles[0].text, source);
  tsCache.set(source, mod.exports);
  return mod.exports;
}

const gatewayTempDir = process.platform === "darwin" ? "/tmp" : os.tmpdir();

const {
  browserGatewayControlTokenPath,
  browserGatewaySocketPath,
  requestBrowserGateway,
  subscribeBrowserGatewayEvents
} = loadCli("src/main/browser-gateway-client.ts");
const {
  isLoopbackHostHeader,
  timingSafeSecretEqual
} = loadCli("src/main/browser-gateway-policy.ts");
const {
  BrowserGatewayControlPlane
} = loadCli("src/main/browser-gateway-control.ts");
const {
  BrowserGatewayServer
} = loadCli("src/main/browser-gateway-server.ts");
const {
  BrowserGatewayDaemon,
  validateBrowserLaunchExecutable
} = loadCli("src/main/browser-gateway-daemon.ts");
const {
  driverProcessSnapshot,
  isRecordedPidAlive
} = loadCli("src/main/agent-browser-process-cleanup.ts");
const {
  acquireAgentBrowserProfileLeaseSync,
  readAgentBrowserProfileLeaseSync,
  releaseAgentBrowserProfileLeaseSync
} = loadCli("src/main/agent-browser-lease.ts");
const {
  acquireProfileLeaseForCommandWithAutomaticSwitch
} = loadCli("src/main/agent-browser-wrapper.ts");
const {
  BrowserDebugSession
} = loadCli("src/main/browser-debug/session.ts");
const {
  browserRouteCommands,
  commandSchema,
  getCommandSchema
} = loadCli("src/shared/browser-command-contract.ts");
const {
  EngineReferences,
  computeSnapshotDelta,
  filterInteractiveSnapshot
} = loadCli("src/main/browser-engine/snapshot.ts");
const {
  BrowserEngine
} = loadCli("src/main/browser-engine/engine.ts");
const {
  agentOverlayBootstrapScript
} = loadCli("src/main/overlay-script.ts");
const {
  AgentOverlayManager,
  matchesOverlayWindowBounds,
  matchesViewportScreenGeometry,
  resolveOverlayGuardClientPoint
} = loadCli("src/main/agent-overlay.ts");
const {
  listSiteAdapters,
  loadExternalSiteAdapterConfigs,
  planSiteAdapter
} = loadCli("src/main/site-adapters/catalog.ts");
const {
  readSitePage
} = loadCli("src/main/site-adapters/page.ts");
const {
  runGatewaySiteCli
} = loadCli("src/main/site-adapters/gateway-cli.ts");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function sendRawControlLine(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx >= 0) {
        socket.destroy();
        resolve(JSON.parse(buffer.slice(0, idx)));
      }
    });
  });
}

function createMockBackendTransport(handler) {
  const listeners = { message: new Set(), close: new Set() };
  const sent = [];
  const emitPayload = (payload) => {
    const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
    for (const fn of listeners.message) {
      fn(serialized);
    }
  };
  return {
    sent,
    emitEvent(method, params = {}, sessionId) {
      emitPayload({ method, params, ...(sessionId ? { sessionId } : {}) });
    },
    transport: {
      isOpen: () => true,
      sendText(raw) {
        this.send(raw);
      },
      send(raw) {
        const frame = typeof raw === "string" ? JSON.parse(raw) : raw;
        sent.push(frame);
        queueMicrotask(async () => {
          try {
            const result = await handler(frame);
            emitPayload({
              id: frame.id,
              result: result ?? {},
              ...(frame.sessionId ? { sessionId: frame.sessionId } : {})
            });
          } catch (error) {
            emitPayload({
              id: frame.id,
              error: { code: -32000, message: error.message || String(error) },
              ...(frame.sessionId ? { sessionId: frame.sessionId } : {})
            });
          }
        });
      },
      close() {
        for (const fn of listeners.close) fn();
      },
      onMessage(fn) {
        listeners.message.add(fn);
        return () => listeners.message.delete(fn);
      },
      onClose(fn) {
        listeners.close.add(fn);
        return () => listeners.close.delete(fn);
      }
    }
  };
}

function openRawUpgrade(port, pathName, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      const lines = [
        `GET ${pathName} HTTP/1.1`,
        `Host: ${headers.Host || `127.0.0.1:${port}`}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13"
      ];
      if (headers.Origin) {
        lines.push(`Origin: ${headers.Origin}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    socket.setEncoding("utf8");
    let head = "";
    socket.on("data", (chunk) => {
      head += chunk;
      if (head.includes("\r\n\r\n")) {
        const statusLine = head.split("\r\n")[0];
        socket.destroy();
        resolve(statusLine);
      }
    });
    socket.once("error", reject);
  });
}

// ============================================================================
// 1. P0 Security: Control Socket Auth, Launch Executable Validation, Origin/Host
// ============================================================================

test("BrowserGatewayDaemon enforces 256-bit control.token on requests and subscribe", async () => {
  const home = mkdtempSync(path.join(gatewayTempDir, "pp-sec-auth-"));
  const daemon = new BrowserGatewayDaemon(home, { allowTestBrowserExecutable: false });
  await daemon.start();
  try {
    const tokenPath = browserGatewayControlTokenPath(home);
    assert.equal(existsSync(tokenPath), true);
    const token = readFileSync(tokenPath, "utf8").trim();
    assert.ok(Buffer.from(token, "base64url").length >= 32, "control.token must hold >=256 bits");
    if (process.platform !== "win32") {
      assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
    }

    const socketPath = browserGatewaySocketPath(home);
    const missingAuth = await sendRawControlLine(socketPath, { action: "status" });
    assert.equal(missingAuth.ok, false);
    assert.equal(missingAuth.error_code, "GATEWAY_UNAUTHORIZED");

    const wrongAuth = await sendRawControlLine(socketPath, {
      action: "status",
      authToken: "wrong-token-value"
    });
    assert.equal(wrongAuth.ok, false);
    assert.equal(wrongAuth.error_code, "GATEWAY_UNAUTHORIZED");

    const unauthSubscribe = await sendRawControlLine(socketPath, { action: "subscribe" });
    assert.equal(unauthSubscribe.ok, false);
    assert.equal(unauthSubscribe.error_code, "GATEWAY_UNAUTHORIZED");

    const authedStatus = await requestBrowserGateway({ action: "status" }, { homeDir: home });
    assert.equal(authedStatus.ok, true);

    const sub = subscribeBrowserGatewayEvents({
      homeDir: home,
      onEvent: () => {}
    });
    await sub.ready;
    sub.close();
  } finally {
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("validateBrowserLaunchExecutable and launch-profile reject shells, relative paths, and missing binaries", async () => {
  const home = mkdtempSync(path.join(gatewayTempDir, "pp-sec-exec-"));
  const fakeChromeBin = path.join(
    home,
    process.platform === "win32" ? "chrome.exe" : "google-chrome"
  );
  writeFileSync(fakeChromeBin, "binary");
  chmodSync(fakeChromeBin, 0o755);

  const prevEnv = process.env.PROFILEPILOT_ALLOW_TEST_BROWSER_EXECUTABLE;
  delete process.env.PROFILEPILOT_ALLOW_TEST_BROWSER_EXECUTABLE;
  try {
    // Reject relative paths
    for (const rel of ["chrome", "./chrome.exe", "../chrome", "\\Windows\\chrome.exe"]) {
      assert.throws(() => validateBrowserLaunchExecutable(rel, { platform: "win32", checkFilesystem: false }));
    }
    // Reject shell & script interpreters
    for (const bad of [
      "C:\\Windows\\System32\\cmd.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "C:\\Windows\\System32\\wscript.exe",
      "C:\\Windows\\System32\\cscript.exe",
      "C:\\Windows\\System32\\mshta.exe",
      "C:\\temp\\run.bat",
      "C:\\temp\\run.ps1"
    ]) {
      assert.throws(() => validateBrowserLaunchExecutable(bad, { platform: "win32", checkFilesystem: false }));
    }
    for (const badPosix of ["/bin/sh", "/bin/bash", "/usr/bin/zsh", "/usr/bin/python3", "/tmp/evil.sh"]) {
      assert.throws(() => validateBrowserLaunchExecutable(badPosix, { platform: "linux", checkFilesystem: false }));
    }
    // Reject non-existent binary
    assert.throws(() => validateBrowserLaunchExecutable(path.join(home, "missing-chrome.exe")));
    // Reject node/process.execPath unless explicit test option is enabled
    assert.throws(() => validateBrowserLaunchExecutable(process.execPath));
    assert.equal(
      validateBrowserLaunchExecutable(process.execPath, { allowTestExecutable: true }),
      process.execPath
    );
    // Allow valid browser executable on disk
    assert.equal(validateBrowserLaunchExecutable(fakeChromeBin), fakeChromeBin);

    // Verify daemon launch-profile rejects shells before spawn
    const daemon = new BrowserGatewayDaemon(home, { allowTestBrowserExecutable: false });
    await daemon.start();
    try {
      const port = await freePort();
      await assert.rejects(
        () =>
          requestBrowserGateway(
            {
              action: "launch-profile",
              profileId: "p-bad",
              profileName: "Bad",
              publicPort: port,
              executable: process.platform === "win32" ? "C:\\Windows\\System32\\cmd.exe" : "/bin/sh",
              args: []
            },
            { homeDir: home }
          ),
        (err) => err.code === "GATEWAY_INVALID_EXECUTABLE"
      );
    } finally {
      await daemon.stop();
    }
  } finally {
    if (prevEnv !== undefined) process.env.PROFILEPILOT_ALLOW_TEST_BROWSER_EXECUTABLE = prevEnv;
    rmSync(home, { recursive: true, force: true });
  }
});

test("BrowserGatewayServer and EngineDaemon enforce loopback Host, reject Origin, and use timing-safe secrets", async () => {
  assert.equal(timingSafeSecretEqual("secret-123", "secret-123"), true);
  assert.equal(timingSafeSecretEqual("secret-123", "secret-124"), false);
  assert.equal(timingSafeSecretEqual("short", "much-longer-secret"), false);
  assert.equal(timingSafeSecretEqual(undefined, "secret"), false);

  assert.equal(isLoopbackHostHeader("127.0.0.1:9222"), true);
  assert.equal(isLoopbackHostHeader("localhost:9222"), true);
  assert.equal(isLoopbackHostHeader("[::1]:9222"), true);
  assert.equal(isLoopbackHostHeader("evil.example:9222"), false);
  assert.equal(isLoopbackHostHeader(""), false);

  const home = mkdtempSync(path.join(gatewayTempDir, "pp-sec-http-"));
  const port = await freePort();
  const control = new BrowserGatewayControlPlane({ homeDir: home });
  const mockBackend = createMockBackendTransport(async (frame) => {
    if (frame.method === "Target.getTargets") return { targetInfos: [] };
    return {};
  });
  const server = new BrowserGatewayServer(control, { internalSecret: "top-secret-token" });
  control.registerProfile({ profileId: "p1", profileName: "P1", publicPort: port });
  await server.registerBackend({
    publicPort: port,
    backend: mockBackend.transport
  });

  try {
    // Reject HTTP with Origin header
    const originStatus = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/json/version",
          headers: { Origin: "https://attacker.example", "x-profilepilot-internal": "top-secret-token" }
        },
        (res) => resolve(res.statusCode)
      );
      req.once("error", reject);
      req.end();
    });
    assert.equal(originStatus, 403);

    // Reject HTTP with DNS-rebound Host header
    const hostStatus = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/json/version",
          headers: { Host: "rebind.attacker.example:9222", "x-profilepilot-internal": "top-secret-token" }
        },
        (res) => resolve(res.statusCode)
      );
      req.once("error", reject);
      req.end();
    });
    assert.equal(hostStatus, 403);

    // Valid loopback internal request succeeds
    const validStatus = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/json/version",
          headers: { Host: `127.0.0.1:${port}`, "x-profilepilot-internal": "top-secret-token" }
        },
        (res) => resolve(res.statusCode)
      );
      req.once("error", reject);
      req.end();
    });
    assert.equal(validStatus, 200);

    // Reject WebSocket upgrade with Origin header or bad Host header
    const { ticket } = control.acquire({
      publicPort: port,
      sessionId: "sess-ws",
      daemonInstanceId: "daemon-ws"
    });
    const wsOriginLine = await openRawUpgrade(port, `/devtools/browser/gateway?ticket=${encodeURIComponent(ticket)}`, {
      Origin: "https://evil.example"
    });
    assert.match(wsOriginLine, /403/);

    const wsHostLine = await openRawUpgrade(port, `/devtools/browser/gateway?ticket=${encodeURIComponent(ticket)}`, {
      Host: "evil.example:9222"
    });
    assert.match(wsHostLine, /403/);

    // Verify browser-engine/service.ts enforces Origin, loopback Host, and timingSafeEqual
    const serviceSource = readFileSync(
      path.resolve(import.meta.dirname, "..", "src", "main", "browser-engine", "service.ts"),
      "utf8"
    );
    assert.match(serviceSource, /req\.headers\.origin/);
    assert.match(serviceSource, /isLoopbackHostHeader\(req\.headers\.host\)/);
    assert.match(serviceSource, /timingSafeEqual\(/);
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. Per-Tab Concurrency, Conflict Fast-Fail & Dead-PID WMI Freeze Elimination
// ============================================================================

test("acquireProfileLeaseForCommandWithAutomaticSwitch fails fast without silently switching --cdp ports", () => {
  const home = mkdtempSync(path.join(gatewayTempDir, "pp-lease-noswitch-"));
  try {
    const first = acquireAgentBrowserProfileLeaseSync(
      {
        cdpPort: 9222,
        session: "session-owner",
        holderPid: process.pid,
        profileId: "p-9222",
        profileName: "Profile 9222"
      },
      home
    );
    assert.equal(first.ok, true);

    const env = { ...process.env, PROFILEPILOT_GATEWAY_HOME: home, HOME: home };
    const resolution = acquireProfileLeaseForCommandWithAutomaticSwitch(
      ["--session", "session-contender", "--cdp", "9222", "snapshot"],
      env
    );
    assert.equal(resolution.automaticSwitch, null, "must never silently switch to another port");
    assert.equal(resolution.lease?.ok, false, "must fail fast on conflict");
    assert.deepEqual(resolution.args, ["--session", "session-contender", "--cdp", "9222", "snapshot"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Per-tab multi-agent concurrency isolates disjoint tabs and pauses all sessions on Profile takeover", async () => {
  const home = mkdtempSync(path.join(gatewayTempDir, "pp-pertab-"));
  const port = await freePort();
  const control = new BrowserGatewayControlPlane({ homeDir: home });
  const mockBackend = createMockBackendTransport(async (frame) => {
    if (frame.method === "Target.getTargets") {
      return {
        targetInfos: [
          { targetId: "tab-alpha", type: "page", title: "Alpha", url: "https://alpha.test/" },
          { targetId: "tab-beta", type: "page", title: "Beta", url: "https://beta.test/" }
        ]
      };
    }
    if (frame.method === "Target.createTarget") {
      return { targetId: "tab-allocated" };
    }
    if (frame.method === "Target.attachToTarget") {
      return { sessionId: `cdp-${frame.params.targetId}` };
    }
    return {};
  });
  const server = new BrowserGatewayServer(control, { internalSecret: "sec" });
  control.registerProfile({ profileId: "shared-prof", profileName: "Shared", publicPort: port });
  await server.registerBackend({
    publicPort: port,
    backend: mockBackend.transport
  });

  try {
    // Session A acquires tab-alpha
    const acqA = control.acquire({
      publicPort: port,
      sessionId: "agent-a",
      daemonInstanceId: "daemon-a",
      targetId: "tab-alpha",
      allowSharedProfile: true
    });
    server.assignSessionTarget(port, "agent-a", "tab-alpha");
    assert.equal(acqA.profile.ownerSessionId, "agent-a");

    // Session B without sharing/target fails fast on conflict
    assert.throws(
      () =>
        control.acquire({
          publicPort: port,
          sessionId: "agent-b",
          daemonInstanceId: "daemon-b"
        }),
      (err) => err.code === "PROFILE_LEASE_CONFLICT"
    );

    // Session B with disjoint targetId succeeds on the same profile!
    const acqB = control.acquire({
      publicPort: port,
      sessionId: "agent-b",
      daemonInstanceId: "daemon-b",
      targetId: "tab-beta",
      allowSharedProfile: true
    });
    server.assignSessionTarget(port, "agent-b", "tab-beta");
    assert.ok(acqB.profile.sessions["agent-a"]);
    assert.ok(acqB.profile.sessions["agent-b"]);
    assert.equal(acqB.profile.sessions["agent-b"].targetId, "tab-beta");

    // Session B attempting to claim tab-alpha is rejected with PROFILE_LEASE_CONFLICT
    assert.throws(
      () => control.bindAllocatedTarget("agent-b", "daemon-b", "tab-alpha"),
      (err) => err.code === "PROFILE_LEASE_CONFLICT"
    );

    // Also verify local file lease supports shared disjoint tabs
    const leaseA = acquireAgentBrowserProfileLeaseSync(
      { cdpPort: port, session: "agent-a", holderPid: process.pid, targetId: "tab-alpha", allowSharedProfile: true },
      home
    );
    const leaseB = acquireAgentBrowserProfileLeaseSync(
      { cdpPort: port, session: "agent-b", holderPid: process.pid, targetId: "tab-beta", allowSharedProfile: true },
      home
    );
    assert.equal(leaseA.ok, true);
    assert.equal(leaseB.ok, true);
    const sameTabConflict = acquireAgentBrowserProfileLeaseSync(
      { cdpPort: port, session: "agent-c", holderPid: process.pid, targetId: "tab-alpha", allowSharedProfile: true },
      home
    );
    assert.equal(sameTabConflict.ok, false);

    // User triggers Profile-level Takeover -> ALL sessions on the profile pause!
    const paused = control.delegateToUser("agent-a", "user-takeover");
    assert.equal(paused.ownership, "user");
    assert.equal(paused.sessions["agent-a"].driverState, "parked");
    assert.equal(paused.sessions["agent-b"].driverState, "parked");

    // Returning to Agent resumes all active sessions on the profile
    const resumed = control.returnToAgent("agent-a");
    assert.equal(resumed.ownership, "agent");
    assert.equal(resumed.sessions["agent-a"].driverState, "connected");
    assert.equal(resumed.sessions["agent-b"].driverState, "connected");

    // Stopping agent-a promotes agent-b cleanly without dropping agent-b
    const afterStopA = control.stopSession("agent-a");
    assert.equal(afterStopA.sessionStatus, "active");
    assert.equal(afterStopA.ownerSessionId, "agent-b");
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("Dead recorded PID short-circuits immediately without spawning synchronous PowerShell WMI", () => {
  const deadPid = 99_999_991;
  assert.equal(isRecordedPidAlive(deadPid), false);
  assert.equal(isRecordedPidAlive(process.pid), true);
  const start = performance.now();
  const snap = driverProcessSnapshot(deadPid);
  const elapsedMs = performance.now() - start;
  assert.deepEqual(snap, []);
  assert.ok(elapsedMs < 50, `dead PID check must not spawn PowerShell WMI (took ${elapsedMs.toFixed(1)}ms)`);
});

// ============================================================================
// 3. Browser Engine, Snapshot, Contract & BrowserDebugSession Fixes
// ============================================================================

test("BrowserDebugSession.suspend disables Fetch/autoAttach and resumes late paused events", async () => {
  const calls = [];
  let owned = true;
  const session = new BrowserDebugSession(
    {
      check: () => {
        if (!owned) throw new Error("not owned");
      },
      send: async (method, params, sessionId) => {
        calls.push({ scope: sessionId || "root", method, params });
        return {};
      }
    },
    os.tmpdir()
  );

  session.bindTarget("t1", "page-sess-1");
  await session.start(["Network"]);
  session.targets.add("worker-sess-2");
  calls.length = 0;

  session.suspend("target-changed");
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(
    calls.some((c) => c.scope === "page-sess-1" && c.method === "Fetch.disable"),
    true,
    "suspend must send Fetch.disable to tracked target sessions"
  );
  assert.equal(
    calls.some(
      (c) =>
        c.scope === "page-sess-1" &&
        c.method === "Target.setAutoAttach" &&
        c.params?.waitForDebuggerOnStart === false
    ),
    true,
    "suspend must reset waitForDebuggerOnStart:false"
  );

  // Late Fetch.requestPaused and Target.attachedToTarget while suspended must immediately resume
  calls.length = 0;
  session.event({ method: "Fetch.requestPaused", params: { requestId: "late-req-1" }, sessionId: "page-sess-1" });
  session.event({
    method: "Target.attachedToTarget",
    params: { sessionId: "child-sess-3", waitingForDebugger: true, targetInfo: { type: "iframe" } },
    sessionId: "page-sess-1"
  });
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(
    calls.some((c) => c.method === "Fetch.continueRequest" && c.params?.requestId === "late-req-1"),
    true
  );
  assert.equal(
    calls.some((c) => c.scope === "child-sess-3" && c.method === "Runtime.runIfWaitingForDebugger"),
    true
  );

  // If ownership was revoked, suspend/late-events must not send unauthorized commands
  owned = false;
  calls.length = 0;
  session.event({ method: "Fetch.requestPaused", params: { requestId: "unowned-req" }, sessionId: "page-sess-1" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 0);
});

test("browser-command-contract exposes full Gateway parity and commandSchema", () => {
  const gatewayCmds = browserRouteCommands("gateway");
  for (const required of [
    "read",
    "pointer",
    "dialog",
    "network",
    "debug",
    "profiler",
    "console",
    "errors",
    "trace"
  ]) {
    assert.equal(required in gatewayCmds, true, `gateway route commands must include ${required}`);
    assert.ok(getCommandSchema("gateway", required), `commandSchema must describe ${required}`);
  }
  assert.ok(commandSchema.gateway.pointer);
  assert.ok(commandSchema.gateway.read);
});

test("Structure-preserving snapshot -i and --delta diffing retain landmarks and emit compact diffs", () => {
  const rawTree = [
    '- banner:',
    '  - text: "Static decorative header"',
    '- navigation "Primary Nav":',
    '  - list:',
    '    - listitem:',
    '      - link "Dashboard" [ref=e1]',
    '- main:',
    '  - region "Empty Notes":',
    '    - paragraph: "Nothing interactive here"',
    '  - dialog "Confirm Action":',
    '    - heading "Delete item?"',
    '    - generic "Clickable Div" [ref=e2] [cursor=pointer]',
    '    - menuitemcheckbox "Remember choice" [ref=e3]',
    '    - button "Confirm" [ref=e4]'
  ].join("\n");

  const interactive = filterInteractiveSnapshot(rawTree);
  assert.match(interactive, /- navigation "Primary Nav":/);
  assert.match(interactive, /- listitem:/);
  assert.match(interactive, /- link "Dashboard" \[ref=e1\]/);
  assert.match(interactive, /- main:/);
  assert.match(interactive, /- dialog "Confirm Action":/);
  assert.match(interactive, /\[cursor=pointer\]/);
  assert.match(interactive, /menuitemcheckbox "Remember choice"/);
  assert.doesNotMatch(interactive, /banner:/, "landmarks without interactive descendants must be pruned");
  assert.doesNotMatch(interactive, /Empty Notes/, "empty regions without interactive descendants must be pruned");

  // --delta diffing ignores ref renumbering on unchanged lines and surfaces real changes
  const prevTree = [
    '- main:',
    '  - button "Save" [ref=e1]',
    '  - button "Cancel" [ref=e2]'
  ].join("\n");
  const nextTreeSameWithRenumberedRefs = [
    '- main:',
    '  - button "Save" [ref=e10]',
    '  - button "Cancel" [ref=e11]'
  ].join("\n");
  const unchangedDelta = computeSnapshotDelta(prevTree, nextTreeSameWithRenumberedRefs);
  assert.equal(unchangedDelta.changed, false);
  assert.equal(unchangedDelta.delta, "(unchanged)");

  const nextTreeChanged = [
    '- main:',
    '  - button "Save" [ref=e10]',
    '  - button "Delete" [ref=e12]'
  ].join("\n");
  const delta = computeSnapshotDelta(prevTree, nextTreeChanged);
  assert.equal(delta.changed, true);
  assert.match(delta.delta, /-   - button "Cancel"/);
  assert.match(delta.delta, /\+   - button "Delete" \[ref=e12\]/);
});

test("BrowserEngine supports ARIA combobox select, paginated read, pointer, batch observe-last, dialogs/popups, CSP-safe annotate, and resilient timeouts", async () => {
  const engineSource = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "main", "browser-engine", "engine.ts"),
    "utf8"
  );
  assert.doesNotMatch(engineSource, /style\.cssText\s*=/, "screenshot --annotate must not use inline style.cssText");
  assert.match(engineSource, /new CSSStyleSheet\(\)/, "screenshot --annotate must use CSSStyleSheet");
  assert.match(engineSource, /adoptedStyleSheets/, "screenshot --annotate must use adoptedStyleSheets");

  let comboboxExpanded = false;
  let clickedComboboxTrigger = 0;
  let clickedOptionIndex = -1;
  let disconnectCount = 0;
  let observeSnapCount = 0;
  const mouseLog = [];
  let acceptedDialogPrompt = null;
  const evaluatedPayloads = [];

  const comboboxLocator = {
    async evaluate(fn) {
      const fakeEl = {
        tagName: "DIV",
        getAttribute(name) {
          if (name === "role") return "combobox";
          if (name === "aria-expanded") return comboboxExpanded ? "true" : "false";
          if (name === "aria-controls") return "framework-popup";
          return null;
        }
      };
      return fn(fakeEl);
    },
    async click() {
      clickedComboboxTrigger += 1;
      comboboxExpanded = true;
    }
  };

  const optionsCollection = {
    first() {
      return { async waitFor() {} };
    },
    async evaluateAll(_fn, desired) {
      return desired === "Option Beta" ? 1 : -1;
    },
    nth(idx) {
      return {
        async click() {
          clickedOptionIndex = idx;
        }
      };
    }
  };

  const fakeFrame = {
    isDetached: () => false,
    url: () => "https://app.example.test/form",
    locator(sel) {
      if (sel === "body") {
        return {
          innerText: async () => "Alpha line\nBeta paragraph match\nGamma paragraph match\nDelta line"
        };
      }
      if (sel === "#custom-combo") return comboboxLocator;
      if (sel.includes('[role="option"]')) return optionsCollection;
      return comboboxLocator;
    },
    async evaluate(arg0) {
      if (arg0 === "SLOW_MARKER") {
        await new Promise((r) => setTimeout(r, 120));
        return "late";
      }
      return "ok";
    }
  };

  const fakePage = {
    isClosed: () => false,
    url: () => "https://app.example.test/form",
    title: async () => "Form Page",
    mainFrame: () => fakeFrame,
    mouse: {
      click: async (x, y) => { mouseLog.push(["click", x, y]); },
      dblclick: async (x, y) => { mouseLog.push(["dblclick", x, y]); },
      move: async (x, y) => { mouseLog.push(["move", x, y]); },
      down: async () => { mouseLog.push(["down"]); },
      up: async () => { mouseLog.push(["up"]); },
      wheel: async (dx, dy) => { mouseLog.push(["wheel", dx, dy]); }
    },
    screenshot: async ({ path: p } = {}) => {
      const buf = Buffer.from("fake-png");
      if (p) writeFileSync(p, buf);
      return buf;
    },
    evaluate: async (_fn, payload) => {
      evaluatedPayloads.push(payload);
    }
  };

  const popupPage = {
    isClosed: () => false,
    url: () => "https://app.example.test/popup",
    title: async () => "OAuth Popup",
    mainFrame: () => fakeFrame
  };

  const engine = new BrowserEngine();
  engine.connectionStage = "connected";
  engine.browser = {
    isConnected: () => true,
    close: async () => { disconnectCount += 1; }
  };
  engine.context = {
    setDefaultTimeout: () => {}
  };
  engine.page = fakePage;
  engine.frame = fakeFrame;
  engine.tabs.set(fakePage, { id: "t1", targetId: "target-main" });
  engine.tabs.set(popupPage, { id: "t2", targetId: "target-popup" });
  engine.transport = {
    isOpen: () => true,
    request: async () => ({}),
    close: () => { disconnectCount += 1; }
  };
  engine.references = {
    version: "v1",
    clear() {},
    clearHistory() {},
    locator: () => comboboxLocator,
    boxes: async () => [{ ref: "e1", x: 10, y: 20, width: 100, height: 30 }],
    snapshot: async (_p, _f, snapArgs) => {
      if (!snapArgs.includes("-i")) observeSnapCount += 1;
      return {
        version: "v1",
        snapshot: '- combobox "Framework" [ref=e1]\n- button "Submit" [ref=e2]',
        refs: {
          e1: { role: "combobox", name: "Framework" },
          e2: { role: "button", name: "Submit" }
        }
      };
    }
  };

  const cmd = (args, extra = {}) => ({
    session: "eng-test",
    timeout: 2000,
    args,
    ...extra
  });

  // 1) Custom ARIA combobox select clicks trigger and matching [role="option"] without TypeError!
  const selectRes = await engine.execute(cmd(["select", "#custom-combo", "Option Beta"], { observeAfterAction: false }));
  assert.equal(selectRes.action, "select");
  assert.equal(clickedComboboxTrigger, 1);
  assert.equal(clickedOptionIndex, 1);

  // 2) Structured paginated read
  const readRes = await engine.execute(cmd(["read", "--query", "paragraph", "--cursor", "0", "--limit", "1", "--text-limit", "15"]));
  assert.equal(readRes.hasMore, true);
  assert.equal(readRes.nextCursor, 1);
  assert.equal(readRes.query, "paragraph");

  // 3) Coordinate pointer drag + popup watchdog reporting newTabs
  engine.newlyOpenedPages.push(popupPage);
  const dragRes = await engine.execute(cmd(["pointer", "drag", "20", "30", "120", "130"], { observeAfterAction: false }));
  assert.equal(dragRes.pointer, "drag");
  assert.deepEqual(dragRes.newTabs, [{ id: "t2", url: "https://app.example.test/popup", title: "OAuth Popup" }]);
  assert.equal(mouseLog.some((m) => m[0] === "down"), true);
  assert.equal(mouseLog.some((m) => m[0] === "up"), true);

  // 4) Batch defaults intermediate steps to observeAfterAction: false, observing only on the final step
  observeSnapCount = 0;
  const batchRes = await engine.execute(
    cmd([
      "batch",
      "--commands-json",
      JSON.stringify([
        ["pointer", "move", "10", "10"],
        ["pointer", "move", "20", "20"],
        ["pointer", "click", "20", "20"]
      ])
    ])
  );
  assert.equal(batchRes.failed, false);
  assert.equal(observeSnapCount, 1, "batch must observe only on the final step unless --observe-each is set");

  // 5) JS Dialog watchdog + dialog status / accept
  const fakeDialog = {
    type: () => "prompt",
    message: () => "Enter verification code",
    defaultValue: () => "",
    accept: async (val) => { acceptedDialogPrompt = val; },
    dismiss: async () => {}
  };
  engine.dialogs.set(fakePage, fakeDialog);
  engine.lastDialogs.set(fakePage, {
    seq: 1,
    type: "prompt",
    message: "Enter verification code",
    defaultValue: "",
    url: "https://app.example.test/form",
    at: new Date().toISOString(),
    autoHandled: false,
    resolution: "pending"
  });
  const dlgStatus = await engine.execute(cmd(["dialog", "status"]));
  assert.equal(dlgStatus.pendingDialog.message, "Enter verification code");
  const dlgAccept = await engine.execute(cmd(["dialog", "accept", "482910"]));
  assert.equal(dlgAccept.handled, "accepted");
  assert.equal(acceptedDialogPrompt, "482910");

  // 6) CSP-safe screenshot --annotate
  const shotDir = mkdtempSync(path.join(gatewayTempDir, "pp-shot-"));
  try {
    const shotPath = path.join(shotDir, "annotated.png");
    const shotRes = await engine.execute(cmd(["screenshot", shotPath, "--annotate"]));
    assert.equal(shotRes.path, shotPath);
    assert.equal(evaluatedPayloads.length >= 1, true);
  } finally {
    rmSync(shotDir, { recursive: true, force: true });
  }

  // 7) Timeout resilience: ordinary timeout does NOT disconnect healthy transport
  await assert.rejects(
    () => engine.execute(cmd(["eval", "SLOW_MARKER"], { timeout: 25 })),
    /timed out/i
  );
  assert.equal(disconnectCount, 0, "healthy transport must not be disconnected on ordinary command timeout");
});

// ============================================================================
// 4. HUD Overlay: Zero sessionStorage, Body Mount, Controlled-Tab-Only,
//    Windows Scaled DPI + DWM Borders & Electron Takeover
// ============================================================================

test("overlay-script has zero sessionStorage, mounts onto document.body post-readiness, and exposes screenGeometry", () => {
  const script = agentOverlayBootstrapScript();
  assert.doesNotMatch(script, /sessionStorage/, "overlay-script must have zero sessionStorage reads/writes");
  const overlayManagerSource = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "main", "agent-overlay.ts"),
    "utf8"
  );
  assert.doesNotMatch(overlayManagerSource, /sessionStorage/, "agent-overlay.ts must have zero sessionStorage references");
  assert.doesNotMatch(script, /documentElement\.append/, "must never mount #__pp-agent-overlay onto <html>");
  assert.match(script, /document\.body\.appendChild\(host\)/, "must mount #__pp-agent-overlay onto document.body");

  // Verify deferred mount when document.body is initially null (pre-body / loading)
  const appendedToBody = [];
  const pendingTimers = [];
  let domReadyHandler = null;
  const makeFakeEl = (tag) => ({
    tagName: String(tag).toUpperCase(),
    textContent: "",
    hidden: false,
    disabled: false,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    getAttribute: () => null,
    setAttribute() {},
    removeAttribute() {},
    replaceChildren() {},
    addEventListener() {},
    removeEventListener() {},
    append() {},
    appendChild(child) { return child; },
    remove() { this.parentNode = null; },
    querySelector: () => makeFakeEl("span"),
    attachShadow() {
      return {
        append() {},
        addEventListener() {},
        adoptedStyleSheets: [],
        activeElement: null,
        querySelector: () => makeFakeEl("button")
      };
    },
    getBoundingClientRect: () => ({ left: 1040, top: 740, right: 1180, bottom: 780, width: 140, height: 40 })
  });
  const fakeBody = {
    isConnected: true,
    append(node) {
      node.parentNode = fakeBody;
      appendedToBody.push(node);
    },
    appendChild(node) {
      node.parentNode = fakeBody;
      appendedToBody.push(node);
      return node;
    },
    contains(node) {
      return node?.parentNode === fakeBody;
    }
  };
  const fakeDoc = {
    readyState: "loading",
    body: null,
    documentElement: makeFakeEl("html"),
    getElementById: () => null,
    addEventListener(type, fn) {
      if (type === "DOMContentLoaded") domReadyHandler = fn;
    },
    createElement(tag) {
      return makeFakeEl(tag);
    },
    createElementNS() {
      return makeFakeEl("svg");
    }
  };
  const fakeWin = {
    screenX: 100,
    screenY: 100,
    outerWidth: 1216,
    outerHeight: 847,
    innerWidth: 1200,
    innerHeight: 800,
    devicePixelRatio: 1.5,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ backgroundColor: "rgb(255, 255, 255)", color: "rgb(0, 0, 0)" }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    __ppAgentOverlaySignal: () => {}
  };
  fakeWin.top = fakeWin;
  fakeWin.self = fakeWin;

  vm.runInNewContext(script, {
    window: fakeWin,
    document: fakeDoc,
    navigator: { language: "zh-CN" },
    CSSStyleSheet: function () { this.replaceSync = () => {}; },
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn) => { pendingTimers.push(fn); return pendingTimers.length; },
    clearTimeout: () => {},
    Date,
    Number,
    JSON,
    Math
  });

  fakeWin.__ppAgentOverlayUpdate({ state: "active", ownership: "agent", locale: "zh" });
  assert.equal(appendedToBody.length, 0, "must wait for document.body instead of mounting onto <html>");

  fakeDoc.body = fakeBody;
  fakeDoc.readyState = "interactive";
  domReadyHandler?.();
  while (pendingTimers.length > 0) {
    const fn = pendingTimers.shift();
    fn?.();
  }
  assert.equal(appendedToBody.length, 1, "mounts onto document.body once ready");

  const geom = JSON.parse(JSON.stringify(fakeWin.__ppAgentOverlayScreenGeometry()));
  assert.deepEqual(geom, {
    screenX: 100,
    screenY: 100,
    outerWidth: 1216,
    outerHeight: 847,
    innerWidth: 1200,
    innerHeight: 800,
    devicePixelRatio: 1.5
  });
});

test("AgentOverlayManager injects ONLY controlled tabs and handles Windows 150% DPI + Electron -32601 takeover clicks", async () => {
  // 1) Pure coordinate & window bounds math on Windows 150% scale with 8px DWM borders
  const win150Bounds = { x: 150, y: 150, width: 1824, height: 1271 }; // 1216x847 DIPs * 1.5
  assert.equal(
    matchesOverlayWindowBounds({ left: 100, top: 100, width: 1216, height: 847 }, win150Bounds, 1.5),
    true,
    "CDP DIP bounds must match Win32 physical pixel GetWindowRect at 150% DPI"
  );
  assert.equal(
    matchesViewportScreenGeometry(
      {
        screenX: 100,
        screenY: 100,
        outerWidth: 1216,
        outerHeight: 847,
        innerWidth: 1200,
        innerHeight: 800,
        devicePixelRatio: 1.5
      },
      win150Bounds,
      1.5
    ),
    true,
    "Viewport screenGeometry must match Win32 physical bounds when Browser.getWindowForTarget is unavailable"
  );

  // Takeover button at CSS (1120, 762) inside 1200x800 viewport with 8 DIP left/right/bottom DWM border & 39 DIP titlebar
  const clientPt = resolveOverlayGuardClientPoint({
    point: { x: Math.round((100 + 8 + 1120) * 1.5), y: Math.round((100 + 39 + 762) * 1.5) },
    nativeWindow: win150Bounds,
    displayScale: 1.5,
    devicePixelRatio: 1.5,
    innerWidth: 1200,
    innerHeight: 800,
    outerWidth: 1216
  });
  assert.ok(clientPt);
  assert.ok(Math.abs(clientPt.x - 1120) <= 1);
  assert.ok(Math.abs(clientPt.y - 762) <= 1);

  // 2) Controlled-tab-only attachment + Electron -32601 takeover activation
  const attachedTargets = [];
  const detachedSessions = [];
  const evaluations = [];
  const fakeClient = {
    onEvent: null,
    onDisconnect: null,
    close() {},
    async send(method, params = {}, _timeout, sessionId) {
      if (method === "Target.attachToTarget") {
        attachedTargets.push(params.targetId);
        return { sessionId: `sess-${params.targetId}` };
      }
      if (method === "Target.detachFromTarget") {
        detachedSessions.push(params.sessionId);
        return {};
      }
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: `frame-${sessionId}` } } };
      }
      if (method === "Page.createIsolatedWorld") {
        return { executionContextId: 11 };
      }
      if (method === "Browser.getWindowForTarget") {
        throw new Error("CDP error -32601: 'Browser.getWindowForTarget' wasn't found");
      }
      if (method === "Runtime.evaluate") {
        const expr = String(params.expression || "");
        evaluations.push({ expr, sessionId });
        if (expr.includes("__ppAgentOverlayGuardProbe")) {
          return {
            result: {
              value: {
                action: "takeover",
                signature: "sig-electron-150",
                screenGeometry: {
                  screenX: 100,
                  screenY: 100,
                  outerWidth: 1216,
                  outerHeight: 847,
                  innerWidth: 1200,
                  innerHeight: 800,
                  devicePixelRatio: 1.5
                }
              }
            }
          };
        }
        if (expr.includes("__ppAgentOverlayGuardActivate")) {
          return { result: { value: true } };
        }
        return { result: { value: true } };
      }
      return {};
    }
  };

  const manager = new AgentOverlayManager({
    onStop: async () => {},
    requestVersionInfo: async () => ({ webSocketDebuggerUrl: "ws://electron" }),
    requestTargets: async () => [
      { id: "tab-controlled", type: "page", url: "https://app.example.test/work" },
      { id: "tab-user-reading", type: "page", url: "https://news.example.test/" }
    ],
    connectBrowser: async () => fakeClient,
    inputGuard: { sync() {}, dispose() {} }
  });

  try {
    manager.sync({
      enabled: true,
      ports: [
        {
          port: 9555,
          profileId: "local-app:demo",
          profileName: "Electron Demo",
          browserPids: [4321],
          headless: false,
          controlledTargetIds: ["tab-controlled"],
          agentTarget: { targetId: "tab-controlled", title: "Work", url: "https://app.example.test/work" },
          clients: [{ pid: 99, label: "agent-browser", session: "cx-electron" }]
        }
      ]
    });

    const deadline = Date.now() + 2000;
    while (
      (!manager.ports.get(9555)?.pages.get("tab-controlled")?.activeContextId) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 15));
    }

    assert.deepEqual(attachedTargets, ["tab-controlled"], "must ONLY attach/inject controlled tab");
    assert.equal(manager.ports.get(9555).pages.has("tab-user-reading"), false);

    // Simulate user clicking Takeover on Windows 150% scaled Electron window (where getWindowForTarget threw -32601)
    await manager.handleInputGuardClick({
      pid: 4321,
      windowId: 77,
      displayScale: 1.5,
      window: win150Bounds,
      down: { x: 1842, y: 1352 },
      up: { x: 1842, y: 1352 },
      startedAt: 100,
      endedAt: 180
    });

    assert.equal(
      evaluations.some((e) => e.expr.includes("__ppAgentOverlayGuardActivate")),
      true,
      "Electron takeover click on Windows 150% display must activate guard action via screenGeometry fallback"
    );
  } finally {
    await manager.dispose();
  }
});

// ============================================================================
// 5. Site Adapters: Lease Verification Before raw-cdp & External JSON Configs
// ============================================================================

test("runGatewaySiteCli verifies Profile lease and Gateway acquire before raw-cdp and fails fast on conflict", async () => {
  const home = mkdtempSync(path.join(gatewayTempDir, "pp-site-lease-"));
  try {
    // 1) Conflict with another session's lease fails fast without calling Gateway
    acquireAgentBrowserProfileLeaseSync(
      { cdpPort: 9333, session: "other-owner", holderPid: process.pid },
      home
    );
    let gatewayCalled = false;
    await assert.rejects(
      () =>
        runGatewaySiteCli(
          ["--session", "my-task", "--cdp", "9333", "site", "--params", JSON.stringify({ operation: "zhihu.hot" })],
          4,
          9333,
          { ...process.env, PROFILEPILOT_GATEWAY_HOME: home, HOME: home },
          {
            requestGateway: async () => {
              gatewayCalled = true;
              return { ok: true };
            }
          }
        ),
      (err) => err.code === "PROFILE_LEASE_CONFLICT"
    );
    assert.equal(gatewayCalled, false, "must fail fast on local lease conflict before touching Gateway");
    releaseAgentBrowserProfileLeaseSync(9333, "other-owner", home);

    // 2) Valid session acquires Gateway ownership BEFORE issuing raw-cdp
    const actions = [];
    const result = await runGatewaySiteCli(
      ["--session", "my-task", "--cdp", "9333", "site", "--params", JSON.stringify({ operation: "zhihu.hot", params: { limit: 2 } })],
      4,
      9333,
      { ...process.env, PROFILEPILOT_GATEWAY_HOME: home, HOME: home },
      {
        requestGateway: async (req) => {
          actions.push(req.action);
          if (req.action === "acquire") {
            return { ok: true, targetId: "tab-zhihu" };
          }
          if (req.action === "raw-cdp" && req.method === "Runtime.evaluate") {
            const expr = String(req.params?.expression || "");
            if (expr.includes("document.readyState")) {
              return { result: { result: { value: { url: "https://www.zhihu.com/hot", ready: "complete" } } } };
            }
            return {
              result: {
                result: {
                  value: {
                    version: 1,
                    operation: "zhihu.hot",
                    status: "ok",
                    source: { url: "https://www.zhihu.com/hot", method: "browser-fetch", checkedAt: new Date().toISOString() },
                    effective: { limit: 2 },
                    items: [{ id: "1", title: "Hot Topic" }],
                    pagination: { next: null, hasMore: false },
                    completeness: { scope: "requested-hot-list", complete: true, reasons: [] }
                  }
                }
              }
            };
          }
          return { ok: true };
        }
      }
    );
    assert.equal(actions[0], "acquire", "must verify/establish Gateway session ownership before raw-cdp");
    assert.equal(actions[1], "raw-cdp");
    assert.equal(result.status, "ok");
    assert.ok(readAgentBrowserProfileLeaseSync(9333, home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("External declarative site adapters & presets load from ~/.profilepilot/site-adapters/*.json", async () => {
  const home = mkdtempSync(path.join(gatewayTempDir, "pp-ext-sites-"));
  const adaptersDir = path.join(home, ".profilepilot", "site-adapters");
  mkdirSync(adaptersDir, { recursive: true });

  writeFileSync(
    path.join(adaptersDir, "hn.json"),
    JSON.stringify({
      site: "hn",
      hosts: ["news.ycombinator.com"],
      presets: {
        "zhihu.hot": {
          top3: { limit: 3 }
        }
      },
      operations: {
        "hn.frontpage": {
          title: "Hacker News Frontpage",
          url: "https://news.ycombinator.com/?p={{page}}",
          parameters: {
            page: { type: "integer", min: 1, max: 10, default: 1 },
            limit: { type: "integer", min: 1, max: 30, default: 10 }
          },
          presets: {
            top5: { limit: 5 }
          },
          extractor: {
            kind: "dom",
            itemsSelector: "tr.athing",
            fields: {
              title: { selector: ".titleline > a", mode: "text" },
              url: { selector: ".titleline > a", mode: "href" }
            }
          }
        }
      }
    }),
    "utf8"
  );
  // Malformed file must be recorded in warnings without crashing catalog discovery
  writeFileSync(path.join(adaptersDir, "broken.json"), "{ invalid json", "utf8");

  try {
    const loaded = loadExternalSiteAdapterConfigs({ homeDir: home });
    assert.equal(loaded.warnings.length, 1);
    assert.equal(loaded.operations.has("hn.frontpage"), true);

    const all = listSiteAdapters(undefined, { homeDir: home });
    assert.equal(all.length, 22);
    const hnEntry = all.find((a) => a.operation === "hn.frontpage");
    assert.equal(hnEntry?.source, "external");
    assert.deepEqual(hnEntry?.presets, ["top5"]);

    // Built-in operation preset resolution
    const zhihuPlan = planSiteAdapter({ operation: "zhihu.hot", preset: "top3" }, { homeDir: home });
    assert.equal(zhihuPlan.params.limit, 3);

    // External DOM operation planning + execution inside VM page context
    const hnPlan = planSiteAdapter({ operation: "hn.frontpage", preset: "top5", params: { page: 2 } }, { homeDir: home });
    assert.equal(hnPlan.url, "https://news.ycombinator.com/?p=2");
    assert.equal(hnPlan.params.limit, 5);

    const fakeRow = {
      querySelector(sel) {
        if (sel === ".titleline > a") {
          return {
            textContent: "Show HN: ProfilePilot",
            getAttribute: (attr) => (attr === "href" ? "https://example.org/post" : null)
          };
        }
        return null;
      }
    };
    const context = {
      location: new URL("https://news.ycombinator.com/?p=2"),
      document: {
        body: { innerText: "" },
        querySelector: () => null,
        querySelectorAll: (sel) => (sel === "tr.athing" ? [fakeRow] : [])
      },
      window: {},
      URL,
      URLSearchParams,
      DOMParser: class { parseFromString() { return { body: { textContent: "" }, querySelectorAll: () => [] }; } },
      AbortSignal,
      Date
    };
    const pageResult = await vm.runInNewContext(
      `(${readSitePage.toString()})(${JSON.stringify(hnPlan)})`,
      context
    );
    assert.equal(pageResult.status, "ok");
    assert.equal(pageResult.source.method, "dom");
    assert.deepEqual(JSON.parse(JSON.stringify(pageResult.items)), [
      { title: "Show HN: ProfilePilot", url: "https://example.org/post" }
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("BrowserGatewayServer wires target-scoped Emulation overrides (clearing on disconnect) and awaits OOPIF top-level overlay avoidance on move/wheel", async () => {
  const home = mkdtempSync(path.join(gatewayTempDir, "pp-gw-emul-avoid-"));
  const port = await freePort();
  const control = new BrowserGatewayControlPlane({ homeDir: home });
  const backendOrder = [];

  const mockBackend = createMockBackendTransport(async (frame) => {
    backendOrder.push({ method: frame.method, sessionId: frame.sessionId || null, params: frame.params });
    if (frame.method === "Target.getTargets") {
      return {
        targetInfos: [
          { targetId: "page-top", type: "page", title: "Top", url: "https://top.example/" }
        ]
      };
    }
    if (frame.method === "Target.attachToTarget") {
      return { sessionId: "cdp-page-top" };
    }
    if (frame.method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "main-frame-top" } } };
    }
    if (frame.method === "Page.createIsolatedWorld") {
      return { executionContextId: 55 };
    }
    if (frame.method === "Runtime.evaluate") {
      // Simulate slight async work in overlay avoidance to verify Gateway awaits it BEFORE Input.dispatchMouseEvent!
      await new Promise((r) => setTimeout(r, 15));
      return { result: { value: true } };
    }
    return {};
  });

  const server = new BrowserGatewayServer(control, { internalSecret: "sec" });
  control.registerProfile({ profileId: "p-emul", profileName: "Emul", publicPort: port });
  await server.registerBackend({ publicPort: port, backend: mockBackend.transport });

  try {
    const { ticket } = control.acquire({
      publicPort: port,
      sessionId: "sess-emul",
      daemonInstanceId: "daemon-emul"
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/gateway?ticket=${encodeURIComponent(ticket)}`);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });

    let msgId = 1;
    const sendWs = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = msgId++;
        const onMsg = (ev) => {
          const parsed = JSON.parse(String(ev.data));
          if (parsed.id === id) {
            ws.removeEventListener("message", onMsg);
            if (parsed.error) reject(new Error(parsed.error.message));
            else resolve(parsed.result);
          }
        };
        ws.addEventListener("message", onMsg);
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });

    const attached = await sendWs("Target.attachToTarget", { targetId: "page-top", flatten: true });
    assert.equal(attached.sessionId, "cdp-page-top");
    await sendWs(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      "cdp-page-top"
    );

    // Simulate OOPIF child frame attached under cdp-page-top
    mockBackend.emitEvent(
      "Target.attachedToTarget",
      {
        sessionId: "cdp-oopif-child",
        targetInfo: { targetId: "frame-oopif", type: "iframe", url: "https://embed.example/" }
      },
      "cdp-page-top"
    );

    // 1a) Unsolicited Playwright Emulation.setDeviceMetricsOverride (without explicit marker) is virtualized
    backendOrder.length = 0;
    await sendWs(
      "Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      "cdp-page-top"
    );
    assert.equal(
      backendOrder.some((c) => c.method === "Emulation.setDeviceMetricsOverride"),
      false,
      "unsolicited Playwright viewport override must be virtualized"
    );

    // 1b) Explicit set viewport Emulation.setDeviceMetricsOverride forwards to cdp-page-top without leaking internal marker
    await sendWs(
      "Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false, __profilepilotExplicitViewport: true },
      "cdp-page-top"
    );
    const forwardedEmul = backendOrder.find((c) => c.method === "Emulation.setDeviceMetricsOverride" && c.sessionId === "cdp-page-top");
    assert.ok(forwardedEmul, "explicit set viewport must forward Emulation.setDeviceMetricsOverride to the target CDP session");
    assert.equal(forwardedEmul.params.__profilepilotExplicitViewport, undefined, "internal marker must be stripped before forwarding");

    // 2) Dispatch mouseWheel inside OOPIF child session -> avoidance MUST evaluate on top-level cdp-page-top BEFORE mouseWheel!
    backendOrder.length = 0;
    await sendWs(
      "Input.dispatchMouseEvent",
      { type: "mouseWheel", x: 300, y: 400, deltaX: 0, deltaY: 120 },
      "cdp-oopif-child"
    );
    const avoidIdx = backendOrder.findIndex(
      (c) => c.method === "Runtime.evaluate" && c.sessionId === "cdp-page-top"
    );
    const wheelIdx = backendOrder.findIndex(
      (c) => c.method === "Input.dispatchMouseEvent" && c.params?.type === "mouseWheel"
    );
    assert.ok(avoidIdx >= 0, "OOPIF mouseWheel must trigger overlay avoidance on top-level page session");
    assert.ok(avoidIdx < wheelIdx, "overlay avoidance must complete before Input.dispatchMouseEvent is sent");

    // 3) Closing agent WebSocket automatically clears Emulation override on cdp-page-top
    backendOrder.length = 0;
    ws.close();
    const deadline = Date.now() + 2000;
    while (
      !backendOrder.some((c) => c.method === "Emulation.clearDeviceMetricsOverride" && c.sessionId === "cdp-page-top") &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(
      backendOrder.some((c) => c.method === "Emulation.clearDeviceMetricsOverride" && c.sessionId === "cdp-page-top"),
      true,
      "disconnecting agent session must clear target-scoped Emulation override"
    );
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
