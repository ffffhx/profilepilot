import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);

// Each run owns a disposable registered Profile and Gateway, never a user's port.
export async function startTaskGatewayFixture() {
  const { resolveRealAgentBrowser } = require("../dist/main/agent-browser-wrapper");
  const driver = process.env.PROFILEPILOT_AGENT_BROWSER_REAL || resolveRealAgentBrowser();
  if (!driver) throw new Error("Install the agent-browser native driver before running browser integration tests.");
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-task-gateway-"));
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const overrides = {
    HOME: home, CPM_DATA_DIR: path.join(root, "data"), PROFILEPILOT_GATEWAY_HOME: home,
    AGENT_BROWSER_SOCKET_DIR: path.join(home, ".agent-browser"), PROFILEPILOT_AGENT_BROWSER_REAL: driver
  };
  const original = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  // Preserve USERPROFILE/APPDATA: changing Windows shell folders stalls some IMEs/Chrome builds.
  Object.assign(process.env, overrides);
  let daemon, port;
  const close = async () => {
    const { requestBrowserGateway } = require("../dist/main/browser-gateway-client");
    if (port) await requestBrowserGateway({ action: "unregister-profile", publicPort: port, closeChrome: true }, { homeDir: home }).catch(() => {});
    await daemon?.stop();
    for (const [key, value] of Object.entries(original)) value === undefined ? delete process.env[key] : process.env[key] = value;
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true }).catch(() => console.warn("Temporary test profile cleanup deferred:", root));
  };
  try {
    const { createProfileManager } = require("../dist/main/profile-manager");
    const manager = createProfileManager();
    const profile = await manager.createProfile("Browser task fixture");
    const id = `isolated:${profile.id}`;
    port = await manager.prepareProfileForAgent(id);
    const { BrowserGatewayDaemon } = require("../dist/main/browser-gateway-daemon");
    daemon = new BrowserGatewayDaemon(home);
    if (process.env.PP_VERIFY_TRACE === "1") {
      const register = daemon.gateway.registerBackend.bind(daemon.gateway);
      daemon.gateway.registerBackend = async input => {
        const send = input.backend.send.bind(input.backend);
        input.backend.send = text => {
          const message = JSON.parse(text);
          if (/^Input\.|^DOM\.getBoxModel|^DOM\.scrollIntoViewIfNeeded/.test(message.method || "")) console.log("fixture CDP", JSON.stringify({ method: message.method, params: message.params }));
          return send(text);
        };
        return register(input);
      };
    }
    await daemon.start();
    // Claim the listener before waiting for a model response. Otherwise two
    // concurrent fixtures may reserve the same currently-idle logical port.
    const bootstrapSession = `pp-fixture-${randomUUID()}`;
    const wrapper = path.resolve("dist/main/profilepilot-agent-browser-wrapper.cjs");
    const run = args => promisify(execFile)(process.execPath, [wrapper, "--session", bootstrapSession, "--cdp", String(port), "--json", ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 });
    await run(["open", "about:blank"]);
    await run(["profilepilot", "complete"]);
    return { id, name: "Browser task fixture", port, home, manager, close };
  } catch (error) { await close(); throw error; }
}
