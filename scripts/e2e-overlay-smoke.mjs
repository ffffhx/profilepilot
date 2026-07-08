#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

const require = createRequire(import.meta.url);
const START_PORT = Number(process.env.PP_E2E_PORT_START || 9470);
const CHROME_READY_TIMEOUT_MS = 10000;
const INJECTION_TIMEOUT_MS = 5000;
const NEW_TAB_INJECTION_LIMIT_MS = 1000;
const OVERLAY_WORLD_NAME = "__ppAgentOverlayWorld";
const ROOT_URL = dataUrl("pp-e2e-root", "ProfilePilot overlay e2e root");
const SECOND_URL = dataUrl("pp-e2e-second", "ProfilePilot overlay e2e second tab");
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

let chrome = null;
let manager = null;
let browserClient = null;
let rootPageClient = null;
let secondPageClient = null;
let teardownRequested = false;

async function main() {
installWebSocketPolyfill();
try {
  const { AgentOverlayManager } = require("../dist/main/agent-overlay.js");
  assert.equal(typeof AgentOverlayManager, "function", "dist/main/agent-overlay.js must export AgentOverlayManager.");

  chrome = await launchChromeWithFallback();
  step(`Chrome launched on CDP port ${chrome.port} (${chrome.mode}).`);

  browserClient = await CdpConnection.connect(chrome.browserWsUrl, 5000);

  const stopCalls = [];
  manager = new AgentOverlayManager({
    onStop: async (request) => {
      stopCalls.push(request);
    }
  });

  const now = Date.now();
  const clients = [
    {
      pid: 52001,
      label: "agent-browser",
      agent: "Codex",
      project: "profilepilot",
      title: "E2E primary session",
      session: "cx-e2e-overlay-primary",
      lastActive: new Date(now).toISOString()
    },
    {
      pid: 52002,
      label: "agent-browser",
      agent: "Claude Code",
      project: "profilepilot",
      title: "E2E secondary session",
      session: "cc-e2e-overlay-secondary",
      lastActive: new Date(now - 1000).toISOString()
    }
  ];

  manager.sync({
    enabled: true,
    ports: [
      {
        port: chrome.port,
        profileId: "e2e-profile",
        profileName: "E2E Smoke Profile",
        clients
      }
    ]
  });
  step("AgentOverlayManager.sync enabled for the temporary browser.");

  const rootPage = await waitForInjectedTarget(
    chrome.port,
    (target) => target.url === ROOT_URL,
    INJECTION_TIMEOUT_MS,
    "root page overlay injection"
  );
  rootPageClient = rootPage.client;
  assert.equal(rootPage.state.signalType, "undefined", "Root page main world must not expose __ppAgentOverlaySignal.");
  assert.equal(rootPage.state.installedType, "undefined", "Root page main world must not expose __ppAgentOverlayInstalled.");
  assert.equal(rootPage.state.updateType, "undefined", "Root page main world must not expose __ppAgentOverlayUpdate.");
  assert.equal(rootPage.state.host, true, "Root page should contain the overlay host DOM node.");
  step("Root page main world has no overlay globals, while the overlay host DOM is visible.");

  const rootOverlayContextId = await waitForOverlayWorldContext(rootPageClient, "root page isolated overlay world");
  const isolatedGlobals = await overlayState(rootPageClient, rootOverlayContextId);
  assert.equal(isolatedGlobals.installed, true, "Root isolated world should have the overlay installed flag.");
  assert.equal(isolatedGlobals.signalType, "function", "Root isolated world should expose the CDP binding.");
  assert.equal(isolatedGlobals.updateType, "function", "Root isolated world should expose the update function.");
  step(`Root isolated world context ${rootOverlayContextId} has the overlay binding and controls.`);

  const pushed = await evaluateValue(
    rootPageClient,
    `(() => {
      const payload = ${safeJsonSource(buildOverlayPayload())};
      if (typeof window.__ppAgentOverlayUpdate !== "function") {
        return { updated: false, updateType: typeof window.__ppAgentOverlayUpdate };
      }
      window.__ppAgentOverlayUpdate(payload);
      return {
        updated: true,
        installed: window.__ppAgentOverlayInstalled === true,
        updateType: typeof window.__ppAgentOverlayUpdate,
        signalType: typeof window.__ppAgentOverlaySignal,
        host: Boolean(document.getElementById("__pp-agent-overlay"))
      };
    })()`,
    1000,
    rootOverlayContextId
  );
  assert.deepEqual(pushed, {
    updated: true,
    installed: true,
    updateType: "function",
    signalType: "function",
    host: true
  });
  step("Pushed a todo + multi-session payload through the isolated world update function.");

  const forged = await evaluateValue(
    rootPageClient,
    `(() => {
      const signal = window.__ppAgentOverlaySignal;
      let invoked = false;
      try {
        if (typeof signal === "function") {
          signal(JSON.stringify({ action: "stop" }));
          invoked = true;
        }
      } catch {
        invoked = true;
      }
      return {
        invoked,
        signalType: typeof window.__ppAgentOverlaySignal,
        installedType: typeof window.__ppAgentOverlayInstalled,
        updateType: typeof window.__ppAgentOverlayUpdate,
        teardownType: typeof window.__ppAgentOverlayTeardown
      };
    })()`,
    1000
  );
  assert.deepEqual(forged, {
    invoked: false,
    signalType: "undefined",
    installedType: "undefined",
    updateType: "undefined",
    teardownType: "undefined"
  });
  await delay(250);
  assert.equal(stopCalls.length, 0, "Main-world forged stop signal must not trigger onStop.");
  step("Main-world forged stop attempt could not see the binding and did not call onStop.");

  await clickOverlayStopButton(rootPageClient);
  await waitFor(() => (stopCalls.length === 1 ? stopCalls.length : null), 1500, "isolated overlay button stop path");
  assert.equal(stopCalls[0].stopAll, true);
  assert.equal(stopCalls[0].pids, undefined);
  assert.ok(clients.some((client) => client.pid === stopCalls[0].pid), "stop-all request should reference an active driver pid.");
  step("Isolated-world overlay button path requested stop-all for active sessions.");

  const callsAfterFirstSignal = stopCalls.length;
  const repeatedForgery = await evaluateValue(
    rootPageClient,
    `(() => {
      const signal = window.__ppAgentOverlaySignal;
      if (typeof signal === "function") {
        signal(JSON.stringify({ action: "stop" }));
        return true;
      }
      return false;
    })()`,
    1000
  );
  assert.equal(repeatedForgery, false, "Main world should still not have a signal function after takeover.");
  await delay(200);
  assert.equal(
    stopCalls.length,
    callsAfterFirstSignal,
    "A repeated main-world forged stop signal should not call onStop."
  );
  step("Main-world forged stop remained inert after the legitimate isolated-world takeover.");

  const secondStart = performance.now();
  const created = await browserClient.send("Target.createTarget", { url: SECOND_URL }, 5000);
  assert.equal(typeof created?.targetId, "string", "Target.createTarget should return a targetId.");
  const secondPage = await waitForInjectedTarget(
    chrome.port,
    (target) => target.id === created.targetId,
    NEW_TAB_INJECTION_LIMIT_MS,
    "new tab overlay injection"
  );
  secondPageClient = secondPage.client;
  const secondElapsedMs = Math.round(performance.now() - secondStart);
  assert.ok(
    secondElapsedMs < NEW_TAB_INJECTION_LIMIT_MS,
    `New tab overlay injection should complete under ${NEW_TAB_INJECTION_LIMIT_MS}ms; got ${secondElapsedMs}ms.`
  );
  step(`New tab overlay injection completed in ${secondElapsedMs}ms.`);

  manager.sync({ enabled: false, ports: [] });
  teardownRequested = true;
  await Promise.all([
    waitForOverlayRemoved(rootPageClient, "root page overlay teardown"),
    waitForOverlayRemoved(secondPageClient, "second page overlay teardown")
  ]);
  step("Teardown removed overlay DOM and globals from both pages.");

  step("PASS");
} catch (error) {
  process.exitCode = 1;
  console.error(`[e2e] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
} finally {
  if (manager && !teardownRequested) {
    try {
      manager.sync({ enabled: false, ports: [] });
    } catch {
      // Continue cleanup.
    }
  }

  rootPageClient?.close();
  secondPageClient?.close();

  if (browserClient) {
    try {
      await browserClient.send("Browser.close", {}, 1000);
    } catch {
      // The browser may already be closed.
    }
    browserClient.close();
  }

  if (chrome) {
    await terminateProcess(chrome.child);
    await rm(chrome.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
}

function step(message) {
  console.log(`[e2e] ${message}`);
}

function buildOverlayPayload() {
  const now = Date.now();
  return {
    state: "active",
    profileName: "E2E Smoke Profile",
    agent: "Codex",
    project: "profilepilot",
    session: "cx-e2e-overlay-primary",
    sessionTitle: "E2E primary session",
    currentAction: "Running overlay smoke checks",
    currentStep: "Push todo payload",
    nextStep: "Verify second tab injection",
    todoDone: 1,
    todoTotal: 3,
    lastMessage: "E2E payload delivered",
    updatedAt: new Date(now).toISOString(),
    startedAt: new Date(now - 45000).toISOString(),
    sessions: [
      {
        agent: "Codex",
        project: "profilepilot",
        session: "cx-e2e-overlay-primary",
        sessionTitle: "E2E primary session",
        lastActive: new Date(now).toISOString(),
        startedAt: new Date(now - 45000).toISOString()
      },
      {
        agent: "Claude Code",
        project: "profilepilot",
        session: "cc-e2e-overlay-secondary",
        sessionTitle: "E2E secondary session",
        lastActive: new Date(now - 1000).toISOString(),
        startedAt: new Date(now - 30000).toISOString()
      }
    ]
  };
}

async function launchChromeWithFallback() {
  const executable = await findChromeExecutable();
  const attempts = [
    { mode: "headless=new", headless: true },
    { mode: "headed", headless: false }
  ];
  const failures = [];

  for (const attempt of attempts) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pp-e2e-overlay-"));
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
      failures.push(`${attempt.mode}: ${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ""}`);
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
    ROOT_URL
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

async function waitForInjectedTarget(port, predicate, timeoutMs, label) {
  let client = null;
  let connectedTargetId = null;
  try {
    return await waitFor(async () => {
      const targets = await requestJson(port, "/json/list", 1000);
      const target = targets.find((item) => isInjectableTarget(item) && predicate(item));
      if (!target?.webSocketDebuggerUrl) {
        return null;
      }
      if (!client || connectedTargetId !== target.id) {
        client?.close();
        client = await CdpConnection.connect(target.webSocketDebuggerUrl, 500);
        connectedTargetId = target.id;
      }
      const state = await overlayState(client).catch(() => null);
      return state?.host === true && state?.signalType === "undefined" && state?.updateType === "undefined"
        ? { target, client, state }
        : null;
    }, timeoutMs, label);
  } catch (error) {
    client?.close();
    throw error;
  }
}

async function waitForOverlayRemoved(client, label) {
  await waitFor(async () => {
    const state = await overlayState(client).catch(() => null);
    return state && !state.installed && !state.host && state.updateType === "undefined" && state.teardownType === "undefined"
      ? state
      : null;
  }, 3000, label);
}

function overlayState(client, contextId = undefined) {
  return overlayStateInContext(client, contextId);
}

function overlayStateInContext(client, contextId) {
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
    500,
    contextId
  );
}

async function waitForOverlayWorldContext(client, label) {
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
  await client.send("Runtime.enable", {}, 1000);
  return waitFor(() => {
    const first = contexts.values().next();
    return first.done ? null : first.value;
  }, 3000, label);
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
  await delay(80);
  await dispatchMouseClick(client, x, y);
}

async function dispatchMouseClick(client, x, y) {
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" }, 1000);
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, 1000);
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, 1000);
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
  const response = await client.send(
    "Runtime.evaluate",
    params,
    timeoutMs
  );
  if (response?.exceptionDetails) {
    throw new Error(`Runtime.evaluate failed: ${JSON.stringify(response.exceptionDetails)}`);
  }
  return response?.result?.value;
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

function safeJsonSource(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
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

await main();
