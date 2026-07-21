import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export class ElectronDriver {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.#consume(String(chunk)));
    socket.on("error", (error) => this.#rejectAll(error));
    socket.on("close", () => this.#rejectAll(new Error("Electron E2E driver socket closed.")));
  }

  request(command, payload = {}, timeoutMs = 10_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Electron E2E driver command timed out: ${command}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.write(`${JSON.stringify({ id, command, ...payload })}\n`);
    });
  }

  query(selector, options = {}) {
    return this.request("query", { target: options.target || "main", selector, index: options.index || 0 });
  }

  evaluate(expression, options = {}) {
    return this.request("evaluate", { target: options.target || "main", expression });
  }

  domClick(selector, options = {}) {
    return this.request("domClick", { target: options.target || "main", selector, index: options.index || 0 });
  }

  domInput(selector, value, options = {}) {
    return this.request("domInput", {
      target: options.target || "main",
      selector,
      index: options.index || 0,
      value,
      checked: options.checked
    });
  }

  dispatch(selector, eventType, eventInit = {}, options = {}) {
    return this.request("dispatch", {
      target: options.target || "main",
      selector,
      index: options.index || 0,
      eventType,
      eventInit
    });
  }

  click(selector, options = {}) {
    return this.request("click", { target: options.target || "main", selector, index: options.index || 0 });
  }

  fill(selector, text, options = {}) {
    return this.request("fill", { target: options.target || "main", selector, index: options.index || 0, text });
  }

  focus(selector, options = {}) {
    return this.request("focus", { target: options.target || "main", selector, index: options.index || 0 });
  }

  press(keyCode, options = {}) {
    return this.request("press", {
      target: options.target || "main",
      keyCode,
      modifiers: options.modifiers || []
    });
  }

  drag(selector, toX, toY, options = {}) {
    return this.request("drag", {
      target: options.target || "main",
      selector,
      index: options.index || 0,
      toX,
      toY
    });
  }

  windows() {
    return this.request("windows");
  }

  triggerMiniHotkeyHandler() {
    return this.request("triggerMiniHotkeyHandler");
  }

  activate(target = "main") {
    return this.request("activate", { target });
  }

  screenshot(target = "main") {
    return this.request("screenshot", { target }, 20_000);
  }

  compareScreenshot(baselinePngBase64, options = {}) {
    return this.request(
      "compareScreenshot",
      {
        target: options.target || "main",
        baselinePngBase64,
        channelTolerance: options.channelTolerance ?? 12,
        maxDifferentPixelRatio: options.maxDifferentPixelRatio ?? 0.002
      },
      20_000
    );
  }

  async waitFor(selector, predicate = (snapshot) => snapshot.exists, options = {}) {
    const timeoutMs = options.timeoutMs || 10_000;
    const startedAt = Date.now();
    let latest = null;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        latest = await this.query(selector, options);
        if (predicate(latest)) return latest;
      } catch {
        // The target window may be transitioning; keep waiting until the deadline.
      }
      await delay(options.intervalMs || 80);
    }
    throw new Error(`Timed out waiting for ${selector}; latest=${JSON.stringify(latest)}`);
  }

  close() {
    this.socket.end();
  }

  #consume(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const response = JSON.parse(line);
      const waiter = this.pending.get(response.id);
      if (!waiter) continue;
      this.pending.delete(response.id);
      clearTimeout(waiter.timeout);
      if (response.ok) waiter.resolve(response.result);
      else waiter.reject(new Error(response.error || "Electron E2E driver command failed."));
    }
  }

  #rejectAll(error) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.pending.clear();
  }
}

export async function launchProfilePilotE2e(options = {}) {
  const mode = options.mode || "background";
  if (mode === "desktop") {
    assertDesktopE2eAllowed(options.name || "desktop E2E");
  }

  // Browser Gateway adds `~/.profilepilot/gateway/control.sock` below HOME.
  // Keep the fixture prefix short enough for macOS' Unix socket path limit.
  const fixtureRoot = await mkdtemp(path.join(options.realGateway ? "/tmp" : os.tmpdir(), "pp-e2e-"));
  const homeDir = path.join(fixtureRoot, "home");
  const dataDir = path.join(fixtureRoot, "profilepilot-data");
  const electronDataDir = path.join(fixtureRoot, "electron-data");
  const socketPath = path.join(fixtureRoot, "driver.sock");
  await Promise.all([
    mkdir(path.join(homeDir, ".codex"), { recursive: true }),
    mkdir(path.join(homeDir, ".claude"), { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(electronDataDir, { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(homeDir, ".codex", "AGENTS.md"), "# ProfilePilot E2E fixture\n", "utf8"),
    writeFile(path.join(homeDir, ".claude", "CLAUDE.md"), "# ProfilePilot E2E reference\n", "utf8")
  ]);

  const child = spawn(electronPath, [repoRoot, `--user-data-dir=${electronDataDir}`], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CPM_DATA_DIR: dataDir,
      CPM_ELECTRON_SMOKE_TEST: options.realGateway ? "0" : "1",
      CPM_E2E_MODE: mode,
      CPM_E2E_DISPOSABLE_PROFILES: "1",
      CPM_E2E_DRIVER_SOCKET: socketPath,
      CPM_E2E_ENABLE_GLOBAL_SHORTCUTS: options.enableGlobalShortcuts ? "1" : "0",
      CPM_E2E_DETERMINISTIC: "1",
      ...options.env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const socket = await connectSocket(socketPath, child, () => ({ stdout, stderr }), options.timeoutMs || 15_000);
  const driver = new ElectronDriver(socket);
  await driver.request("ping");
  await driver.waitFor("h1", (snapshot) => snapshot.text === "ProfilePilot", { timeoutMs: 10_000 });

  let stopped = false;
  return {
    fixtureRoot,
    homeDir,
    dataDir,
    electronDataDir,
    child,
    driver,
    output: () => ({ stdout, stderr }),
    async stop(stopOptions = {}) {
      if (stopped) return;
      stopped = true;
      try {
        await driver.request("quit", {}, 3_000);
      } catch {
        child.kill("SIGTERM");
      }
      await waitForExit(child, 5_000).catch(() => child.kill("SIGKILL"));
      driver.close();
      if (stopOptions.removeFixture !== false) {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    }
  };
}

export function assertDesktopE2eAllowed(name = "desktop E2E") {
  if (process.env.CPM_DESKTOP_E2E !== "1" || process.env.CPM_DESKTOP_E2E_ISOLATED !== "1") {
    throw new Error(
      `${name} is blocked on the normal desktop. Run it only in an isolated macOS user, VM, or CI desktop with CPM_DESKTOP_E2E=1 CPM_DESKTOP_E2E_ISOLATED=1.`
    );
  }
}

async function connectSocket(socketPath, child, output, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      const logs = output();
      throw new Error(`Electron E2E app exited before driver connection.\nstdout:\n${logs.stdout}\nstderr:\n${logs.stderr}`);
    }
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection({ path: socketPath });
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    } catch {
      await delay(60);
    }
  }
  child.kill("SIGTERM");
  const logs = output();
  throw new Error(`Timed out connecting to Electron E2E driver.\nstdout:\n${logs.stdout}\nstderr:\n${logs.stderr}`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Electron E2E app did not exit.")), timeoutMs);
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
