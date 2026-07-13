#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { delay, launchProfilePilotE2e } from "./e2e/lib/electron-driver.mjs";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const { requestBrowserGateway } = require("../dist/main/browser-gateway-client.js");

async function main() {
  const app = await launchProfilePilotE2e({
    realGateway: true,
    env: { CPM_E2E_MINI_SHORTCUT: "CommandOrControl+Shift+U" },
    timeoutMs: 20_000
  });
  const { driver, homeDir } = app;
  const port = await findAvailablePort(9530);
  let agentSocket = null;
  let profileId = null;
  try {
    profileId = await createProfile(driver, "E2E Gateway Profile");
    await driver.click(`[data-action="launch-cdp"][data-id="${profileId}"]`);
    await driver.waitFor("#cdp-port");
    await driver.fill("#cdp-port", String(port));
    await submitWithSystemEvents(driver, "#cdp-port");
    await driver.waitFor("[data-cdp-form]", (snapshot) => !snapshot.exists);
    await waitForGatewayProfile(homeDir, port, (profile) => profile.profileId === profileId);
    step(`Gateway launched Chrome through remote-debugging-pipe on logical port ${port}`);

    const sessionId = "cx-e2e-gateway-primary";
    const daemonInstanceId = "daemon-e2e-gateway-primary";
    const acquired = await gateway(homeDir, {
      action: "acquire",
      publicPort: port,
      sessionId,
      daemonInstanceId,
      daemonPid: process.pid,
      agent: "Codex",
      project: "profilepilot-e2e"
    });
    agentSocket = await CdpSocket.connect(acquired.webSocketUrl);
    const targets = await agentSocket.send("Target.getTargets", {});
    assert.ok(Array.isArray(targets.targetInfos), "Gateway WebSocket should proxy real CDP traffic");
    step("agent WebSocket connected and completed Target.getTargets through Gateway");

    await assert.rejects(
      gateway(homeDir, {
        action: "acquire",
        publicPort: port,
        sessionId: "cc-e2e-gateway-conflict",
        daemonInstanceId: "daemon-e2e-gateway-conflict",
        daemonPid: process.pid,
        agent: "Claude Code",
        project: "profilepilot-e2e"
      }),
      (error) => error?.code === "PROFILE_LEASE_CONFLICT"
    );
    step("a second Session was rejected by the real Profile lease");

    await driver.waitFor(`[data-action="takeover-agent"][data-id="${profileId}"]`, (snapshot) => snapshot.exists, {
      timeoutMs: 12_000
    });
    await driver.click(`[data-action="takeover-agent"][data-id="${profileId}"]`);
    await driver.waitFor('[data-action="confirm-modal-action"]');
    const socketClosed = agentSocket.waitForClose();
    await driver.click('[data-action="confirm-modal-action"]');
    await socketClosed;
    agentSocket = null;
    const delegated = await waitForGatewayProfile(
      homeDir,
      port,
      (profile) => profile.ownership === "user" && profile.sessionStatus === "active"
    );
    assert.equal(delegated.ownerSessionId, sessionId);
    step("user takeover revoked the live Agent WebSocket while retaining the Session lease");

    await gateway(homeDir, { action: "control", sessionId, command: "return" });
    const reacquired = await gateway(homeDir, {
      action: "acquire",
      publicPort: port,
      sessionId,
      daemonInstanceId,
      daemonPid: process.pid,
      agent: "Codex",
      project: "profilepilot-e2e"
    });
    agentSocket = await CdpSocket.connect(reacquired.webSocketUrl);
    const version = await agentSocket.send("Browser.getVersion", {});
    assert.match(String(version.product), /Chrome|Chromium/);
    step("return-to-Agent restored ownership and a new CDP WebSocket worked");

    await gateway(homeDir, { action: "control", sessionId, command: "stop" });
    await agentSocket.waitForClose();
    agentSocket = null;
    const stopped = await waitForGatewayProfile(homeDir, port, (profile) => profile.sessionStatus === "stopped");
    assert.equal(stopped.ownership, "user");
    step("terminal stop released active control and closed the connection");

  } catch (error) {
    const output = app.output();
    console.error(`[e2e:gateway] app stdout:\n${output.stdout}\n[e2e:gateway] app stderr:\n${output.stderr}`);
    throw error;
  } finally {
    agentSocket?.close();
    // Quit Electron first so its state coordinator cannot restart the isolated
    // daemon while the test is tearing it down.
    await app.stop({ removeFixture: false });
    await gateway(homeDir, { action: "unregister-profile", publicPort: port, closeChrome: true }).catch(() => undefined);
    await gateway(homeDir, { action: "shutdown" }).catch(() => undefined);
    await waitForFixtureProcessesExit(app.fixtureRoot);
    await rm(app.fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  step("PASS");
}

async function submitWithSystemEvents(driver, selector) {
  const appProcess = await driver.request("ping");
  await driver.focus(selector);
  await execFileAsync("/usr/bin/osascript", [
    "-e",
    `tell application \"System Events\" to tell first process whose unix id is ${appProcess.pid} to key code 36`
  ]);
}

async function createProfile(driver, name) {
  await driver.click('[data-action="new-profile"]');
  await driver.waitFor("#profile-name");
  await driver.fill("#profile-name", name);
  await driver.click('[data-create-form] button[type="submit"]');
  const row = await driver.waitFor("[data-profile-row]", (snapshot) => snapshot.text?.includes(name));
  return row.attributes["data-id"];
}

async function gateway(homeDir, request) {
  return requestBrowserGateway(request, { homeDir, timeoutMs: 10_000 });
}

async function waitForGatewayProfile(homeDir, port, predicate, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const status = await gateway(homeDir, { action: "status" });
      latest = status.state?.profiles?.find((profile) => profile.publicPort === port) || null;
      if (latest && predicate(latest)) return latest;
    } catch {
      // The daemon socket can be between startup/restart states; keep waiting.
    }
    await delay(80);
  }
  throw new Error(`Timed out waiting for Gateway profile ${port}: ${JSON.stringify(latest)}`);
}

class CdpSocket {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(new CdpSocket(socket)), { once: true });
      socket.addEventListener("error", () => reject(new Error(`Failed to connect Gateway WebSocket: ${url}`)), { once: true });
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.closeWaiters = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      this.closeWaiters.splice(0).forEach((resolve) => resolve());
      for (const waiter of this.pending.values()) waiter.reject(new Error("Gateway WebSocket closed."));
      this.pending.clear();
    });
  }

  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForClose() {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => this.closeWaiters.push(resolve));
  }

  close() {
    this.socket.close();
  }
}

async function findAvailablePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error(`No available port from ${start}`);
}

async function waitForFixtureProcessesExit(fixtureRoot, timeoutMs = 10_000) {
  const token = path.basename(fixtureRoot);
  const startedAt = Date.now();
  let processes = [];
  while (Date.now() - startedAt < timeoutMs) {
    processes = await processesContaining(token);
    if (!processes.length) return;
    await delay(100);
  }
  for (const processInfo of processes) {
    try { process.kill(processInfo.pid, "SIGTERM"); } catch { /* already exited */ }
  }
  await delay(500);
  for (const processInfo of await processesContaining(token)) {
    try { process.kill(processInfo.pid, "SIGKILL"); } catch { /* already exited */ }
  }
}

async function processesContaining(token) {
  const { stdout } = await execFileAsync("/bin/ps", ["axww", "-o", "pid=,command="]);
  return stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter((match) => match && match[2].includes(token))
    .map((match) => ({ pid: Number(match[1]), command: match[2] }));
}

function step(message) {
  console.log(`[e2e:gateway] ${message}`);
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(`[e2e:gateway] FAILED: ${error instanceof Error ? error.stack || error.message : String(error)}`);
});
