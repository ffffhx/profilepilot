import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { LocalAppAgentState, LocalAppConfig, LocalAppInput, LocalAppView, LocalDebugTarget } from "../../shared/local-apps";
import { LocalAppGateway } from "./gateway";
import { atomicJson, idleRuntime, parseEnvironment, workerRequest, type LocalAppWorkerRecord } from "./protocol";
import { serviceRuntime } from "./service-runtime";

const port = z.number().int().min(1024).max(65535).nullable();
const inputSchema = z.object({
  id: z.string().uuid().optional(), name: z.string().trim().min(1).max(100),
  mode: z.enum(["launch", "attach", "service"]), cwd: z.string().trim().max(4096),
  command: z.string().trim().max(8192), environment: z.string().max(32768),
  cdpPort: port, inspectPort: port, agentPort: port.optional(),
  servicePort: port.optional(), serviceProcess: z.string().trim().max(4096).optional(), logPath: z.string().trim().max(4096).optional()
});
type Target = LocalDebugTarget & { ws: string };

export async function debugTargets(portNumber: number | null, kind: "renderer" | "main"): Promise<Target[]> {
  if (!portNumber) return [];
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = http.get({ hostname: "127.0.0.1", port: portNumber, path: "/json/list", agent: false }, response => {
        if (response.statusCode !== 200) { response.resume(); reject(new Error("调试端口未就绪。")); return; }
        let text = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { text += chunk; if (text.length > 512 * 1024) request.destroy(new Error("调试响应过大。")); });
        response.on("error", reject);
        response.on("end", () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
      });
      const timer = setTimeout(() => request.destroy(new Error("调试连接超时。")), 900);
      request.once("error", reject); request.once("close", () => clearTimeout(timer));
    });
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry): Target[] => {
      if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || typeof entry.webSocketDebuggerUrl !== "string") return [];
      if (kind === "main" ? entry.type !== "node" : entry.type !== "page" && entry.type !== "webview") return [];
      try {
        const ws = new URL(entry.webSocketDebuggerUrl);
        if (ws.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(ws.hostname) || Number(ws.port) !== portNumber || ws.username || ws.password) return [];
        // Connect to the exact local endpoint that was queried, never an advertised remote host.
        ws.hostname = "127.0.0.1";
        return [{ id: entry.id, kind, title: String(entry.title || (kind === "main" ? "主进程" : "应用窗口")).slice(0, 500), url: String(entry.url || "").slice(0, 2000), ws: ws.href }];
      } catch { return []; }
    });
  } catch { return []; }
}

export class LocalAppsService {
  private configs: LocalAppConfig[] = [];
  private operations = new Set<string>();
  private storePath: string;
  private agentStates = new Map<string, LocalAppAgentState>();
  private agentSync?: Promise<void>;
  constructor(readonly root: string, private reservedPorts: () => Promise<Set<number>> = async () => new Set(), private gateway?: LocalAppGateway) {
    fs.mkdirSync(root, { recursive: true });
    this.storePath = path.join(root, "apps.json");
    if (fs.existsSync(this.storePath)) {
      try {
        this.configs = z.array(inputSchema.extend({ id: z.string().uuid(), createdAt: z.string() })).parse(JSON.parse(fs.readFileSync(this.storePath, "utf8")));
      } catch { throw new Error(`本地应用配置无法读取，请检查 ${this.storePath}；原文件已保留。`); }
    }
  }
  private file(id: string, suffix: string): string { return path.join(this.root, `${z.string().uuid().parse(id)}.${suffix}`); }
  get(id: string): LocalAppConfig {
    const config = this.configs.find(item => item.id === id);
    if (!config) throw new Error("本地应用不存在，请刷新列表。");
    return { ...config };
  }
  private record(id: string): LocalAppWorkerRecord | undefined {
    try { return JSON.parse(fs.readFileSync(this.file(id, "runtime.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("应用运行状态无法读取。"); }
  }
  private async runtime(id: string) {
    const record = this.record(id);
    if (!record) return idleRuntime();
    if (["stopped", "failed"].includes(record.runtime.status)) return record.runtime;
    try { return await workerRequest(record, "status"); }
    catch { return { ...record.runtime, status: "failed" as const, error: "应用管理进程无法连接；请检查应用是否仍在运行。" }; }
  }
  async list(): Promise<LocalAppView[]> {
    return Promise.all(this.configs.map(async config => {
      if (config.mode === "service") {
        let runtime = await serviceRuntime(config).catch(error => ({ ...idleRuntime(), status: "failed" as const, error: `服务状态读取失败：${error.message}` }));
        if (runtime.status === "stopped") {
          const launch = await this.runtime(config.id);
          if (launch.status === "starting" || launch.status === "running") runtime = { ...launch, status: "starting" };
          else if (launch.status === "failed") runtime = launch;
        }
        return { ...config, runtime, debug: { renderer: false, main: false, targets: [] } };
      }
      const runtime = config.mode === "launch" ? await this.runtime(config.id) : idleRuntime();
      const probe = config.mode === "attach" || runtime.status === "running";
      const [renderer, main] = probe ? await Promise.all([debugTargets(config.cdpPort, "renderer"), debugTargets(config.inspectPort, "main")]) : [[], []];
      if (config.mode === "attach") runtime.status = renderer.length || main.length ? "running" : "stopped";
      return { ...config, runtime, debug: { renderer: !!renderer.length, main: !!main.length, targets: [...renderer, ...main].map(({ ws, ...target }) => target) }, agent: this.agentStates.get(config.id) };
    }));
  }
  async save(input: LocalAppInput): Promise<string> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new Error("请检查应用名称、启动配置和调试端口（1024–65535）。");
    const config = parsed.data;
    parseEnvironment(config.environment);
    if (config.mode !== "attach") {
      if (!config.command) throw new Error("请填写启动命令。");
      if (!path.isAbsolute(config.cwd) || !fs.statSync(config.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error("请选择存在的项目文件夹。");
      if (config.command.includes("{cdpPort}") && !config.cdpPort) throw new Error("命令使用了 {cdpPort}，请填写界面调试端口。");
      if (config.command.includes("{inspectPort}") && !config.inspectPort) throw new Error("命令使用了 {inspectPort}，请填写主进程调试端口。");
    } else if (!config.cdpPort && !config.inspectPort) throw new Error("连接已有应用时，请至少填写一个调试端口。");
    if (config.mode === "service") {
      if (!config.servicePort || !config.serviceProcess || !path.isAbsolute(config.serviceProcess)) throw new Error("请填写服务端口及用于识别进程的完整程序或脚本路径。");
      if (config.logPath && !path.isAbsolute(config.logPath)) throw new Error("日志文件请填写完整路径。");
      config.cdpPort = null; config.inspectPort = null; config.agentPort = null;
    } else { delete config.servicePort; delete config.serviceProcess; delete config.logPath; }
    if (config.cdpPort && config.cdpPort === config.inspectPort) throw new Error("界面和主进程需要使用不同的调试端口。");
    if (config.agentPort && (!config.cdpPort || [config.cdpPort, config.inspectPort].includes(config.agentPort))) throw new Error("Agent 端口需要界面调试端口，且不能与其他调试端口相同。");
    const id = config.id || randomUUID();
    await this.exclusive(id, async () => {
      if (config.id) { this.get(id); await this.assertStopped(id); }
      const reserved = await this.reservedPorts();
      if ([config.cdpPort, config.inspectPort, config.servicePort, config.agentPort].some(p => p && reserved.has(p))) throw new Error("端口已被浏览器 Profile 使用，请更换端口。");
      for (const other of this.configs) if (other.id !== id && [config.cdpPort, config.inspectPort, config.servicePort, config.agentPort].some(p => p && [other.cdpPort, other.inspectPort, other.servicePort, other.agentPort].includes(p))) throw new Error(`端口已分配给「${other.name}」。`);
      if (config.id) await this.gateway?.detach(this.get(id));
      const next = { ...config, id, createdAt: this.configs.find(item => item.id === id)?.createdAt || new Date().toISOString() };
      const configs = this.configs.filter(item => item.id !== id); configs.push(next);
      configs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      atomicJson(this.storePath, configs); this.configs = configs;
    });
    return id;
  }
  private async assertStopped(id: string): Promise<void> {
    const record = this.record(id);
    if (!record || ["stopped", "failed"].includes(record.runtime.status)) return;
    try {
      const state = await workerRequest(record, "status");
      if (["stopped", "failed"].includes(state.status)) return;
    } catch {
      // Only use the PID to rule out a live process, never to target a stop operation.
      const pid = record.runtime.pid || record.workerPid;
      if (pid) {
        try { process.kill(pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; }
      }
    }
    throw new Error("请先停止应用；如果管理连接已中断，请先在系统中确认该应用已退出。");
  }
  async remove(id: string): Promise<void> {
    await this.exclusive(id, async () => {
      this.get(id); await this.assertStopped(id);
      await this.gateway?.detach(this.get(id));
      const configs = this.configs.filter(item => item.id !== id);
      atomicJson(this.storePath, configs); this.configs = configs;
      // Removing an entry never deletes the project or its data.
    });
  }
  private async exclusive<T>(id: string, run: () => Promise<T>): Promise<T> {
    if (this.operations.has(id)) throw new Error("此应用正在处理另一项操作，请稍后重试。");
    this.operations.add(id);
    try { return await run(); } finally { this.operations.delete(id); }
  }
  async start(id: string): Promise<void> {
    await this.exclusive(id, async () => {
      const config = this.get(id);
      if (config.mode === "service" && (await serviceRuntime(config)).status === "running") return;
      await this.launch(id);
      if (config.mode === "service") {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          if ((await serviceRuntime(config)).status === "running") return;
          await new Promise(resolve => setTimeout(resolve, 750));
        }
        throw new Error("启动命令已执行，但尚未发现匹配的服务进程和监听端口，请检查启动命令、进程识别路径与服务端口。");
      }
    });
  }
  async stop(id: string): Promise<void> { await this.exclusive(id, () => this.halt(id)); }
  async restart(id: string): Promise<void> { await this.exclusive(id, async () => { await this.halt(id); await this.launch(id); }); }
  private async launch(id: string): Promise<void> {
    const config = this.get(id);
    if (config.mode === "attach") throw new Error("已有应用由外部启动，不能从此处启动或停止。");
    await this.assertStopped(id);
    const reserved = await this.reservedPorts();
    for (const p of [config.cdpPort, config.inspectPort, config.servicePort]) if (p) {
      if (reserved.has(p)) throw new Error(`端口 ${p} 已被浏览器 Profile 使用。`);
      await new Promise<void>((resolve, reject) => {
        const server = net.createServer();
        server.once("error", () => reject(new Error(`端口 ${p} 已被占用，请停止占用程序或更换调试端口。`)));
        server.listen(p, "127.0.0.1", () => server.close(() => resolve()));
      });
    }
    const token = randomUUID();
    const socket = process.platform === "win32" ? `\\\\.\\pipe\\pp-local-${token}` : path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), `pp-app-${token}.sock`);
    const recordPath = this.file(id, "runtime.json");
    const record: LocalAppWorkerRecord = { socket, token, runtime: { ...idleRuntime(), status: "starting" } };
    atomicJson(recordPath, record);
    const launchPath = this.file(id, "launch.json");
    atomicJson(launchPath, { config, socket, token, recordPath, logPath: this.file(id, "log") });
    const child = spawn(process.execPath, [path.join(__dirname, "worker.js"), launchPath], {
      detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    });
    record.workerPid = child.pid;
    atomicJson(recordPath, record);
    let spawnError: Error | undefined;
    child.once("error", error => { spawnError = error; }); child.unref();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (spawnError) break;
      const latest = this.record(id);
      if (latest?.runtime.status === "failed") throw new Error(latest.runtime.error || `启动命令退出，退出码 ${latest.runtime.exitCode}，请检查启动命令和项目依赖。`);
      if (latest?.runtime.status === "stopped") return;
      try { if ((await workerRequest(record, "status", 400)).status === "running") return; } catch { /* wait for worker */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // Leave an authenticated worker alone if it is alive; don't orphan a running child.
    try { await workerRequest(record, "stop", 12_000); } catch { /* preserve record for diagnostics */ }
    if (spawnError || child.exitCode !== null) atomicJson(recordPath, { ...record, runtime: { ...idleRuntime(), status: "failed", error: spawnError?.message || "应用管理进程未能启动。" } });
    throw new Error(spawnError?.message || "应用启动超时，请检查项目启动命令和依赖。");
  }
  private async halt(id: string): Promise<void> {
    if (this.get(id).mode !== "launch") throw new Error("已有应用由外部管理，不能从此处停止。");
    await this.gateway?.detach(this.get(id));
    const record = this.record(id);
    if (!record || ["stopped", "failed"].includes(record.runtime.status)) return;
    await workerRequest(record, "stop", 12_000);
  }
  syncAgents(): Promise<void> {
    if (!this.gateway) return Promise.resolve();
    if (this.agentSync) return this.agentSync;
    this.agentSync = this.syncAgentRoutes().finally(() => { this.agentSync = undefined; });
    return this.agentSync;
  }
  private async syncAgentRoutes(): Promise<void> {
    const candidates = this.configs.filter(config => config.mode !== "service" && config.cdpPort && !this.operations.has(config.id));
    if (!candidates.length || !this.gateway) return;
    let status, statusError: unknown;
    try { status = await this.gateway.status(); }
    catch (error) { statusError = error; }
    for (const candidate of candidates) {
      if (this.operations.has(candidate.id) || !this.configs.some(item => item.id === candidate.id)) continue;
      await this.exclusive(candidate.id, async () => {
        let config = this.get(candidate.id);
        try {
          if (!config.agentPort) {
            const reserved = await this.reservedPorts();
            for (const other of this.configs) for (const value of [other.cdpPort, other.inspectPort, other.servicePort, other.agentPort]) if (value) reserved.add(value);
            let agentPort: number;
            do {
              agentPort = await new Promise<number>((resolve, reject) => {
                const server = net.createServer();
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => { const value = (server.address() as net.AddressInfo).port; server.close(() => resolve(value)); });
              });
            } while (reserved.has(agentPort));
            config = { ...config, agentPort };
            this.configs = this.configs.map(item => item.id === config.id ? config : item);
            atomicJson(this.storePath, this.configs);
          }
          if (config.mode === "launch" && (await this.runtime(config.id)).status !== "running") {
            this.agentStates.set(config.id, { connected: false }); return;
          }
          if (statusError) throw statusError;
          const state = this.gateway!.state(config, status!);
          if (!state.connected) { await this.gateway!.attach(config); state.connected = true; }
          this.agentStates.set(config.id, state);
        } catch (error) { this.agentStates.set(config.id, { connected: false, error: (error as Error).message }); }
      });
    }
  }
  logs(id: string): string {
    const config = this.get(id); const file = config.mode === "service" && config.logPath ? config.logPath : this.file(id, "log");
    if (!fs.existsSync(file)) return "";
    const descriptor = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(descriptor).size; const count = Math.min(size, 128 * 1024);
      const buffer = Buffer.alloc(count); fs.readSync(descriptor, buffer, 0, count, size - count);
      return buffer.toString("utf8").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    } finally { fs.closeSync(descriptor); }
  }
  async debuggerUrl(id: string, kind: "renderer" | "main", targetId: string): Promise<string> {
    const config = this.get(id);
    if (config.mode === "launch" && (await this.runtime(id)).status !== "running") throw new Error("请先启动应用。");
    const targets = await debugTargets(kind === "main" ? config.inspectPort : config.cdpPort, kind);
    const target = targets.find(item => item.id === targetId);
    if (!target) throw new Error("调试窗口已关闭或端口尚未就绪，请刷新后重试。");
    return `devtools://devtools/bundled/${kind === "main" ? "js_app" : "inspector"}.html?ws=${encodeURIComponent(target.ws.slice(5))}`;
  }
}
