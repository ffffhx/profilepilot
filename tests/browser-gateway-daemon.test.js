const assert = require("node:assert/strict");
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ensureConfiguredGatewayProfileRunning, prepareGatewayTransport } = require("../dist/main/agent-browser-wrapper.js");
const { ensureBrowserGatewayDaemon, requestBrowserGateway, subscribeBrowserGatewayEvents } = require("../dist/main/browser-gateway-client.js");
const { BrowserGatewayDaemon } = require("../dist/main/browser-gateway-daemon.js");

test("gatewayd owns the Chrome pipe, control socket and public ticketed WebSocket end to end", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-gateway-daemon-"));
  const fakeChrome = writeFakeChrome(home);
  const port = await freePort();
  const daemon = new BrowserGatewayDaemon(home);
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
      args: [fakeChrome]
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
    assert.deepEqual(raw.result, { echoed: "Target.activateTarget" });

    const closed = new Promise((resolve) => ws.addEventListener("close", resolve, { once: true }));
    await requestBrowserGateway({ action: "control", sessionId: "cx-one", command: "takeover" }, { homeDir: home });
    await closed;
    await waitFor(() => controlEvents.some((event) => event.reason === "agent-disconnected"), "disconnect event delivered");
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

test("agent-browser wrapper transparently connects through a Gateway ticket and strips direct CDP", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-gateway-wrapper-"));
  const fakeChrome = writeFakeChrome(home);
  const fakeAgentBrowser = path.join(home, "fake-agent-browser.js");
  const callsPath = path.join(home, "agent-browser-calls.ndjson");
  const holderPidPath = path.join(home, "holder.pid");
  const readyPath = path.join(home, "holder.ready");
  writeFileSync(fakeAgentBrowser, `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS_PATH, JSON.stringify(args) + "\\n");
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
  const daemon = new BrowserGatewayDaemon(home);
  await daemon.start();
  try {
    await requestBrowserGateway({
      action: "launch-profile",
      profileId: "profile-a",
      profileName: "Profile A",
      publicPort: port,
      executable: process.execPath,
      args: [fakeChrome]
    }, { homeDir: home });
    const env = {
      ...process.env,
      HOME: home,
      AGENT_BROWSER_SESSION: "cx-wrapper",
      CALLS_PATH: callsPath,
      HOLDER_PID_PATH: holderPidPath,
      READY_PATH: readyPath
    };
    const prepared = await prepareGatewayTransport(
      fakeAgentBrowser,
      ["--cdp", String(port), "snapshot", "--json"],
      env,
      port
    );
    assert.deepEqual(prepared, ["snapshot", "--json"]);
    const calls = readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 3), ["--session", "cx-wrapper", "connect"]);
    assert.match(calls[0][3], new RegExp(`^ws://127\\.0\\.0\\.1:${port}/devtools/browser/gateway\\?ticket=`));
    const status = await requestBrowserGateway({ action: "status" }, { homeDir: home });
    const profile = status.state.profiles.find((item) => item.publicPort === port);
    assert.equal(profile.ownerSessionId, "cx-wrapper");
    assert.equal(profile.ownership, "agent");
    assert.equal(profile.daemonPid, Number(readFileSync(holderPidPath, "utf8")));
    await requestBrowserGateway({ action: "control", sessionId: "cx-wrapper", command: "takeover" }, { homeDir: home });
    await waitFor(() => !isPidAlive(Number(readFileSync(holderPidPath, "utf8"))), "holder exits after takeover");
  } finally {
    if (existsSync(holderPidPath)) {
      try { process.kill(Number(readFileSync(holderPidPath, "utf8")), "SIGKILL"); } catch {}
    }
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
  const daemon = new BrowserGatewayDaemon(home);
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
  const daemon = new BrowserGatewayDaemon(home);
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
  const daemon = new BrowserGatewayDaemon(home);
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
  const daemon = new BrowserGatewayDaemon(home);
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
  const socketPath = path.join(gatewayRoot, "control.sock");
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
    const result = message.method === "Target.getTargets"
      ? { targetInfos: [{ targetId: "page-1", type: "page", title: "Fixture", url: "https://example.test/" }] }
      : { echoed: message.method };
    output.write(JSON.stringify({ id: message.id, result }) + "\\0");
  }
});
`);
  chmodSync(fakeChrome, 0o755);
  return fakeChrome;
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
