import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { spawn } from "node:child_process";
import { BrowserEngine } from "./engine";
import { ENGINE_VERSION, EngineError, type EngineCommand } from "./arguments";
import { startService } from "../cli/service-launcher";

interface ServiceRecord { version: string; pid: number; port: number; token: string; session: string; root: string }
export interface EngineResponse { success: boolean; data?: unknown; error?: string; code?: string }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export const engineRoot = (env = process.env) => path.resolve(env.AGENT_BROWSER_SOCKET_DIR || path.join(env.HOME || os.homedir(), ".agent-browser"));
function recordPath(root: string, session: string) { return path.join(root, `${session}.engine.json`); }
async function readRecord(root: string, session: string): Promise<ServiceRecord | undefined> {
  try {
    const record = JSON.parse(await readFile(recordPath(root, session), "utf8")) as ServiceRecord;
    if (typeof record.version === "string" && record.root === root && record.session === session &&
      Number.isSafeInteger(record.pid) && record.pid > 0 && alive(record.pid) &&
      Number.isInteger(record.port) && record.port > 0 && record.port < 65536 && /^[a-f0-9]{64}$/.test(record.token)) return record;
  } catch { /* Missing or obsolete discovery state. */ }
}
async function request(record: ServiceRecord, body: unknown, timeout: number): Promise<EngineResponse> {
  const response = await fetch(`http://127.0.0.1:${record.port}/command`, {
    method: "POST", headers: { Authorization: `Bearer ${record.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new EngineError(`Browser engine service returned HTTP ${response.status}`, "BROWSER_SERVICE_ERROR");
  return await response.json() as EngineResponse;
}
async function probe(root: string, session: string): Promise<ServiceRecord | undefined> {
  const record = await readRecord(root, session);
  if (!record) return;
  try {
    const response = await request(record, { ping: true }, 1500);
    const data = response.data as ServiceRecord;
    if (response.success && data.pid === record.pid && data.version === ENGINE_VERSION && data.session === session) return record;
  } catch { /* A live but unresponsive service must not be replaced. */ }
}
export async function launchEngineService(root: string, session: string, entry = process.argv[1]): Promise<void> {
  const args = [entry, "--engine-service", root, session];
  if (process.platform === "win32") {
    // CIM detaches from the terminal Job. The child PowerShell establishes
    // Electron's Node mode explicitly, since CIM does not inherit our env.
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const script = `$env:ELECTRON_RUN_AS_NODE='1'\n& ${quote(process.execPath)} ${args.map(quote).join(" ")}\nexit $LASTEXITCODE`;
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    await startService({ executable: powershell, cwd: path.dirname(entry),
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] });
  } else {
    const child = spawn(process.execPath, args, { cwd: path.dirname(entry), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, detached: true, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
  }
}
export async function sendEngineCommand(command: EngineCommand, root = engineRoot()): Promise<EngineResponse> {
  let record = await probe(root, command.session);
  if (!record) {
    // Do not create a replacement on an observation timeout.
    const existing = await readRecord(root, command.session);
    if (existing) throw new EngineError(existing.version === ENGINE_VERSION
      ? "Existing browser engine is alive but unresponsive; inspect it before retrying."
      : "This session uses an older engine. Complete the session before updating it.", "BROWSER_SERVICE_UNRESPONSIVE");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await launchEngineService(root, command.session);
    for (let i = 0; i < 100; i++) {
      record = await probe(root, command.session);
      if (record) break;
      await delay(150);
    }
    if (!record) throw new EngineError("TypeScript browser engine did not start; inspect the session's engine log.", "BROWSER_SERVICE_START_FAILED");
  }
  // One request, never automatically replay an action after a transport timeout.
  return request(record, { id: randomUUID(), command }, Math.max(command.timeout + 10000, 40000));
}

export async function serveEngine(root: string, session: string): Promise<void> {
  if (!path.isAbsolute(root) || !/^[A-Za-z0-9._-]{1,120}$/.test(session) || [".", ".."].includes(session)) throw new Error("Invalid engine service identity");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const previousPid = Number(await readFile(path.join(root, `${session}.pid`), "utf8").catch(() => "0"));
  if (previousPid > 0 && alive(previousPid) && !await readRecord(root, session))
    throw new EngineError("An existing driver owns this session. Complete it before using the TypeScript engine.", "BROWSER_SESSION_IN_USE");
  const lockPath = path.join(root, `${session}.engine-lock`);
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = Number(await readFile(lockPath, "utf8").catch(() => "0"));
    if (owner && alive(owner)) return;
    // Another starter may still be writing its PID. Only reclaim an empty lock
    // after its creation window has expired (e.g. a crash between open/write).
    if (!owner && Date.now() - (await stat(lockPath)).mtimeMs < 30000) return;
    // Compare again before reclaiming an abandoned lock.
    if (Number(await readFile(lockPath, "utf8").catch(() => "0")) !== owner) return;
    await unlink(lockPath).catch(() => {});
    try { lock = await open(lockPath, "wx", 0o600); } catch { return; }
  }
  await lock.writeFile(String(process.pid));
  await lock.close();
  const engine = new BrowserEngine();
  const token = randomBytes(32).toString("hex");
  const results = new Map<string, Promise<EngineResponse>>();
  let queue: Promise<unknown> = Promise.resolve();
  let stopping = false;
  let lastActivity = Date.now();
  let record: ServiceRecord;
  const server = http.createServer(async (req, res) => {
    const respond = (status: number, body: unknown) => { if (!res.destroyed) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); } };
    if (req.method !== "POST" || req.url !== "/command" || req.headers.authorization !== `Bearer ${token}`) { respond(403, { success: false }); req.resume(); return; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new EngineError("Command too large"); chunks.push(Buffer.from(chunk)); }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (input.ping) { respond(200, { success: true, data: { version: ENGINE_VERSION, pid: process.pid, session, connectionStage: engine.connectionStage } }); return; }
      if (stopping) throw new EngineError("Browser service is stopping");
      if (typeof input.id !== "string" || input.command?.session !== session || !Array.isArray(input.command.args) ||
        input.command.args.some((arg: unknown) => typeof arg !== "string") ||
        !Number.isFinite(input.command.timeout) || input.command.timeout <= 0 || input.command.timeout > 300000) throw new EngineError("Invalid engine command");
      lastActivity = Date.now();
      let pending = results.get(input.id);
      if (!pending) {
        pending = queue.then(async (): Promise<EngineResponse> => {
          try {
            const data = await engine.execute(input.command);
            return data?.failed ? { success: false, data, error: "One or more batch commands failed", code: "BROWSER_BATCH_FAILED" } : { success: true, data };
          }
          catch (error) {
            if (input.command.args[0] === "connect") {
              const message = String(error instanceof Error ? error.message : error).replace(/wss?:\/\/\S+/g, "[Gateway endpoint]");
              await appendFile(path.join(root, `${session}.engine.log`), JSON.stringify({ at: new Date().toISOString(), command: "connect", error: message }) + "\n", { mode: 0o600 }).catch(() => {});
            }
            return { success: false, error: error instanceof Error ? error.message : String(error), code: (error as EngineError).code || "BROWSER_ENGINE_ERROR" };
          } finally { lastActivity = Date.now(); }
        });
        queue = pending;
        results.set(input.id, pending);
        if (results.size > 100) results.delete(results.keys().next().value!);
      }
      respond(200, await pending);
    } catch (error) { respond(400, { success: false, error: String(error) }); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  record = { version: ENGINE_VERSION, pid: process.pid, port: (server.address() as { port: number }).port, token, session, root };
  const statePath = recordPath(root, session), temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
  await writeFile(path.join(root, `${session}.pid`), String(process.pid), { mode: 0o600 });
  await writeFile(path.join(root, `${session}.port`), String(record.port), { mode: 0o600 });
  await rename(temporary, statePath);
  // Control notices can be written and consumed between CLI calls. Watching
  // changes prevents refs surviving a handoff/return even if the file is gone.
  const controlWatcher = watch(root, (_event, file) => {
    if (String(file) === `${session}.profilepilot-control.json`) engine.invalidateReferences();
  });
  controlWatcher.on("error", () => { engine.invalidateReferences(); });
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(idle);
    controlWatcher.close();
    server.close(); server.closeAllConnections();
    await engine.disconnect().catch(() => {});
    const current = await readFile(statePath, "utf8").then(JSON.parse).catch(() => null);
    if (current?.pid === process.pid && current.token === token) {
      for (const file of [statePath, lockPath, path.join(root, `${session}.pid`), path.join(root, `${session}.port`)]) await unlink(file).catch(() => {});
    }
    process.exit(0);
  };
  const idle = setInterval(() => {
    if (Date.now() - lastActivity > 60 * 60_000) void shutdown();
    else void readFile(statePath, "utf8").catch(() => { void shutdown(); });
  }, 5000);
  idle.unref();
  process.on("SIGTERM", () => { void shutdown(); });
  process.on("SIGINT", () => { void shutdown(); });
}
