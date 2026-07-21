#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { delay, repoRoot } from "./e2e/lib/electron-driver.mjs";

const require = createRequire(import.meta.url);
const {
  ensureBrowserGatewayDaemon,
  requestBrowserGateway
} = require("../dist/main/browser-gateway-client.js");
const { getDirectChromeCommand } = require("../dist/main/chrome-launch.js");

const PLAYWRIGHT_WRAPPER = path.join(repoRoot, "dist", "main", "profilepilot-playwright-cli-wrapper.cjs");
const MCP_WRAPPER = path.join(repoRoot, "dist", "main", "profilepilot-chrome-devtools-mcp-wrapper.cjs");

async function main() {
  const playwrightExecutable = findRealExecutable("playwright-cli");
  const mcpExecutable = findRealExecutable("chrome-devtools-mcp");
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "pp-drivers-e2e-"));
  const homeDir = path.join(fixtureRoot, "home");
  const dataDir = path.join(fixtureRoot, "profilepilot-data");
  const userDataDir = path.join(dataDir, "profiles", "browser-drivers");
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(userDataDir, { recursive: true })
  ]);
  const port = await findAvailablePort(9630);
  const profileId = "isolated:e2e-browser-drivers";
  const playwrightSession = "pw-profilepilot-e2e";
  const playwrightGatewaySession = "cx-profilepilot-e2e-playwright";
  const mcpGatewaySession = "cx-profilepilot-e2e-mcp";
  const commonEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    CPM_DATA_DIR: dataDir,
    PWD: fixtureRoot
  };
  const playwrightEnv = {
    ...commonEnv,
    PROFILEPILOT_SESSION: playwrightGatewaySession,
    PROFILEPILOT_PLAYWRIGHT_CLI_REAL: playwrightExecutable
  };
  let mcp = null;
  let chromePid = null;

  try {
    await ensureBrowserGatewayDaemon({ homeDir });
    const chromeExecutable = getDirectChromeCommand(commonEnv);
    assert.ok(chromeExecutable, "Chrome executable is required for the real driver E2E");
    await gateway(homeDir, {
      action: "launch-profile",
      profileId,
      profileName: "E2E Browser Drivers",
      publicPort: port,
      executable: chromeExecutable,
      args: [
        `--user-data-dir=${userDataDir}`,
        "--no-first-run"
      ]
    });
    const launched = await waitForGatewayProfile(
      homeDir,
      port,
      (profile) => profile.profileId === profileId && Number.isInteger(profile.chromePid)
    );
    chromePid = launched.chromePid;
    step(`temporary Profile is running on logical port ${port}`);

    await verifyPlaywrightDriver({
      homeDir,
      port,
      env: playwrightEnv,
      playwrightSession,
      gatewaySession: playwrightGatewaySession
    });

    mcp = await verifyChromeDevtoolsMcpDriver({
      homeDir,
      port,
      env: {
        ...commonEnv,
        PROFILEPILOT_CHROME_DEVTOOLS_MCP_REAL: mcpExecutable,
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
        CI: "1"
      },
      gatewaySession: mcpGatewaySession
    });
    await mcp.close();
    mcp = null;
    await waitForGatewayProfile(
      homeDir,
      port,
      (profile) => profile.sessionStatus === "stopped" && profile.ownership === "user"
    );
    step("Chrome DevTools MCP exited and released only its Gateway Session");
  } catch (error) {
    const status = await gateway(homeDir, { action: "status" }).catch((gatewayError) => ({
      gatewayError: gatewayError instanceof Error ? gatewayError.message : String(gatewayError)
    }));
    console.error(`[e2e:browser-drivers] Gateway status:\n${JSON.stringify(status, null, 2)}`);
    if (mcp) {
      console.error(`[e2e:browser-drivers] MCP stderr:\n${mcp.stderr}`);
    }
    throw error;
  } finally {
    await mcp?.close().catch(() => undefined);
    await runWrapper(
      PLAYWRIGHT_WRAPPER,
      [`-s=${playwrightSession}`, "close"],
      playwrightEnv,
      8_000
    ).catch(() => undefined);
    await gateway(homeDir, {
      action: "control",
      sessionId: playwrightGatewaySession,
      command: "stop"
    }).catch(() => undefined);
    await gateway(homeDir, {
      action: "control",
      sessionId: mcpGatewaySession,
      command: "stop"
    }).catch(() => undefined);
    await gateway(homeDir, {
      action: "unregister-profile",
      publicPort: port,
      closeChrome: true
    }).catch(() => undefined);
    await gateway(homeDir, { action: "shutdown" }).catch(() => undefined);
    if (chromePid) await ensureProcessExit(chromePid);
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  step("PASS");
}

async function verifyPlaywrightDriver(input) {
  const attached = await runWrapper(
    PLAYWRIGHT_WRAPPER,
    [`-s=${input.playwrightSession}`, "--json", "attach", `--cdp=http://127.0.0.1:${input.port}`],
    input.env
  );
  assert.equal(attached.code, 0, `Playwright attach failed: ${attached.stderr || attached.stdout}`);
  const active = await waitForGatewayProfile(
    input.homeDir,
    input.port,
    (profile) => profile.driverKind === "playwright-cli" && profile.connectionActive === true
  );
  assert.equal(active.driverLabel, "Playwright CLI");

  const snapshot = await runWrapper(
    PLAYWRIGHT_WRAPPER,
    [`-s=${input.playwrightSession}`, "--json", "snapshot"],
    input.env
  );
  assert.equal(snapshot.code, 0, `Playwright snapshot failed: ${snapshot.stderr || snapshot.stdout}`);
  assert.ok(snapshot.stdout.trim(), "Playwright snapshot should return real page state");
  step("real Playwright CLI attached through a one-shot Gateway ticket and executed snapshot");

  await gateway(input.homeDir, {
    action: "control",
    sessionId: input.gatewaySession,
    command: "takeover",
    pendingUserAction: "E2E manual step"
  });
  const delegated = await waitForGatewayProfile(
    input.homeDir,
    input.port,
    (profile) => profile.ownership === "user" && profile.connectionActive === true
  );
  assert.equal(delegated.driverKind, "playwright-cli");

  const blocked = await runWrapper(
    PLAYWRIGHT_WRAPPER,
    [`-s=${input.playwrightSession}`, "snapshot"],
    input.env
  );
  assert.equal(blocked.code, 75);
  assert.match(blocked.stderr, /AGENT_USER_IN_CONTROL/);

  await gateway(input.homeDir, {
    action: "control",
    sessionId: input.gatewaySession,
    command: "return"
  });
  const resumed = await runWrapper(
    PLAYWRIGHT_WRAPPER,
    [`-s=${input.playwrightSession}`, "--json", "snapshot"],
    input.env
  );
  assert.equal(resumed.code, 0, `Playwright did not resume in place: ${resumed.stderr || resumed.stdout}`);
  step("Playwright CLI hard-stopped during takeover and resumed on the same persistent connection");

  const closed = await runWrapper(
    PLAYWRIGHT_WRAPPER,
    [`-s=${input.playwrightSession}`, "close"],
    input.env
  );
  assert.equal(closed.code, 0, `Playwright close failed: ${closed.stderr || closed.stdout}`);
  await waitForGatewayProfile(
    input.homeDir,
    input.port,
    (profile) => profile.sessionStatus === "stopped" && profile.ownership === "user"
  );
  step("Playwright CLI close released its Gateway Session without closing Chrome");
}

async function verifyChromeDevtoolsMcpDriver(input) {
  const client = new JsonRpcStdioClient(
    process.execPath,
    [
      MCP_WRAPPER,
      `--profilepilot-port=${input.port}`,
      `--profilepilot-session=${input.gatewaySession}`,
      "--no-usage-statistics"
    ],
    input.env
  );
  await client.request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "profilepilot-e2e", version: "1.0.0" }
  });
  client.notify("notifications/initialized", {});
  const listed = await client.request("tools/list", {});
  const tools = Array.isArray(listed.tools) ? listed.tools : [];
  assert.ok(tools.some((tool) => tool.name === "list_pages"));
  assert.ok(tools.some((tool) => tool.name === "evaluate_script"));

  const pages = await client.callTool("list_pages", {});
  assert.notEqual(pages.isError, true, JSON.stringify(pages));
  const active = await waitForGatewayProfile(
    input.homeDir,
    input.port,
    (profile) => profile.driverKind === "chrome-devtools-mcp" && profile.connectionActive === true
  );
  assert.equal(active.driverLabel, "Chrome DevTools MCP");
  step("real Chrome DevTools MCP listed pages through a one-shot Gateway ticket");

  await gateway(input.homeDir, {
    action: "control",
    sessionId: input.gatewaySession,
    command: "takeover",
    pendingUserAction: "E2E manual step"
  });
  await waitForGatewayProfile(
    input.homeDir,
    input.port,
    (profile) => profile.ownership === "user" && profile.connectionActive === true
  );
  let blockedText = "";
  try {
    const blocked = await client.callTool("evaluate_script", { function: "() => document.title" });
    assert.equal(blocked.isError, true, "MCP browser calls must fail while the user owns the Profile");
    blockedText = JSON.stringify(blocked);
  } catch (error) {
    blockedText = error instanceof Error ? error.message : String(error);
  }
  assert.match(blockedText, /AGENT_USER_IN_CONTROL/);

  await gateway(input.homeDir, {
    action: "control",
    sessionId: input.gatewaySession,
    command: "return"
  });
  const resumed = await client.callTool("evaluate_script", { function: "() => document.title" });
  assert.notEqual(resumed.isError, true, JSON.stringify(resumed));
  step("Chrome DevTools MCP stayed parked during takeover and resumed on the same stdio/CDP process");
  return client;
}

class JsonRpcStdioClient {
  constructor(executable, args, env) {
    this.child = spawn(executable, args, {
      cwd: repoRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.closed = false;
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.exit = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        this.closed = true;
        const error = new Error(`MCP process exited before responding (code=${code}, signal=${signal})`);
        for (const waiter of this.pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
        this.pending.clear();
        resolve({ code, signal });
      });
    });
  }

  request(method, params, timeoutMs = 15_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}\n${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  callTool(name, args) {
    return this.request("tools/call", { name, arguments: args });
  }

  consume(chunk) {
    this.buffer += chunk;
    while (true) {
      const boundary = this.buffer.indexOf("\n");
      if (boundary < 0) return;
      const line = this.buffer.slice(0, boundary).trim();
      this.buffer = this.buffer.slice(boundary + 1);
      if (!line.startsWith("{")) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message.id !== "number") continue;
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) {
        const error = new Error(message.error.message || "MCP request failed");
        error.code = message.error.code;
        waiter.reject(error);
      } else {
        waiter.resolve(message.result);
      }
    }
  }

  async close() {
    if (this.closed) return;
    this.child.stdin.end();
    const exited = await Promise.race([
      this.exit.then(() => true),
      delay(5_000).then(() => false)
    ]);
    if (!exited && !this.closed) {
      this.child.kill("SIGTERM");
      await Promise.race([this.exit, delay(3_000)]);
    }
    if (!this.closed) this.child.kill("SIGKILL");
  }
}

async function runWrapper(wrapper, args, env, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapper, ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Wrapper timed out: ${path.basename(wrapper)} ${args.join(" ")}\n${stderr}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function ensureProcessExit(pid, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await delay(80);
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await delay(500);
  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGKILL");
  } catch {
    // Process already exited.
  }
}

function findRealExecutable(name) {
  const output = execFileSync("/usr/bin/which", ["-a", name], { encoding: "utf8" });
  const executable = output
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value && !value.includes(`${path.sep}.profilepilot${path.sep}bin${path.sep}`));
  if (!executable) throw new Error(`Cannot find real ${name} executable`);
  return executable;
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
      // Gateway can briefly restart while the disposable Profile is launching.
    }
    await delay(80);
  }
  throw new Error(`Timed out waiting for Gateway profile ${port}: ${JSON.stringify(latest)}`);
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

function step(message) {
  console.log(`[e2e:browser-drivers] ${message}`);
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(`[e2e:browser-drivers] FAILED: ${error instanceof Error ? error.stack || error.message : String(error)}`);
});
