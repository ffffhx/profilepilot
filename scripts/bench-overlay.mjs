#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const START_PORT = Number(process.env.PP_BENCH_PORT_START || 9500);
const TAB_COUNTS = parseTabCounts(process.env.PP_BENCH_TABS || "1,5,10,20");
const CHROME_READY_TIMEOUT_MS = 10000;
const TARGET_READY_TIMEOUT_MS = 5000;
const INJECTION_TIMEOUT_MS = 12000;
const PUSH_TIMEOUT_MS = 8000;
const OBSERVER_IDLE_TIMEOUT_MS = 2500;
const OBSERVER_QUIET_MS = 80;
const OVERLAY_WORLD_NAME = "__ppAgentOverlayWorld";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

async function main() {
  installWebSocketPolyfill();

  const { AgentOverlayManager } = require("../dist/main/agent-overlay.js");
  const { CdpBrowserClient, requestCdpTargets, requestCdpVersionInfo } = require("../dist/main/cdp-client.js");
  assert.equal(typeof AgentOverlayManager, "function", "dist/main/agent-overlay.js must export AgentOverlayManager.");

  console.log("[bench] ProfilePilot overlay benchmark");
  console.log(`[bench] node=${process.version} platform=${process.platform}/${process.arch}`);
  console.log(`[bench] tabs=${TAB_COUNTS.join(",")} startPort=${START_PORT}`);

  const results = [];
  for (const tabCount of TAB_COUNTS) {
    console.log(`[bench] running tabs=${tabCount}`);
    const result = await runCase({
      AgentOverlayManager,
      CdpBrowserClient,
      requestCdpTargets,
      requestCdpVersionInfo,
      tabCount
    });
    results.push(result);
    console.log(
      `[bench] tabs=${tabCount} injection=${formatMs(result.injectionMs)} ` +
        `sync=${formatMs(result.stableSyncMs)} push=${formatMs(result.pushMs)} ` +
        `connections=${formatNullable(result.overlayConnectionCount)} targets=${result.stableTargetCalls}`
    );
  }

  printReport(results);
}

async function runCase({ AgentOverlayManager, CdpBrowserClient, requestCdpTargets, requestCdpVersionInfo, tabCount }) {
  let chrome = null;
  let controlClient = null;
  let manager = null;
  let managerDisposed = false;

  const observer = new CdpCommandObserver();
  const targetCalls = [];

  try {
    chrome = await launchChromeWithFallback(tabCount);
    controlClient = await CdpConnection.connect(chrome.browserWsUrl, 5000);
    const tabs = await createTabs(controlClient, chrome.port, tabCount);
    controlClient.close();
    controlClient = null;
    await delay(120);

    const baselineConnections = await sampleEstablishedConnections(chrome.port);

    const countedRequestTargets = async (port) => {
      targetCalls.push(performance.now());
      return requestCdpTargets(port);
    };

    manager = new AgentOverlayManager({
      locale: "en",
      onStop: async () => {},
      requestTargets: countedRequestTargets,
      requestVersionInfo: requestCdpVersionInfo,
      connectBrowser: async (webSocketDebuggerUrl, timeoutMs) => {
        const client = await CdpBrowserClient.connect(webSocketDebuggerUrl, timeoutMs);
        return new ObservedBrowserClient(client, observer);
      }
    });

    const initialInput = buildSyncInput(chrome.port, tabCount, 0);
    const firstTargetStart = targetCalls.length;
    const firstUpdateStart = observer.updateSuccesses.length;
    const firstSyncStart = performance.now();
    manager.sync(initialInput);

    const injectedAt = await waitForAllInjected(chrome.port, tabs, INJECTION_TIMEOUT_MS);
    const injectionMs = injectedAt - firstSyncStart;
    await waitForOverlayUpdates(observer, firstUpdateStart, tabCount, PUSH_TIMEOUT_MS, `initial push to ${tabCount} tabs`);
    await waitForObserverIdle(observer, firstSyncStart, OBSERVER_IDLE_TIMEOUT_MS, "initial observer idle");
    const initialTargetCalls = targetCalls.length - firstTargetStart;

    await delay(120);
    const managerConnections = await sampleEstablishedConnections(chrome.port);
    const overlayConnectionCount =
      baselineConnections.available && managerConnections.available
        ? managerConnections.count - baselineConnections.count
        : null;

    const stableTargetStart = targetCalls.length;
    const stableCommandStart = observer.commands.length;
    const stableStart = performance.now();
    manager.sync(initialInput);
    const stableSyncMs = performance.now() - stableStart;
    await waitForObserverIdle(observer, stableStart, OBSERVER_IDLE_TIMEOUT_MS, "stable sync observer idle");
    const stableObservedMs = performance.now() - stableStart;
    const stableTargetCalls = targetCalls.length - stableTargetStart;
    const stableCdpCommands = observer.commands.length - stableCommandStart;

    const pushTargetStart = targetCalls.length;
    const pushUpdateStart = observer.updateSuccesses.length;
    const pushStart = performance.now();
    manager.sync(buildSyncInput(chrome.port, tabCount, 1));
    await waitForOverlayUpdates(observer, pushUpdateStart, tabCount, PUSH_TIMEOUT_MS, `payload push to ${tabCount} tabs`);
    const pushMs = performance.now() - pushStart;
    await waitForObserverIdle(observer, pushStart, OBSERVER_IDLE_TIMEOUT_MS, "push observer idle");
    const pushTargetCalls = targetCalls.length - pushTargetStart;

    if (typeof manager.dispose === "function") {
      await manager.dispose();
      managerDisposed = true;
    } else {
      manager.sync({ enabled: false, ports: [] });
    }

    return {
      tabCount,
      port: chrome.port,
      chromeMode: chrome.mode,
      injectionMs,
      stableSyncMs,
      stableObservedMs,
      pushMs,
      overlayConnectionCount,
      baselineConnections,
      managerConnections,
      initialTargetCalls,
      stableTargetCalls,
      pushTargetCalls,
      stableCdpCommands
    };
  } finally {
    if (manager && !managerDisposed) {
      try {
        if (typeof manager.dispose === "function") {
          await manager.dispose();
        } else {
          manager.sync({ enabled: false, ports: [] });
        }
      } catch {
        // Continue cleanup.
      }
    }
    controlClient?.close();
    if (chrome) {
      await terminateProcess(chrome.child);
      await rm(chrome.tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function buildSyncInput(port, tabCount, round) {
  return {
    enabled: true,
    ports: [
      {
        port,
        profileId: `bench-profile-${tabCount}`,
        profileName: `Bench Profile ${tabCount}`,
        clients: buildClients(tabCount, round)
      }
    ]
  };
}

function buildClients(tabCount, round) {
  const now = Date.now() + round * 5000;
  return [
    {
      pid: 54000 + tabCount,
      label: "agent-browser",
      agent: "Codex",
      project: "profilepilot",
      title: `Overlay bench ${tabCount} tabs r${round}`,
      session: `cx-overlay-bench-${tabCount}`,
      lastActive: new Date(now).toISOString()
    },
    {
      pid: 55000 + tabCount,
      label: "agent-browser",
      agent: "Claude Code",
      project: "profilepilot",
      title: `Overlay bench helper ${tabCount} tabs r${round}`,
      session: `cc-overlay-bench-${tabCount}`,
      lastActive: new Date(now - 1000).toISOString()
    }
  ];
}

async function createTabs(browserClient, port, tabCount) {
  const urls = benchUrls(tabCount);
  const first = await waitForTarget(port, (target) => target.url === urls[0], TARGET_READY_TIMEOUT_MS, "initial bench tab");
  const tabs = [{ index: 1, targetId: first.id, url: urls[0] }];

  for (let index = 1; index < tabCount; index += 1) {
    const created = await browserClient.send("Target.createTarget", { url: urls[index] }, 5000);
    assert.equal(typeof created?.targetId, "string", `Target.createTarget should return a targetId for tab ${index + 1}.`);
    tabs.push({ index: index + 1, targetId: created.targetId, url: urls[index] });
  }

  await waitFor(async () => {
    const targets = await requestJson(port, "/json/list", 1000);
    const injectable = new Set(targets.filter(isInjectableTarget).map((target) => target.id));
    return tabs.every((tab) => injectable.has(tab.targetId)) ? true : null;
  }, TARGET_READY_TIMEOUT_MS, `${tabCount} bench tabs to appear in /json/list`);

  return tabs;
}

async function waitForAllInjected(port, tabs, timeoutMs) {
  const pending = new Map(tabs.map((tab) => [tab.targetId, tab]));
  const clients = new Map();
  try {
    await waitFor(async () => {
      const targets = await requestJson(port, "/json/list", 1000);
      const byId = new Map(targets.filter(isInjectableTarget).map((target) => [target.id, target]));

      for (const [targetId, tab] of [...pending]) {
        const target = byId.get(targetId);
        if (!target?.webSocketDebuggerUrl) {
          continue;
        }
        let client = clients.get(targetId);
        if (!client) {
          client = await CdpConnection.connect(target.webSocketDebuggerUrl, 1000);
          clients.set(targetId, client);
        }
        const state = await overlayState(client).catch(() => null);
        if (isMainWorldInjected(state)) {
          client.close();
          clients.delete(targetId);
          pending.delete(targetId);
          tab.injected = true;
        }
      }

      return pending.size === 0 ? true : null;
    }, timeoutMs, `overlay host injection in ${tabs.length} tabs`);
    return performance.now();
  } finally {
    for (const client of clients.values()) {
      client.close();
    }
  }
}

function isMainWorldInjected(state) {
  return (
    state?.host === true &&
    state.installedType === "undefined" &&
    state.updateType === "undefined" &&
    state.signalType === "undefined"
  );
}

function overlayState(client) {
  return evaluateValue(
    client,
    `(() => ({
      installedType: typeof window.__ppAgentOverlayInstalled,
      host: Boolean(document.getElementById("__pp-agent-overlay")),
      updateType: typeof window.__ppAgentOverlayUpdate,
      signalType: typeof window.__ppAgentOverlaySignal,
      teardownType: typeof window.__ppAgentOverlayTeardown
    }))()`,
    700
  );
}

async function evaluateValue(client, expression, timeoutMs = 1000) {
  const response = await client.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true
    },
    timeoutMs
  );
  if (response?.exceptionDetails) {
    throw new Error(`Runtime.evaluate failed: ${JSON.stringify(response.exceptionDetails)}`);
  }
  return response?.result?.value;
}

async function waitForOverlayUpdates(observer, startIndex, expectedCount, timeoutMs, label) {
  return waitFor(() => {
    const completed = observer.updateSuccesses.length - startIndex;
    return completed >= expectedCount ? completed : null;
  }, timeoutMs, label);
}

async function waitForObserverIdle(observer, since, timeoutMs, label) {
  return waitFor(() => {
    const now = performance.now();
    const quietSince = Math.max(since, observer.lastActivityAt);
    return observer.pendingCount === 0 && now - quietSince >= OBSERVER_QUIET_MS ? true : null;
  }, timeoutMs, label);
}

class CdpCommandObserver {
  constructor() {
    this.commands = [];
    this.updateSuccesses = [];
    this.pendingCount = 0;
    this.lastActivityAt = performance.now();
  }

  started(method, params, sessionId) {
    const command = {
      method,
      params,
      sessionId,
      start: performance.now(),
      end: null,
      error: null,
      overlayUpdate: isOverlayUpdateCommand(method, params)
    };
    this.pendingCount += 1;
    this.lastActivityAt = command.start;
    this.commands.push(command);
    return command;
  }

  finished(command, error) {
    command.end = performance.now();
    command.error = error ? formatError(error) : null;
    this.pendingCount = Math.max(0, this.pendingCount - 1);
    this.lastActivityAt = command.end;
    if (command.overlayUpdate && !command.error) {
      this.updateSuccesses.push(command);
    }
  }
}

class ObservedBrowserClient {
  constructor(inner, observer) {
    this.inner = inner;
    this.observer = observer;
  }

  get onEvent() {
    return this.inner.onEvent;
  }

  set onEvent(value) {
    this.inner.onEvent = value;
  }

  get onDisconnect() {
    return this.inner.onDisconnect;
  }

  set onDisconnect(value) {
    this.inner.onDisconnect = value;
  }

  async send(method, params = {}, timeoutMs, sessionId) {
    const command = this.observer.started(method, params, sessionId);
    try {
      const result = await this.inner.send(method, params, timeoutMs, sessionId);
      this.observer.finished(command, null);
      return result;
    } catch (error) {
      this.observer.finished(command, error);
      throw error;
    }
  }

  close() {
    this.inner.close();
  }
}

function isOverlayUpdateCommand(method, params) {
  return (
    method === "Runtime.evaluate" &&
    typeof params?.expression === "string" &&
    params.expression.includes("__ppAgentOverlayUpdate")
  );
}

async function sampleEstablishedConnections(port) {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:ESTABLISHED"], {
      timeout: 2500,
      maxBuffer: 1024 * 1024
    });
    const lines = stdout.split("\n").filter((line) => line.trim());
    const clientLines = lines
      .slice(1)
      .filter((line) => new RegExp(`->(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}\\b`).test(line));
    return {
      available: true,
      method: "lsof client-side ESTABLISHED sockets whose remote endpoint is 127.0.0.1:<port>",
      count: clientLines.length,
      lines: clientLines.map((line) => line.trim())
    };
  } catch (error) {
    return {
      available: false,
      method: "lsof client-side ESTABLISHED sockets whose remote endpoint is 127.0.0.1:<port>",
      count: null,
      error: formatError(error)
    };
  }
}

async function launchChromeWithFallback(tabCount) {
  const executable = await findChromeExecutable();
  const attempts = [
    { mode: "headless=new", headless: true },
    { mode: "headed", headless: false }
  ];
  const failures = [];

  for (const attempt of attempts) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pp-bench-overlay-"));
    const port = await findAvailablePort(START_PORT);
    const args = chromeArgs({ port, tempDir, headless: attempt.headless, initialUrl: benchUrls(tabCount)[0] });
    const child = spawn(executable, args, {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    let spawnError = null;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 20000) {
        stderr = stderr.slice(-20000);
      }
    });

    try {
      const version = await waitForCdp(port, child, () => spawnError, CHROME_READY_TIMEOUT_MS);
      assert.ok(version.webSocketDebuggerUrl, "Chrome /json/version should include webSocketDebuggerUrl.");
      return {
        child,
        tempDir,
        port,
        mode: attempt.mode,
        browserWsUrl: version.webSocketDebuggerUrl
      };
    } catch (error) {
      failures.push(`${attempt.mode}: ${formatError(error)}${stderr ? `\n${stderr}` : ""}`);
      await terminateProcess(child);
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  throw new Error(`Unable to launch Chrome with CDP.\n${failures.join("\n\n")}`);
}

function chromeArgs({ port, tempDir, headless, initialUrl }) {
  return [
    `--user-data-dir=${tempDir}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-popup-blocking",
    "--disable-sync",
    "--disable-translate",
    "--no-sandbox",
    "--window-size=1280,900",
    ...(headless ? ["--headless=new", "--disable-gpu"] : []),
    initialUrl
  ];
}

async function findChromeExecutable() {
  const envCandidates = [
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_BIN,
    process.env.CHROMIUM_BIN
  ].filter(Boolean);
  const candidates = [
    ...envCandidates,
    ...pathCandidates(["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Chromium\\Application\\chrome.exe"
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  throw new Error("Could not find a Chrome or Chromium executable. Set CHROME_PATH to override.");
}

function pathCandidates(names) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const suffixes = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  const results = [];
  for (const dir of dirs) {
    for (const name of names) {
      for (const suffix of suffixes) {
        results.push(path.join(dir, `${name}${suffix}`));
      }
    }
  }
  return results;
}

async function isExecutable(file) {
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function waitForCdp(port, child, spawnError, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (spawnError()) {
      throw spawnError();
    }
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited before CDP became ready, exit code ${child.exitCode}.`);
    }
    try {
      return await requestJson(port, "/json/version", 1000);
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error(
    `Timed out waiting for Chrome CDP on 127.0.0.1:${port}.${lastError instanceof Error ? ` Last error: ${lastError.message}` : ""}`
  );
}

async function waitForTarget(port, predicate, timeoutMs, label) {
  return waitFor(async () => {
    const targets = await requestJson(port, "/json/list", 1000);
    return targets.find((target) => isInjectableTarget(target) && predicate(target)) || null;
  }, timeoutMs, label);
}

function isInjectableTarget(target) {
  if (target.type !== "page" || !target.webSocketDebuggerUrl) {
    return false;
  }
  const url = target.url || "";
  return !/^(chrome|devtools|chrome-extension|edge|about:chrome|view-source:chrome):/i.test(url);
}

async function requestJson(port, requestPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        timeout: timeoutMs
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`HTTP ${response.statusCode || "unknown"} for ${requestPath}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      }
    );
    request.on("timeout", () => {
      request.destroy(new Error(`HTTP timeout for ${requestPath}`));
    });
    request.on("error", reject);
  });
}

async function findAvailablePort(startPort) {
  for (let port = startPort; port <= 65535; port += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available TCP port found at or above ${startPort}.`);
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen({ host: "127.0.0.1", port });
  });
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for ${label}.${lastError instanceof Error ? ` Last error: ${lastError.message}` : ""}`
  );
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function terminateProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    delay(2500).then(() => false)
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), delay(1000)]).catch(() => undefined);
  }
}

function benchUrls(tabCount) {
  return Array.from({ length: tabCount }, (_, index) =>
    dataUrl(`pp-bench-overlay-${tabCount}-${index + 1}`, `ProfilePilot overlay bench ${tabCount}/${index + 1}`)
  );
}

function dataUrl(id, text) {
  const html = `<!doctype html><meta charset="utf-8"><title>${id}</title><main id="${id}">${text}</main>`;
  return `data:text/html,${encodeURIComponent(html)}`;
}

function parseTabCounts(raw) {
  const values = String(raw)
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (!values.length) {
    throw new Error("PP_BENCH_TABS must include at least one positive integer.");
  }
  return values;
}

function printReport(results) {
  console.log("");
  console.log("Overlay benchmark report");
  console.log("");
  console.log(
    [
      "Tabs",
      "First injection",
      "Stable sync",
      "Payload push",
      "CDP conns",
      "Targets calls"
    ].join(" | ")
  );
  console.log(
    [
      "---:",
      "---:",
      "---:",
      "---:",
      "---:",
      "---:"
    ].join(" | ")
  );
  for (const result of results) {
    console.log(
      [
        result.tabCount,
        formatMs(result.injectionMs),
        formatMs(result.stableSyncMs),
        formatMs(result.pushMs),
        formatNullable(result.overlayConnectionCount),
        result.stableTargetCalls
      ].join(" | ")
    );
  }

  console.log("");
  console.log("Details");
  for (const result of results) {
    console.log(
      `- N=${result.tabCount}: port=${result.port}, chrome=${result.chromeMode}, ` +
        `initialTargets=${result.initialTargetCalls}, stableTargets=${result.stableTargetCalls}, ` +
        `pushTargets=${result.pushTargetCalls}, stableObserved=${formatMs(result.stableObservedMs)}, ` +
        `stableCdpCommands=${result.stableCdpCommands}`
    );
  }

  const allConnectionSamples = results.every((result) => result.overlayConnectionCount === 1);
  const allStableTargetCallsCached = results.every((result) => result.stableTargetCalls <= 1 && result.pushTargetCalls <= 1);
  const injectionSlope = slopeSummary(results, "injectionMs");
  const pushSlope = slopeSummary(results, "pushMs");

  console.log("");
  console.log("Conclusion");
  console.log(
    `- CDP connection count is ${allConnectionSamples ? "constant at 1" : "not constant in the available samples"} ` +
      "for the overlay manager; verifier sockets are closed before sampling."
  );
  console.log(
    `- requestTargets caching evidence: stable sync and push rounds stayed <=1 /json/list call ` +
      `for every N (${allStableTargetCallsCached ? "pass" : "check details"}).`
  );
  console.log(`- First injection trend: ${injectionSlope}.`);
  console.log(`- Payload push trend: ${pushSlope}.`);
  console.log("- Stable sync is reported as the public sync() call scheduling cost; async CDP side effects are listed as stableObserved in details.");
}

function slopeSummary(results, key) {
  if (results.length < 2) {
    return "single sample";
  }
  const first = results[0];
  const last = results[results.length - 1];
  if (!first?.tabCount || !last?.tabCount || last.tabCount === first.tabCount) {
    return "insufficient spread";
  }
  const perTab = (last[key] - first[key]) / (last.tabCount - first.tabCount);
  const ratio = last[key] / Math.max(first[key], 0.001);
  return `${formatMs(perTab)} per added tab from N=${first.tabCount} to N=${last.tabCount} (${ratio.toFixed(2)}x total)`;
}

function formatMs(value) {
  return `${value.toFixed(1)}ms`;
}

function formatNullable(value) {
  return value === null || value === undefined ? "n/a" : String(value);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.onEvent = null;
    this.socket.addEventListener("message", (event) => this.handleMessage(event.data));
    this.socket.addEventListener("close", () => this.rejectPending(new Error("CDP websocket closed.")));
  }

  static connect(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = new globalThis.WebSocket(url);
      const timer = setTimeout(() => {
        cleanup();
        try {
          socket.close();
        } catch {
          // Continue rejecting.
        }
        reject(new Error(`Timed out connecting to ${url}.`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("error", handleError);
      };
      const handleOpen = () => {
        cleanup();
        resolve(new CdpConnection(socket));
      };
      const handleError = () => {
        cleanup();
        reject(new Error(`Failed to connect to ${url}.`));
      };
      socket.addEventListener("open", handleOpen);
      socket.addEventListener("error", handleError);
    });
  }

  send(method, params = {}, timeoutMs = 3000) {
    if (this.socket.readyState !== 1) {
      return Promise.reject(new Error("CDP websocket is not open."));
    }

    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });

      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close() {
    this.rejectPending(new Error("CDP connection closed."));
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }

  handleMessage(data) {
    let parsed;
    try {
      const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    if (typeof parsed.id !== "number") {
      this.onEvent?.(parsed.method, parsed.params);
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(parsed.id);
    if (parsed.error) {
      pending.reject(new Error(parsed.error.message || `CDP command failed: ${JSON.stringify(parsed.error)}`));
      return;
    }
    pending.resolve(parsed.result);
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function installWebSocketPolyfill() {
  if (typeof globalThis.WebSocket === "function") {
    return;
  }
  globalThis.WebSocket = MiniWebSocket;
}

class MiniWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(rawUrl) {
    this.url = rawUrl;
    this.readyState = MiniWebSocket.CONNECTING;
    this.listeners = new Map();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.handshakeComplete = false;
    this.closeEmitted = false;
    queueMicrotask(() => this.connect());
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data) {
    if (this.readyState !== MiniWebSocket.OPEN || !this.socket) {
      throw new Error("WebSocket is not open.");
    }
    this.writeFrame(Buffer.from(String(data)), 0x1);
  }

  close() {
    if (this.readyState === MiniWebSocket.CLOSED || this.readyState === MiniWebSocket.CLOSING) {
      return;
    }
    this.readyState = MiniWebSocket.CLOSING;
    try {
      if (this.socket && !this.socket.destroyed) {
        if (this.handshakeComplete) {
          this.writeFrame(Buffer.alloc(0), 0x8);
        }
        this.socket.end();
      }
    } catch {
      this.socket?.destroy();
    }
  }

  connect() {
    let parsed;
    try {
      parsed = new URL(this.url);
      if (parsed.protocol !== "ws:") {
        throw new Error(`Unsupported WebSocket protocol: ${parsed.protocol}`);
      }
    } catch (error) {
      this.emit("error", { error });
      this.finishClose();
      return;
    }

    const key = randomBytes(16).toString("base64");
    const port = parsed.port ? Number(parsed.port) : 80;
    const host = parsed.hostname;
    const requestPath = `${parsed.pathname}${parsed.search}`;
    this.expectedAccept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");

    this.socket = net.createConnection({ host, port }, () => {
      const request = [
        `GET ${requestPath} HTTP/1.1`,
        `Host: ${host}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        ""
      ].join("\r\n");
      this.socket.write(request);
    });
    this.socket.on("data", (chunk) => this.handleData(chunk));
    this.socket.on("error", (error) => {
      this.emit("error", { error });
      this.finishClose();
    });
    this.socket.on("close", () => this.finishClose());
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.handshakeComplete) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const headerText = this.buffer.subarray(0, headerEnd).toString("utf8");
      this.buffer = this.buffer.subarray(headerEnd + 4);
      try {
        this.validateHandshake(headerText);
      } catch (error) {
        this.emit("error", { error });
        this.close();
        return;
      }
      this.handshakeComplete = true;
      this.readyState = MiniWebSocket.OPEN;
      this.emit("open", {});
    }
    this.readFrames();
  }

  validateHandshake(headerText) {
    const lines = headerText.split(/\r\n/);
    if (!/^HTTP\/1\.1 101\b/.test(lines[0] || "")) {
      throw new Error(`WebSocket upgrade failed: ${lines[0] || "missing status line"}`);
    }
    const headers = new Map();
    for (const line of lines.slice(1)) {
      const index = line.indexOf(":");
      if (index > 0) {
        headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
      }
    }
    const accept = headers.get("sec-websocket-accept");
    if (accept && accept !== this.expectedAccept) {
      throw new Error("WebSocket accept header did not match.");
    }
  }

  readFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < offset + 2) {
          return;
        }
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) {
          return;
        }
        const bigLength = this.buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.emit("error", { error: new Error("WebSocket frame too large.") });
          this.close();
          return;
        }
        length = Number(bigLength);
        offset += 8;
      }

      let mask = null;
      if (masked) {
        if (this.buffer.length < offset + 4) {
          return;
        }
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + length) {
        return;
      }

      let payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) {
        payload = unmask(payload, mask);
      }
      this.handleFrame(opcode, payload);
    }
  }

  handleFrame(opcode, payload) {
    if (opcode === 0x1) {
      this.emit("message", { data: payload.toString("utf8") });
      return;
    }
    if (opcode === 0x2) {
      this.emit("message", { data: payload });
      return;
    }
    if (opcode === 0x8) {
      this.close();
      return;
    }
    if (opcode === 0x9) {
      this.writeFrame(payload, 0xA);
    }
  }

  writeFrame(payload, opcode) {
    if (!this.socket || this.socket.destroyed) {
      return;
    }
    const mask = randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | payload.length;
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const maskedPayload = unmask(payload, mask);
    this.socket.write(Buffer.concat([header, mask, maskedPayload]));
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) || []) {
      try {
        listener.call(this, event);
      } catch {
        // Match browser event dispatch: listener failures do not stop dispatch.
      }
    }
  }

  finishClose() {
    if (this.closeEmitted) {
      return;
    }
    this.closeEmitted = true;
    this.readyState = MiniWebSocket.CLOSED;
    this.emit("close", {});
  }
}

function unmask(payload, mask) {
  const result = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    result[index] = payload[index] ^ mask[index % 4];
  }
  return result;
}

await main().catch((error) => {
  process.exitCode = 1;
  console.error(`[bench] FAILED: ${formatError(error)}`);
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
});
