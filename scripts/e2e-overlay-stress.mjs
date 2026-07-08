#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
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

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const START_PORT = Number(process.env.PP_E2E_PORT_START || 9494);
const CHROME_READY_TIMEOUT_MS = 10000;
const INJECTION_TIMEOUT_MS = 7000;
const NAVIGATION_TIMEOUT_MS = 4000;
const OVERLAY_WORLD_NAME = "__ppAgentOverlayWorld";
const TAB_COUNT = 5;
const TAB_URLS = Array.from({ length: TAB_COUNT }, (_, index) =>
  dataUrl(`pp-stress-tab-${index + 1}`, `ProfilePilot overlay stress tab ${index + 1}`)
);
const NAVIGATION_URLS = [
  dataUrl("pp-stress-nav-a", "ProfilePilot overlay stress navigation A"),
  dataUrl("pp-stress-nav-b", "ProfilePilot overlay stress navigation B"),
  dataUrl("pp-stress-nav-c", "ProfilePilot overlay stress navigation C"),
  dataUrl("pp-stress-nav-d", "ProfilePilot overlay stress navigation D")
];

let chrome = null;
let manager = null;
let browserClient = null;
let managerDisposed = false;
const pageClients = [];
const assertions = [];
const unhandledFailures = [];

process.on("unhandledRejection", (reason) => {
  const message = formatError(reason);
  unhandledFailures.push(`unhandledRejection: ${message}`);
  console.error(`[stress] UNHANDLED rejection: ${message}`);
});

async function main() {
  try {
  if (typeof globalThis.WebSocket !== "function") {
    throw new Error("Node >=20 with global WebSocket is required for this stress script.");
  }

  const { AgentOverlayManager } = require("../dist/main/agent-overlay.js");
  assert.equal(typeof AgentOverlayManager, "function", "dist/main/agent-overlay.js must export AgentOverlayManager.");

  printScenarioList();

  chrome = await launchChromeWithFallback();
  log(`Chrome launched on CDP port ${chrome.port} (${chrome.mode}).`);

  browserClient = await CdpConnection.connect(chrome.browserWsUrl, 5000);
  log("Control browser-level CDP connection opened for the test harness.");

  const tabs = await createStressTabs();
  pass(`multi-tab setup created ${tabs.length} page targets with distinct data: URLs`, {
    targetIds: tabs.map((tab) => tab.targetId)
  });

  const clients = buildClients();
  const beforeManagerConnections = await sampleEstablishedConnections(chrome.port);
  pass("connection baseline sampled before AgentOverlayManager.sync", beforeManagerConnections);

  const stopCalls = [];
  manager = new AgentOverlayManager({
    onStop: async (request) => {
      stopCalls.push({ ...request, at: Date.now() });
    }
  });

  manager.sync({
    enabled: true,
    ports: [
      {
        port: chrome.port,
        profileId: "stress-profile",
        profileName: "E2E Stress Profile",
        clients
      }
    ]
  });
  log("AgentOverlayManager.sync(enabled:true) started.");

  const afterManagerConnections = await waitForManagerConnectionSample(
    chrome.port,
    beforeManagerConnections,
    "manager browser-level websocket"
  );
  pass("overlay manager opened exactly one additional browser-level websocket", {
    method: afterManagerConnections.method,
    before: beforeManagerConnections.count,
    after: afterManagerConnections.count,
    delta: afterManagerConnections.count - beforeManagerConnections.count
  });

  const pages = [];
  for (const tab of tabs) {
    const page = await waitForInjectedTarget(chrome.port, tab.targetId, INJECTION_TIMEOUT_MS, `tab ${tab.index} injection`);
    pageClients.push(page.client);
    pages.push({ ...tab, ...page });
    assertMainWorldInjected(page.state, `tab ${tab.index}`);
  }
  pass("multi-tab concurrent injection kept main-world globals isolated and host DOM visible", {
    tabs: pages.map((page) => ({ index: page.index, targetId: page.targetId, host: page.state.host }))
  });

  for (const page of pages) {
    page.contextId = await overlayWorldContext(page.client, `tab ${page.index} isolated world`);
    const isolated = await overlayState(page.client, page.contextId);
    assertIsolatedWorldInstalled(isolated, `tab ${page.index}`);
  }
  pass("all tabs exposed overlay controls only inside the isolated world", {
    contexts: pages.map((page) => ({ index: page.index, contextId: page.contextId }))
  });

  const afterVerifierConnections = await sampleEstablishedConnections(chrome.port);
  pass("connection sample after verifier page websocket attachments", {
    method: afterVerifierConnections.method,
    beforeManager: beforeManagerConnections.count,
    afterManager: afterManagerConnections.count,
    afterVerifier: afterVerifierConnections.count,
    verifierConnections: pages.length,
    managerDelta: afterManagerConnections.count - beforeManagerConnections.count,
    verifierDelta: afterVerifierConnections.count - afterManagerConnections.count
  });

  await runRapidNavigationScenario(pages[0]);
  await runToggleScenario(pages, clients);
  await runTakeoverReconnectScenario(pages[1], clients, stopCalls);
  await runDisposeScenario(pages);

  pass("no unhandled asynchronous failures were observed", { unhandledFailures: unhandledFailures.length });
  log(`PASS assertions=${assertions.length}`);
} catch (error) {
  process.exitCode = 1;
  console.error(`[stress] FAILED: ${formatError(error)}`);
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
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

  for (const client of pageClients.splice(0)) {
    client.close();
  }

  if (browserClient) {
    try {
      await browserClient.send("Browser.close", {}, 1000);
    } catch {
      // Chrome may already be closed.
    }
    browserClient.close();
  }

  if (chrome) {
    await terminateProcess(chrome.child);
    await rm(chrome.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
}

function printScenarioList() {
  log("Scenario list:");
  log("  1. multi-tab concurrent injection and single browser-level websocket validation");
  log("  2. rapid Page.navigate churn with addScriptToEvaluateOnNewDocument rebuild checks");
  log("  3. sync enabled:false/true toggle cleanup and recovery");
  log("  4. takeover stop path, keepalive, and same-session reconnect recovery");
  log("  5. dispose teardown with no residual overlay globals");
}

async function createStressTabs() {
  const first = await waitForTarget(
    chrome.port,
    (target) => target.url === TAB_URLS[0],
    5000,
    "initial stress tab"
  );
  const tabs = [{ index: 1, targetId: first.id, url: TAB_URLS[0] }];

  for (let index = 1; index < TAB_URLS.length; index += 1) {
    const created = await browserClient.send("Target.createTarget", { url: TAB_URLS[index] }, 5000);
    assert.equal(typeof created?.targetId, "string", `Target.createTarget should return targetId for tab ${index + 1}.`);
    tabs.push({ index: index + 1, targetId: created.targetId, url: TAB_URLS[index] });
  }

  await waitFor(async () => {
    const targets = await requestJson(chrome.port, "/json/list", 1000);
    const injectable = new Set(targets.filter(isInjectableTarget).map((target) => target.id));
    return tabs.every((tab) => injectable.has(tab.targetId)) ? true : null;
  }, 5000, "all stress tabs to appear in /json/list");

  return tabs;
}

async function runRapidNavigationScenario(page) {
  log("Scenario rapid-navigation started.");
  const timings = [];
  for (const [index, url] of NAVIGATION_URLS.entries()) {
    const started = performance.now();
    await page.client.send("Page.navigate", { url }, 5000);
    await delay(80);
    const state = await waitForPageInjected(page.client, NAVIGATION_TIMEOUT_MS, `rapid navigation ${index + 1}`);
    assertMainWorldInjected(state, `rapid navigation ${index + 1}`);
    timings.push({ index: index + 1, elapsedMs: Math.round(performance.now() - started), host: state.host });
  }
  page.contextId = await overlayWorldContext(page.client, "rapid-navigation final isolated world");
  const isolated = await overlayState(page.client, page.contextId);
  assertIsolatedWorldInstalled(isolated, "rapid-navigation final isolated world");
  pass("rapid navigation rebuilt overlay host and kept globals isolated after every document", { navigations: timings });
}

async function runToggleScenario(pages, clients) {
  log("Scenario toggle started.");
  for (const page of pages) {
    page.contextId = await overlayWorldContext(page.client, `tab ${page.index} pre-toggle isolated world`);
  }

  manager.sync({ enabled: false, ports: [] });
  await Promise.all(pages.map((page) => waitForOverlayRemoved(page.client, `tab ${page.index} toggle-off main world`)));
  await Promise.all(
    pages.map((page) =>
      waitForIsolatedCleared(page.client, page.contextId, `tab ${page.index} toggle-off isolated world`)
    )
  );
  pass("sync(enabled:false) removed host DOM and cleared main/isolated world overlay globals", {
    tabs: pages.map((page) => ({ index: page.index, contextId: page.contextId }))
  });

  manager.sync({
    enabled: true,
    ports: [
      {
        port: chrome.port,
        profileId: "stress-profile",
        profileName: "E2E Stress Profile",
        clients
      }
    ]
  });

  for (const page of pages) {
    const state = await waitForPageInjected(page.client, INJECTION_TIMEOUT_MS, `tab ${page.index} toggle-on reinjection`);
    assertMainWorldInjected(state, `tab ${page.index} toggle-on`);
    page.contextId = await overlayWorldContext(page.client, `tab ${page.index} toggle-on isolated world`);
    assertIsolatedWorldInstalled(await overlayState(page.client, page.contextId), `tab ${page.index} toggle-on isolated world`);
  }
  pass("sync(enabled:true) restored overlay injection on every existing tab", {
    tabs: pages.map((page) => ({ index: page.index, contextId: page.contextId }))
  });
}

async function runTakeoverReconnectScenario(page, clients, stopCalls) {
  log("Scenario takeover-reconnect started.");
  await activatePage(page);
  const beforeFirstStop = stopCalls.length;
  await clickOverlayStopButton(page.client);
  await waitFor(
    () => (stopCalls.length === beforeFirstStop + clients.length ? stopCalls.length : null),
    2000,
    "first takeover onStop calls"
  );
  pass("isolated-world double-click stop path invoked onStop for all active sessions", {
    expected: clients.length,
    actual: stopCalls.length - beforeFirstStop,
    pids: stopCalls.slice(beforeFirstStop).map((call) => call.pid)
  });

  manager.sync({
    enabled: true,
    ports: [
      {
        port: chrome.port,
        profileId: "stress-profile",
        profileName: "E2E Stress Profile",
        clients: []
      }
    ]
  });
  await waitForPageInjected(page.client, INJECTION_TIMEOUT_MS, "taken-over keepalive with no active clients");
  pass("taken-over keepalive preserved the overlay after clients dropped", {
    stopCalls: stopCalls.length
  });

  await activatePage(page);
  await clickOverlayStopButton(page.client);
  await delay(250);
  assert.equal(stopCalls.length, beforeFirstStop + clients.length, "taken-over overlay should not emit duplicate stop calls.");
  pass("taken-over state suppressed duplicate stop attempts during keepalive", {
    stopCalls: stopCalls.length
  });

  manager.sync({
    enabled: true,
    ports: [
      {
        port: chrome.port,
        profileId: "stress-profile",
        profileName: "E2E Stress Profile",
        clients: refreshClients(clients)
      }
    ]
  });
  await waitForPageInjected(page.client, INJECTION_TIMEOUT_MS, "same-session reconnect active recovery");

  const beforeSecondStop = stopCalls.length;
  await activatePage(page);
  await clickOverlayStopButton(page.client);
  await waitFor(
    () => (stopCalls.length === beforeSecondStop + clients.length ? stopCalls.length : null),
    2000,
    "second takeover after reconnect"
  );
  pass("same-session reconnect recovered active behavior; stop was accepted again", {
    expected: clients.length,
    actual: stopCalls.length - beforeSecondStop,
    totalStopCalls: stopCalls.length
  });
}

async function activatePage(page) {
  await browserClient.send("Target.activateTarget", { targetId: page.targetId }, 3000);
  await delay(100);
}

async function runDisposeScenario(pages) {
  log("Scenario dispose started.");
  if (typeof manager.dispose === "function") {
    await manager.dispose();
  } else {
    manager.sync({ enabled: false, ports: [] });
  }
  managerDisposed = true;

  await Promise.all(pages.map((page) => waitForOverlayRemoved(page.client, `tab ${page.index} dispose main world`)));
  await Promise.all(
    pages.map((page) =>
      waitForIsolatedCleared(page.client, page.contextId, `tab ${page.index} dispose isolated world`)
    )
  );

  assert.deepEqual(unhandledFailures, [], "No unhandled rejection should be recorded.");
  pass("dispose removed overlay DOM/globals with no unhandled failures", {
    tabs: pages.length,
    unhandledFailures: unhandledFailures.length
  });
}

function buildClients() {
  const now = Date.now();
  return [
    {
      pid: 53001,
      label: "agent-browser",
      agent: "Codex",
      project: "profilepilot",
      title: "Stress primary session",
      session: "cx-e2e-stress-primary",
      lastActive: new Date(now).toISOString()
    },
    {
      pid: 53002,
      label: "agent-browser",
      agent: "Claude Code",
      project: "profilepilot",
      title: "Stress secondary session",
      session: "cc-e2e-stress-secondary",
      lastActive: new Date(now - 1000).toISOString()
    }
  ];
}

function refreshClients(clients) {
  const now = Date.now();
  return clients.map((client, index) => ({
    ...client,
    lastActive: new Date(now - index * 1000).toISOString()
  }));
}

function assertMainWorldInjected(state, label) {
  assert.equal(state.host, true, `${label} should contain the overlay host DOM node.`);
  assert.equal(state.installedType, "undefined", `${label} main world must not expose __ppAgentOverlayInstalled.`);
  assert.equal(state.updateType, "undefined", `${label} main world must not expose __ppAgentOverlayUpdate.`);
  assert.equal(state.signalType, "undefined", `${label} main world must not expose __ppAgentOverlaySignal.`);
  assert.equal(state.teardownType, "undefined", `${label} main world must not expose __ppAgentOverlayTeardown.`);
}

function assertIsolatedWorldInstalled(state, label) {
  assert.equal(state.host, true, `${label} should see the overlay host DOM node.`);
  assert.equal(state.installed, true, `${label} should have the overlay installed flag.`);
  assert.equal(state.installedType, "boolean", `${label} should expose __ppAgentOverlayInstalled as boolean.`);
  assert.equal(state.updateType, "function", `${label} should expose __ppAgentOverlayUpdate.`);
  assert.equal(state.signalType, "function", `${label} should expose __ppAgentOverlaySignal.`);
  assert.equal(state.teardownType, "function", `${label} should expose __ppAgentOverlayTeardown.`);
}

function assertClearedState(state, label) {
  assert.equal(state.host, false, `${label} should not contain the overlay host DOM node.`);
  assert.equal(state.installed, false, `${label} should not have installed=true.`);
  assert.equal(state.installedType, "undefined", `${label} should clear __ppAgentOverlayInstalled.`);
  assert.equal(state.updateType, "undefined", `${label} should clear __ppAgentOverlayUpdate.`);
  assert.equal(state.signalType, "undefined", `${label} should clear __ppAgentOverlaySignal.`);
  assert.equal(state.teardownType, "undefined", `${label} should clear __ppAgentOverlayTeardown.`);
}

async function waitForInjectedTarget(port, targetId, timeoutMs, label) {
  let client = null;
  try {
    return await waitFor(async () => {
      const targets = await requestJson(port, "/json/list", 1000);
      const target = targets.find((item) => isInjectableTarget(item) && item.id === targetId);
      if (!target?.webSocketDebuggerUrl) {
        return null;
      }
      if (!client) {
        client = await CdpConnection.connect(target.webSocketDebuggerUrl, 1000);
      }
      const state = await overlayState(client).catch(() => null);
      return state?.host === true && state.updateType === "undefined" && state.signalType === "undefined"
        ? { target, client, state }
        : null;
    }, timeoutMs, label);
  } catch (error) {
    client?.close();
    throw error;
  }
}

async function waitForPageInjected(client, timeoutMs, label) {
  return waitFor(async () => {
    const state = await overlayState(client).catch(() => null);
    return state?.host === true && state.updateType === "undefined" && state.signalType === "undefined" ? state : null;
  }, timeoutMs, label);
}

async function waitForOverlayRemoved(client, label) {
  const state = await waitFor(async () => {
    const current = await overlayState(client).catch(() => null);
    return current && !current.host && current.updateType === "undefined" && current.signalType === "undefined"
      ? current
      : null;
  }, 4000, label);
  assertClearedState(state, label);
  return state;
}

async function waitForIsolatedCleared(client, contextId, label) {
  const state = await waitFor(async () => {
    const current = await overlayState(client, contextId).catch(() => null);
    return current && !current.host && current.updateType === "undefined" && current.signalType === "undefined"
      ? current
      : null;
  }, 4000, label);
  assertClearedState(state, label);
  return state;
}

async function overlayWorldContext(client, label) {
  const contexts = new Set();
  const previousOnEvent = client.onEvent;
  client.onEvent = (method, params) => {
    if (method === "Runtime.executionContextCreated") {
      const context = params?.context;
      if (context?.name === OVERLAY_WORLD_NAME && typeof context.id === "number") {
        contexts.add(context.id);
      }
    }
    previousOnEvent?.(method, params);
  };
  await client.send("Runtime.disable", {}, 1000).catch(() => undefined);
  await client.send("Runtime.enable", {}, 1000);
  const contextId = await waitFor(() => {
    const first = contexts.values().next();
    return first.done ? null : first.value;
  }, 3000, label);
  client.onEvent = previousOnEvent;
  return contextId;
}

function overlayState(client, contextId = undefined) {
  return evaluateValue(
    client,
    `(() => ({
      installed: window.__ppAgentOverlayInstalled === true,
      installedType: typeof window.__ppAgentOverlayInstalled,
      host: Boolean(document.getElementById("__pp-agent-overlay")),
      updateType: typeof window.__ppAgentOverlayUpdate,
      signalType: typeof window.__ppAgentOverlaySignal,
      teardownType: typeof window.__ppAgentOverlayTeardown
    }))()`,
    1000,
    contextId
  );
}

async function clickOverlayStopButton(client) {
  const rect = await evaluateValue(
    client,
    `(() => {
      const host = document.getElementById("__pp-agent-overlay");
      if (!host) {
        return null;
      }
      const rect = host.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    })()`,
    1000
  );
  assert.ok(rect && rect.width > 0 && rect.height > 0, "Overlay host should have a clickable rect.");
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height - 18);
  await dispatchMouseClick(client, x, y);
  await delay(90);
  await dispatchMouseClick(client, x, y);
}

async function dispatchMouseClick(client, x, y) {
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" }, 3000);
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, 3000);
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, 3000);
}

async function evaluateValue(client, expression, timeoutMs = 1000, contextId = undefined) {
  const params = {
    expression,
    awaitPromise: true,
    returnByValue: true
  };
  if (typeof contextId === "number") {
    params.contextId = contextId;
  }
  const response = await client.send("Runtime.evaluate", params, timeoutMs);
  if (response?.exceptionDetails) {
    throw new Error(`Runtime.evaluate failed: ${JSON.stringify(response.exceptionDetails)}`);
  }
  return response?.result?.value;
}

async function waitForManagerConnectionSample(port, before, label) {
  if (!before.available) {
    throw new Error(`Connection count baseline unavailable: ${before.error || "unknown error"}`);
  }
  return waitFor(async () => {
    const sample = await sampleEstablishedConnections(port);
    if (!sample.available) {
      throw new Error(`Connection count sample unavailable: ${sample.error || "unknown error"}`);
    }
    return sample.count === before.count + 1 ? sample : null;
  }, 5000, label);
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

async function launchChromeWithFallback() {
  const executable = await findChromeExecutable();
  const attempts = [
    { mode: "headless=new", headless: true },
    { mode: "headed", headless: false }
  ];
  const failures = [];

  for (const attempt of attempts) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pp-e2e-overlay-stress-"));
    const port = await findAvailablePort(START_PORT);
    const args = chromeArgs({ port, tempDir, headless: attempt.headless });
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

function chromeArgs({ port, tempDir, headless }) {
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
    TAB_URLS[0]
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

function dataUrl(id, text) {
  const html = `<!doctype html><meta charset="utf-8"><title>${id}</title><main id="${id}">${text}</main>`;
  return `data:text/html,${encodeURIComponent(html)}`;
}

function pass(message, data = undefined) {
  assertions.push({ message, data });
  console.log(`[assert] PASS ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);
}

function log(message) {
  console.log(`[stress] ${message}`);
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

await main();
