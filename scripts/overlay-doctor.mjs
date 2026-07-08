#!/usr/bin/env node

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

const START_PORT = Number(process.env.PP_DOCTOR_PORT_START || 9505);
const CHROME_READY_TIMEOUT_MS = 10000;
const INJECTION_TIMEOUT_MS = 7000;
const HOST_SELF_HEAL_TIMEOUT_MS = 3000;
const TEARDOWN_TIMEOUT_MS = 3000;
const OVERLAY_WORLD_NAME = "__ppAgentOverlayWorld";
const HOST_ID = "__pp-agent-overlay";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OVERLAY_GLOBALS = [
  "__ppAgentOverlaySignal",
  "__ppAgentOverlayInstalled",
  "__ppAgentOverlayUpdate",
  "__ppAgentOverlayTeardown"
];

let chrome = null;
let manager = null;
let browserClient = null;
let pageClient = null;
let demoServers = null;
let teardownRequested = false;
const results = [];

async function main() {
  installWebSocketPolyfill();
  const args = parseArgs(process.argv.slice(2));
  printCapabilities(args);

  try {
    if (args.mode === "cdp") {
      await runReadOnlyCdpDiagnostics(args.port);
    } else {
      await runSelfStartedDiagnostics();
    }
  } catch (error) {
    process.exitCode = 1;
    console.error(`[doctor] ERROR ${formatError(error)}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
  } finally {
    await cleanup(args.mode);
  }

  if (results.length) {
    const passed = results.filter((result) => result.pass).length;
    log(`Summary: ${passed}/${results.length} passed.`);
    if (passed !== results.length) {
      process.exitCode = 1;
    }
  }
}

async function runSelfStartedDiagnostics() {
  const { AgentOverlayManager } = require("../dist/main/agent-overlay.js");
  if (typeof AgentOverlayManager !== "function") {
    throw new Error("dist/main/agent-overlay.js must export AgentOverlayManager.");
  }

  demoServers = await startDemoServers();
  log(`Demo page: ${demoServers.topUrl}`);
  log(`Cross-origin iframe: ${demoServers.frameUrl}`);

  chrome = await launchChrome(demoServers.topUrl);
  log(`Temporary headed Chrome launched on CDP port ${chrome.port}.`);

  browserClient = await CdpConnection.connect(chrome.browserWsUrl, 5000);
  const stopCalls = [];
  manager = new AgentOverlayManager({
    onStop: async (request) => {
      stopCalls.push({ ...request, at: Date.now() });
    }
  });

  const clients = buildDoctorClients();
  manager.sync({
    enabled: true,
    ports: [
      {
        port: chrome.port,
        profileId: "overlay-doctor-profile",
        profileName: "Overlay Doctor Profile",
        clients
      }
    ]
  });
  log("AgentOverlayManager.sync(enabled:true) started for the temporary browser.");

  const injected = await waitForInjectedTarget(
    chrome.port,
    (target) => normalizeUrl(target.url) === normalizeUrl(demoServers.topUrl),
    INJECTION_TIMEOUT_MS,
    "demo page overlay injection"
  );
  pageClient = injected.client;
  log(`Inspecting target ${injected.target.id} (${injected.target.url}).`);

  const overlayContextId = await waitForOverlayWorldContext(pageClient, "top-page isolated overlay world");

  await check("1. top main world overlay globals are isolated", async () => {
    const state = await overlayState(pageClient);
    const pass = globalsAreUndefined(state);
    return {
      pass,
      values: pickGlobalTypes(state)
    };
  });

  await check("2. top page host DOM is visible", async () => {
    const state = await overlayState(pageClient);
    const rect = await hostRect(pageClient);
    return {
      pass: state.host === true && rect.width > 0 && rect.height > 0,
      values: { host: state.host, rect }
    };
  });

  await check("3. cross-origin iframe has no overlay host", async () => {
    const frames = await iframeOverlayStates(pageClient, { requireFrame: true });
    const leaking = frames.filter((frame) => frame.host === true);
    return {
      pass: frames.length > 0 && leaking.length === 0,
      values: {
        framesChecked: frames.length,
        leakingFrames: leaking.map((frame) => ({ frameId: frame.frameId, url: frame.url }))
      }
    };
  });

  await check("4. main-world forged stop does not call onStop", async () => {
    const before = stopCalls.length;
    const forged = await forgeMainWorldStop(pageClient, { readonly: false });
    await delay(250);
    const after = stopCalls.length;
    return {
      pass: forged.invoked === false && before === after,
      values: { ...forged, stopCallsBefore: before, stopCallsAfter: after }
    };
  });

  await check("5. deleted host self-heals", async () => {
    const removed = await evaluateValue(
      pageClient,
      `(() => {
        const host = document.getElementById(${json(HOST_ID)});
        if (!host) return { removed: false, hostBefore: false };
        host.remove();
        return { removed: !document.getElementById(${json(HOST_ID)}), hostBefore: true };
      })()`,
      1000
    );
    const started = performance.now();
    const healedState = await waitFor(async () => {
      const state = await overlayState(pageClient);
      return state.host ? state : null;
    }, HOST_SELF_HEAL_TIMEOUT_MS, "host self-heal after DOM removal");
    const healedAfterMs = Math.round(performance.now() - started);
    return {
      pass: removed.hostBefore === true && removed.removed === true && healedState.host === true,
      values: { ...removed, healedAfterMs, host: healedState.host }
    };
  });

  await check("6. isolated-world button path triggers onStop", async () => {
    await clickOverlayStopButton(pageClient);
    await waitFor(
      () => (stopCalls.length >= clients.length ? stopCalls.length : null),
      1500,
      "isolated overlay stop button path"
    );
    const expectedPids = clients.map((client) => client.pid).sort((left, right) => left - right);
    const actualPids = stopCalls.map((call) => call.pid).sort((left, right) => left - right);
    return {
      pass: arraysEqual(actualPids, expectedPids),
      values: { stopCalls: stopCalls.length, actualPids, expectedPids }
    };
  });

  await check("7. teardown clears host and overlay globals", async () => {
    manager.sync({ enabled: false, ports: [] });
    teardownRequested = true;
    const mainState = await waitForOverlayRemoved(pageClient, "top page teardown");
    const isolatedState = await waitForIsolatedOverlayCleared(
      pageClient,
      overlayContextId,
      "isolated world teardown"
    );
    return {
      pass: mainState.host === false && globalsAreUndefined(mainState) && isolatedState.host === false && globalsAreUndefined(isolatedState),
      values: {
        main: summarizeOverlayState(mainState),
        isolated: summarizeOverlayState(isolatedState)
      }
    };
  });
}

async function runReadOnlyCdpDiagnostics(port) {
  log(`Connecting to existing Chrome on CDP port ${port} in read-only mode.`);
  const version = await requestJson(port, "/json/version", 1000);
  log(`Browser: ${version.Browser || "unknown"}`);

  const targets = (await requestJson(port, "/json/list", 1000)).filter(isInjectableTarget);
  if (!targets.length) {
    throw new Error(`No inspectable page targets found on 127.0.0.1:${port}.`);
  }
  log(`Inspecting ${targets.length} page target(s); no manager injection, clicks, DOM deletion, teardown, or browser close will be performed.`);

  const snapshots = [];
  for (const target of targets) {
    const client = await CdpConnection.connect(target.webSocketDebuggerUrl, 2000);
    try {
      const state = await overlayState(client);
      const frames = await iframeOverlayStates(client, { requireFrame: false }).catch((error) => [
        { error: formatError(error), frameId: null, url: null, host: null }
      ]);
      const forged = await forgeMainWorldStop(client, { readonly: true });
      snapshots.push({ target, state, frames, forged });
    } finally {
      client.close();
    }
  }

  await check("1. top main world overlay globals are isolated", async () => {
    const failing = snapshots.filter((snapshot) => !globalsAreUndefined(snapshot.state));
    return {
      pass: failing.length === 0,
      values: {
        targets: snapshots.length,
        failing: failing.map(targetSummary)
      }
    };
  });

  await check("2. top page host DOM is visible", async () => {
    const missing = snapshots.filter((snapshot) => snapshot.state.host !== true);
    return {
      pass: missing.length === 0,
      values: {
        targets: snapshots.length,
        missing: missing.map(targetSummary)
      }
    };
  });

  await check("3. child frames have no overlay host", async () => {
    const frames = snapshots.flatMap((snapshot) =>
      snapshot.frames.map((frame) => ({ ...frame, targetId: snapshot.target.id, targetUrl: snapshot.target.url }))
    );
    const leaking = frames.filter((frame) => frame.host === true);
    return {
      pass: leaking.length === 0,
      values: {
        framesChecked: frames.filter((frame) => typeof frame.host === "boolean").length,
        frameReadErrors: frames.filter((frame) => frame.error).length,
        leakingFrames: leaking.map((frame) => ({
          targetId: frame.targetId,
          frameId: frame.frameId,
          url: frame.url
        }))
      }
    };
  });

  await check("4. main-world forged stop cannot trigger from page", async () => {
    const failing = snapshots.filter((snapshot) => snapshot.forged.signalType === "function");
    return {
      pass: failing.length === 0,
      values: {
        readonly: true,
        invoked: false,
        failing: failing.map((snapshot) => ({
          ...targetSummary(snapshot),
          signalType: snapshot.forged.signalType
        }))
      }
    };
  });
}

async function check(name, run) {
  try {
    const result = await run();
    const pass = result.pass === true;
    results.push({ name, pass });
    log(`${pass ? "PASS" : "FAIL"} ${name} ${formatValues(result.values)}`);
  } catch (error) {
    results.push({ name, pass: false });
    log(`FAIL ${name} ${formatValues({ error: formatError(error) })}`);
  }
}

function printCapabilities(args) {
  log("Overlay Doctor");
  log("Checks overlay isolation, host visibility, iframe leakage, forged stop safety, self-heal, takeover, and teardown.");
  if (args.mode === "cdp") {
    log("--cdp mode is read-only for existing Chrome: inspect only, no manager injection, no clicks, no DOM mutation, no teardown, no browser close.");
  } else {
    log("self-start mode launches a temporary headed Chrome profile and cleans it up after diagnostics.");
  }
}

function parseArgs(argv) {
  if (argv.length === 0) {
    return { mode: "self" };
  }
  if (argv.length === 1 && (argv[0] === "-h" || argv[0] === "--help")) {
    console.log("Usage: node scripts/overlay-doctor.mjs [--cdp <port>]");
    process.exit(0);
  }
  if (argv.length === 2 && argv[0] === "--cdp") {
    const port = Number(argv[1]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error("--cdp port must be an integer between 1024 and 65535.");
    }
    return { mode: "cdp", port };
  }
  throw new Error("Usage: node scripts/overlay-doctor.mjs [--cdp <port>]");
}

async function startDemoServers() {
  const frameServer = await listenHttp((request, response) => {
    if (request.url !== "/frame.html") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Overlay Doctor Frame</title></head>
<body>
  <main id="frame-root">Overlay Doctor cross-origin iframe target</main>
</body>
</html>`);
  });
  const frameUrl = `http://127.0.0.1:${frameServer.port}/frame.html`;

  const topServer = await listenHttp((request, response) => {
    if (request.url !== "/") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Overlay Doctor Demo</title>
  <style>
    body { margin: 32px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    iframe { width: 520px; height: 180px; border: 1px solid #b8c2cc; }
  </style>
</head>
<body>
  <main>
    <h1>Overlay Doctor Demo Page</h1>
    <p id="doctor-text">This page is temporary and exists only for overlay diagnostics.</p>
    <iframe id="doctor-frame" src="${escapeHtml(frameUrl)}"></iframe>
  </main>
</body>
</html>`);
  });

  const topUrl = `http://127.0.0.1:${topServer.port}/`;
  return {
    topUrl,
    frameUrl,
    close: async () => {
      await Promise.allSettled([closeServer(topServer.server), closeServer(frameServer.server)]);
    }
  };
}

function listenHttp(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("HTTP server did not expose a TCP port."));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function launchChrome(url) {
  const executable = await findChromeExecutable();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pp-overlay-doctor-"));
  const port = await findAvailablePort(START_PORT);
  const args = chromeArgs({ port, tempDir, url });
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
    if (!version.webSocketDebuggerUrl) {
      throw new Error("Chrome /json/version did not include webSocketDebuggerUrl.");
    }
    return {
      child,
      tempDir,
      port,
      browserWsUrl: version.webSocketDebuggerUrl
    };
  } catch (error) {
    await terminateProcess(child);
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    const detail = stderr ? `\nChrome stderr:\n${stderr}` : "";
    throw new Error(`${formatError(error)}${detail}`);
  }
}

function chromeArgs({ port, tempDir, url }) {
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
    url
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
    if (candidate && await isExecutable(candidate)) {
      return candidate;
    }
  }
  throw new Error("Could not find Chrome or Chromium. Set CHROME_PATH to override.");
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
    const error = spawnError();
    if (error) {
      throw error;
    }
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited before CDP became ready, exit code ${child.exitCode}.`);
    }
    try {
      return await requestJson(port, "/json/version", 1000);
    } catch (requestError) {
      lastError = requestError;
      await delay(100);
    }
  }
  throw new Error(`Timed out waiting for Chrome CDP on 127.0.0.1:${port}.${lastError instanceof Error ? ` Last error: ${lastError.message}` : ""}`);
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
      return state?.host === true && globalsAreUndefined(state)
        ? { target, client, state }
        : null;
    }, timeoutMs, label);
  } catch (error) {
    client?.close();
    throw error;
  }
}

async function waitForOverlayWorldContext(client, label) {
  const contexts = new Set();
  for (const context of client.contexts.values()) {
    if (context.name === OVERLAY_WORLD_NAME) {
      contexts.add(context.id);
    }
  }
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
  try {
    return await waitFor(() => {
      const first = contexts.values().next();
      return first.done ? null : first.value;
    }, 3000, label);
  } finally {
    client.onEvent = previousOnEvent;
  }
}

function overlayState(client, contextId = undefined) {
  return evaluateValue(
    client,
    `(() => ({
      installed: window.__ppAgentOverlayInstalled === true,
      installedType: typeof window.__ppAgentOverlayInstalled,
      host: Boolean(document.getElementById(${json(HOST_ID)})),
      updateType: typeof window.__ppAgentOverlayUpdate,
      signalType: typeof window.__ppAgentOverlaySignal,
      teardownType: typeof window.__ppAgentOverlayTeardown
    }))()`,
    1000,
    contextId
  );
}

async function iframeOverlayStates(client, { requireFrame }) {
  await client.send("Page.enable", {}, 1000).catch(() => undefined);
  const frameTree = await client.send("Page.getFrameTree", {}, 1000);
  const frames = collectFrames(frameTree?.frameTree).filter((frame) => frame.parentId);
  if (!frames.length && requireFrame) {
    throw new Error("No child iframe was found in Page.getFrameTree.");
  }

  const contexts = await collectExecutionContexts(client);
  const frameById = new Map(frames.map((frame) => [frame.id, frame]));
  const defaultContexts = contexts.filter((context) => {
    if (!context.frameId || !frameById.has(context.frameId)) {
      return false;
    }
    return context.isDefault || context.name === "";
  });

  if (!defaultContexts.length && requireFrame) {
    throw new Error(`No default execution context was found for ${frames.length} child iframe(s).`);
  }

  const states = [];
  for (const context of defaultContexts) {
    const state = await evaluateValue(
      client,
      `(() => ({ host: Boolean(document.getElementById(${json(HOST_ID)})) }))()`,
      1000,
      context.id
    );
    states.push({
      frameId: context.frameId,
      url: frameById.get(context.frameId)?.url || "",
      contextId: context.id,
      host: state.host === true
    });
  }
  return states;
}

async function collectExecutionContexts(client) {
  const previousOnEvent = client.onEvent;
  client.onEvent = (method, params) => {
    previousOnEvent?.(method, params);
  };
  try {
    await client.send("Runtime.enable", {}, 1000);
    await delay(120);
  } finally {
    client.onEvent = previousOnEvent;
  }
  return [...client.contexts.values()];
}

function collectFrames(node, parentId = "") {
  if (!node?.frame) {
    return [];
  }
  const frame = {
    id: node.frame.id,
    parentId: node.frame.parentId || parentId || "",
    url: node.frame.url || ""
  };
  return [frame, ...(node.childFrames || []).flatMap((child) => collectFrames(child, frame.id))];
}

function forgeMainWorldStop(client, { readonly }) {
  return evaluateValue(
    client,
    `(() => {
      const signal = window.__ppAgentOverlaySignal;
      const result = {
        readonly: ${readonly ? "true" : "false"},
        invoked: false,
        signalType: typeof signal,
        installedType: typeof window.__ppAgentOverlayInstalled,
        updateType: typeof window.__ppAgentOverlayUpdate,
        teardownType: typeof window.__ppAgentOverlayTeardown
      };
      if (${readonly ? "true" : "false"}) {
        result.reason = signal === undefined ? "binding absent" : "not invoked in read-only mode";
        return result;
      }
      if (typeof signal === "function") {
        try {
          signal(JSON.stringify({ action: "stop" }));
          result.invoked = true;
        } catch (error) {
          result.invoked = true;
          result.error = String(error && error.message ? error.message : error);
        }
      }
      return result;
    })()`,
    1000
  );
}

async function hostRect(client) {
  const rect = await evaluateValue(
    client,
    `(() => {
      const host = document.getElementById(${json(HOST_ID)});
      if (!host) return { left: 0, top: 0, width: 0, height: 0 };
      const rect = host.getBoundingClientRect();
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    })()`,
    1000
  );
  return rect || { left: 0, top: 0, width: 0, height: 0 };
}

async function clickOverlayStopButton(client) {
  const rect = await hostRect(client);
  if (!rect.width || !rect.height) {
    throw new Error("Overlay host does not have a clickable rectangle.");
  }
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

async function waitForOverlayRemoved(client, label) {
  return waitFor(async () => {
    const state = await overlayState(client).catch(() => null);
    return state && state.host === false && globalsAreUndefined(state) ? state : null;
  }, TEARDOWN_TIMEOUT_MS, label);
}

async function waitForIsolatedOverlayCleared(client, contextId, label) {
  return waitFor(async () => {
    const state = await overlayState(client, contextId).catch((error) => {
      if (/Cannot find context|Cannot find object|context/i.test(formatError(error))) {
        return {
          installed: false,
          installedType: "undefined",
          host: false,
          updateType: "undefined",
          signalType: "undefined",
          teardownType: "undefined"
        };
      }
      return null;
    });
    return state && state.host === false && globalsAreUndefined(state) ? state : null;
  }, TEARDOWN_TIMEOUT_MS, label);
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

function buildDoctorClients() {
  const now = Date.now();
  return [
    {
      pid: 53001,
      label: "agent-browser",
      agent: "Codex",
      project: "profilepilot",
      title: "Overlay Doctor primary session",
      session: "doctor-primary",
      lastActive: new Date(now).toISOString()
    },
    {
      pid: 53002,
      label: "agent-browser",
      agent: "Claude Code",
      project: "profilepilot",
      title: "Overlay Doctor secondary session",
      session: "doctor-secondary",
      lastActive: new Date(now - 1000).toISOString()
    }
  ];
}

function globalsAreUndefined(state) {
  return state?.signalType === "undefined" &&
    state?.installedType === "undefined" &&
    state?.updateType === "undefined" &&
    state?.teardownType === "undefined";
}

function pickGlobalTypes(state) {
  return {
    signalType: state?.signalType,
    installedType: state?.installedType,
    updateType: state?.updateType,
    teardownType: state?.teardownType
  };
}

function summarizeOverlayState(state) {
  return {
    host: state.host,
    ...pickGlobalTypes(state)
  };
}

function targetSummary(snapshot) {
  return {
    id: snapshot.target.id,
    url: snapshot.target.url,
    globals: pickGlobalTypes(snapshot.state),
    host: snapshot.state.host
  };
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

async function waitFor(checkFn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await checkFn();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.${lastError instanceof Error ? ` Last error: ${lastError.message}` : ""}`);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function cleanup(mode) {
  if (manager && !teardownRequested) {
    try {
      manager.sync({ enabled: false, ports: [] });
    } catch {
      // Continue cleanup.
    }
  }
  pageClient?.close();

  if (browserClient) {
    if (mode !== "cdp") {
      try {
        await browserClient.send("Browser.close", {}, 1000);
      } catch {
        // Chrome may already be closed.
      }
    }
    browserClient.close();
  }

  if (chrome) {
    await terminateProcess(chrome.child);
    await rm(chrome.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
  if (demoServers) {
    await demoServers.close().catch(() => undefined);
  }
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

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatValues(values) {
  if (values === undefined) {
    return "";
  }
  return `| ${JSON.stringify(values)}`;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function json(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function log(message) {
  console.log(`[doctor] ${message}`);
}

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.contexts = new Map();
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
      this.trackEvent(parsed.method, parsed.params);
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

  trackEvent(method, params) {
    if (method === "Runtime.executionContextCreated") {
      const context = params?.context;
      if (context && typeof context.id === "number") {
        const auxData = context.auxData || {};
        this.contexts.set(context.id, {
          id: context.id,
          name: typeof context.name === "string" ? context.name : "",
          frameId: typeof auxData.frameId === "string" ? auxData.frameId : "",
          isDefault: auxData.isDefault === true
        });
      }
      return;
    }
    if (method === "Runtime.executionContextDestroyed" && typeof params?.executionContextId === "number") {
      this.contexts.delete(params.executionContextId);
      return;
    }
    if (method === "Runtime.executionContextsCleared") {
      this.contexts.clear();
    }
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
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | length;
    } else if (length <= 0xffff) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    const mask = randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      masked[index] = payload[index] ^ mask[index % 4];
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) || []) {
      try {
        listener(event);
      } catch {
        // Browser WebSocket event listeners do not throw through the dispatcher.
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
  const output = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    output[index] = payload[index] ^ mask[index % 4];
  }
  return output;
}

main();
