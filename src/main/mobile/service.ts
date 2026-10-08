import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { MobileDevice, MobilePairing, MobileSnapshot } from "../../shared/mobile";
import type { TaskService } from "../tasks/service";
import { executeTaskManagementCommand, parseTaskManagementCommand } from "../tasks/management";

export interface MobileProfile { id: string; name: string; source: string; ready: boolean; reason?: string; }
interface SavedDevice extends MobileDevice { tokenHash: string; }
interface Receipt { device: string; id: string; hash: string; at: number; state: "pending" | "done"; response?: Reply; }
interface Saved { version: 1; id: string; enabled: boolean; port: number; advertisedUrl: string; devices: SavedDevice[]; receipts: Receipt[]; }
type Reply = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
interface Options {
  root: string; tasks: TaskService; profiles(): Promise<MobileProfile[]>;
  changed?(snapshot: MobileSnapshot): void; computerName?: string; port?: number;
}
const uuid = z.string().uuid();
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (message: string, code = "MOBILE_REQUEST_INVALID") => Object.assign(new Error(message), { code });
const reads = new Set(["sync", "task.list", "task.get", "task.models", "task.artifact"]);
const permitted = new Set([...reads, "task.create", "task.control", "task.reply", "task.metadata", "device.disconnect"]);

export function mobileEndpoint(value: string): string {
  const url = new URL(value);
  if (url.port === "0") throw fail("电脑地址端口无效，请使用移动版连接显示的实际端口。");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw fail("电脑地址必须是 HTTPS 地址，不能包含路径或凭据。");
  return url.origin;
}
function atomicJson(file: string, value: unknown): void {
  const tmp = `${file}.${randomUUID()}.tmp`, descriptor = openSync(tmp, "wx", 0o600);
  try { writeFileSync(descriptor, JSON.stringify(value)); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(tmp, file);
}

/** A separate, narrow network API; the desktop IPC and management socket stay private. */
export class MobileService {
  private saved: Saved;
  private readonly file: string;
  private server?: https.Server;
  private fingerprint = "";
  private error = "";
  private startPromise?: Promise<void>;
  private pairs = new Map<string, { expires: number; used?: { clientId: string; name: string; response: unknown } }>();
  private inFlight = new Map<string, Promise<Reply>>();
  private rate = new Map<string, { at: number; count: number }>();
  private lastPublish = 0;
  private closed = false;
  readonly computerName: string;
  constructor(private readonly options: Options) {
    mkdirSync(options.root, { recursive: true, mode: 0o700 }); this.file = path.join(options.root, "mobile.json");
    this.computerName = (options.computerName || os.hostname()).slice(0, 120);
    this.saved = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { version: 1, id: randomUUID(), enabled: false, port: options.port ?? 0, advertisedUrl: "", devices: [], receipts: [] };
    if (this.saved.version !== 1 || !Array.isArray(this.saved.devices) || !Array.isArray(this.saved.receipts)) throw fail("移动工作区数据无效，原文件已保留。");
  }
  private persist(): void { atomicJson(this.file, this.saved); }
  private changed(): void { this.options.changed?.(this.snapshot()); }
  snapshot(): MobileSnapshot {
    const addresses = new Set<string>();
    if (this.saved.port > 0) for (const entries of Object.values(os.networkInterfaces())) for (const entry of entries || []) if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) addresses.add(`https://${entry.address}:${this.saved.port}`);
    if (this.saved.advertisedUrl) addresses.add(this.saved.advertisedUrl);
    return { enabled: this.saved.enabled, listening: !!this.server?.listening, computerId: this.saved.id, computerName: this.computerName, port: this.saved.port, endpoints: [...addresses], advertisedUrl: this.saved.advertisedUrl, fingerprint: this.fingerprint, devices: this.saved.devices.map(({ tokenHash: _, ...device }) => ({ ...device })), error: this.error };
  }
  async start(): Promise<void> {
    if (!this.saved.enabled || this.closed || this.server?.listening) return;
    if (!this.startPromise) this.startPromise = this.listen().finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }
  private async listen(): Promise<void> {
    try {
      const certFile = path.join(this.options.root, "identity.json");
      let identity: { key: string; cert: string };
      if (existsSync(certFile)) identity = JSON.parse(readFileSync(certFile, "utf8"));
      else {
        const { generate } = await import("selfsigned");
        const pems = await generate([{ name: "commonName", value: `ProfilePilot ${this.saved.id}` }], { keySize: 2048, algorithm: "sha256", notAfterDate: new Date(Date.now() + 10 * 365 * 86400000) });
        identity = { key: pems.private, cert: pems.cert }; atomicJson(certFile, identity);
      }
      this.fingerprint = new X509Certificate(identity.cert).fingerprint256.replaceAll(":", "").toLowerCase();
      if (!this.saved.enabled || this.closed) return;
      const server = https.createServer({ ...identity, minVersion: "TLSv1.2", requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 8192 }, (request, response) => { void this.handle(request, response); });
      this.server = server;
      server.on("clientError", (_error, socket) => socket.destroy());
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.saved.port, "0.0.0.0", () => { server.removeListener("error", reject); resolve(); }); });
      server.on("error", error => { this.error = error.message; this.changed(); });
      const address = server.address(); if (address && typeof address !== "string") this.saved.port = address.port;
      this.error = ""; this.persist(); this.changed();
    } catch (error) { this.error = (error as Error).message; this.changed(); throw error; }
  }
  async configure(input: unknown): Promise<MobileSnapshot> {
    const next = z.object({ enabled: z.boolean(), advertisedUrl: z.string().max(2000).optional() }).strict().parse(input);
    if (next.advertisedUrl !== undefined) this.saved.advertisedUrl = next.advertisedUrl.trim() ? mobileEndpoint(next.advertisedUrl.trim()) : "";
    this.saved.enabled = next.enabled; this.persist();
    if (next.enabled) await this.start(); else { this.pairs.clear(); await this.stopServer(); }
    this.changed(); return this.snapshot();
  }
  async pair(endpoint?: string): Promise<MobilePairing> {
    if (!this.server?.listening || !this.saved.enabled) throw fail("请先开启移动版连接。");
    const url = mobileEndpoint(endpoint || this.saved.advertisedUrl || this.snapshot().endpoints[0] || `https://127.0.0.1:${this.saved.port}`);
    const token = randomBytes(32).toString("hex"), expires = Date.now() + 180000;
    this.pairs.clear(); this.pairs.set(hash(token), { expires });
    const params = new URLSearchParams({ v: "1", id: this.saved.id, name: this.computerName, url, fp: this.fingerprint, token });
    const uri = `profilepilot://pair?${params}`;
    const QRCode = (await import("qrcode")).default;
    return { uri, qr: await QRCode.toDataURL(uri, { width: 320, margin: 2, errorCorrectionLevel: "M" }), expiresAt: new Date(expires).toISOString() };
  }
  revoke(id: string): MobileSnapshot {
    uuid.parse(id); this.saved.devices = this.saved.devices.filter(device => device.id !== id);
    this.saved.receipts = this.saved.receipts.filter(receipt => receipt.device !== id);
    // A completed pairing response cannot re-issue a credential after revocation.
    this.pairs.clear(); this.persist(); this.changed(); return this.snapshot();
  }
  updateDevice(id: string, input: unknown): MobileSnapshot {
    const patch = z.object({ name: z.string().trim().min(1).max(80).optional(), canControl: z.boolean().optional() }).strict().parse(input);
    const device = this.saved.devices.find(item => item.id === uuid.parse(id)); if (!device) throw fail("手机连接不存在。");
    Object.assign(device, patch); this.persist(); this.changed(); return this.snapshot();
  }
  private limit(key: string, max: number): void {
    const now = Date.now(); let record = this.rate.get(key);
    if (!record || now - record.at > 60000) this.rate.set(key, record = { at: now, count: 0 });
    if (++record.count > max) throw fail("请求过于频繁，请稍后再试。", "MOBILE_RATE_LIMIT");
    if (this.rate.size > 2048) for (const [id, value] of this.rate) if (now - value.at > 60000) this.rate.delete(id);
  }
  private async body(request: IncomingMessage): Promise<unknown> {
    if (!String(request.headers["content-type"] || "").startsWith("application/json")) throw fail("需要 JSON 请求。");
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) { size += chunk.length; if (size > 160 * 1024) throw fail("请求内容过长。"); chunks.push(Buffer.from(chunk)); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  private send(response: ServerResponse, reply: Reply, status = 200): void {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(JSON.stringify(reply));
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!this.saved.enabled || this.closed) throw fail("移动版连接已关闭。", "MOBILE_DISABLED");
      // Native clients only. Browser origins never receive cross-origin access to this API.
      if (request.headers.origin || request.method !== "POST" || !["/v1/pair", "/v1/request"].includes(request.url || "")) throw fail("请求入口无效。");
      if (request.url === "/v1/pair") {
        this.limit(`pair:${request.socket.remoteAddress}`, 12);
        const input = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), clientId: uuid, name: z.string().trim().min(1).max(80) }).strict().parse(await this.body(request));
        const pair = this.pairs.get(hash(input.token));
        if (!pair || pair.expires < Date.now()) throw fail("配对码已失效，请在电脑重新生成。", "MOBILE_PAIR_EXPIRED");
        if (pair.used) {
          if (pair.used.clientId !== input.clientId || pair.used.name !== input.name) throw fail("配对码已经使用。", "MOBILE_PAIR_USED");
          this.send(response, { ok: true, data: pair.used.response }); return;
        }
        if (this.saved.devices.length >= 20) throw fail("已连接 20 台手机，请先移除不再使用的设备。");
        const token = randomBytes(32).toString("hex"), device: SavedDevice = { id: randomUUID(), name: input.name, tokenHash: hash(token), createdAt: new Date().toISOString(), lastSeen: null, canControl: true };
        this.saved.devices.push(device); this.persist();
        const data = { computerId: this.saved.id, computerName: this.computerName, deviceId: device.id, token, fingerprint: this.fingerprint };
        pair.used = { clientId: input.clientId, name: input.name, response: data };
        this.changed(); this.send(response, { ok: true, data }); return;
      }
      const token = /^Bearer ([a-f0-9]{64})$/.exec(String(request.headers.authorization || ""))?.[1];
      const device = token && this.saved.devices.find(item => same(item.tokenHash, hash(token)));
      if (!device) { this.limit(`auth:${request.socket.remoteAddress}`, 30); throw fail("此手机尚未配对或授权已撤销。", "MOBILE_UNAUTHORIZED"); }
      this.limit(`device:${device.id}`, 180);
      const input = z.object({ requestId: uuid, issuedAt: z.number().int().positive(), command: z.record(z.string(), z.unknown()) }).strict().parse(await this.body(request));
      if (!this.saved.devices.includes(device)) throw fail("授权已撤销。", "MOBILE_UNAUTHORIZED");
      const action = String(input.command.action || "");
      if (!permitted.has(action)) throw fail("移动版不支持此操作。");
      if (Math.abs(Date.now() - input.issuedAt) > 10 * 60000) throw fail("请求已过期，请检查手机时间并刷新任务状态。", "MOBILE_REQUEST_EXPIRED");
      if (!reads.has(action) && action !== "device.disconnect" && !device.canControl) throw fail("电脑已将此手机设置为仅查看。", "MOBILE_READ_ONLY");
      device.lastSeen = new Date().toISOString();
      if (Date.now() - this.lastPublish > 15000) { this.lastPublish = Date.now(); this.persist(); this.changed(); }
      const reply = reads.has(action) ? await this.result(() => this.execute(input.command, device)) : await this.mutate(device, input.requestId, input.command);
      // Authorization may be revoked while a slow read awaits the profile service.
      if (action !== "device.disconnect" && !this.saved.devices.includes(device)) throw fail("授权已撤销。", "MOBILE_UNAUTHORIZED");
      this.send(response, reply);
    } catch (error) { this.send(response, this.failure(error), (error as { code?: string }).code === "MOBILE_UNAUTHORIZED" ? 401 : 400); }
  }
  private failure(error: unknown): Reply { return { ok: false, error: { code: (error as { code?: string }).code || "MOBILE_REQUEST_FAILED", message: error instanceof z.ZodError ? "请求参数无效。" : (error as Error).message || "操作失败。" } }; }
  private async result(action: () => Promise<unknown>): Promise<Reply> { try { return { ok: true, data: await action() }; } catch (error) { return this.failure(error); } }
  private async mutate(device: SavedDevice, id: string, command: Record<string, unknown>): Promise<Reply> {
    const key = `${device.id}:${id}`, fingerprint = hash(JSON.stringify(command));
    const previous = this.saved.receipts.find(item => item.device === device.id && item.id === id);
    if (previous) {
      if (previous.hash !== fingerprint) throw fail("同一请求编号不能用于不同操作。", "MOBILE_REQUEST_CONFLICT");
      if (this.inFlight.has(key)) return this.inFlight.get(key)!;
      if (previous.state === "done" && previous.response) return previous.response;
      throw fail("上次操作的结果尚未确认，请刷新任务状态后再决定是否操作。", "MOBILE_REQUEST_UNCERTAIN");
    }
    const receipt: Receipt = { device: device.id, id, hash: fingerprint, at: Date.now(), state: "pending" };
    // Never evict a receipt whose request could still be retried within the
    // accepted clock-skew window (including a phone clock ten minutes ahead).
    this.saved.receipts = this.saved.receipts.filter(item => Date.now() - item.at < 21 * 60000);
    if (this.saved.receipts.length >= 10000) throw fail("操作记录繁忙，请稍后重试。", "MOBILE_RATE_LIMIT");
    this.saved.receipts.push(receipt); this.persist();
    const pending = this.result(() => this.execute(command, device)); this.inFlight.set(key, pending);
    try {
      const reply = await pending; receipt.state = "done";
      // Retries need the resulting task identity, not another copy of private conversations.
      const task = reply.ok && reply.data && typeof reply.data === "object" && "task" in reply.data ? (reply.data as { task: { id: string } }).task : undefined;
      receipt.response = task ? { ok: true, data: { task: { id: task.id } } } : reply;
      this.persist(); return reply;
    }
    finally { this.inFlight.delete(key); }
  }
  private async execute(command: Record<string, unknown>, device: SavedDevice): Promise<unknown> {
    const service = this.options.tasks;
    if (command.action === "device.disconnect") { this.revoke(device.id); return { disconnected: true }; }
    if (command.action === "sync") {
      const profiles = await this.options.profiles();
      const tasks = service.store.data.tasks.filter(task => !task.archivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { computerId: this.saved.id, computerName: this.computerName, canControl: device.canControl, model: service.store.data.settings.model, configured: service.store.data.settings.hasApiKey, profiles,
        tasks: tasks.slice(0, 50).map(task => ({ id: task.id, title: task.title, profileName: task.profileName, status: task.status, updatedAt: task.updatedAt, ...(task.pending ? { pending: { id: task.pending.id, kind: task.pending.kind, title: task.pending.title } } : {}) })), total: tasks.length, at: new Date().toISOString() };
    }
    if (command.action === "task.artifact") {
      const input = z.object({ action: z.literal("task.artifact"), taskId: uuid, fileId: uuid }).strict().parse(command);
      const task = service.store.get(input.taskId), file = task.outputs?.find(item => item.id === input.fileId);
      if (!file || !existsSync(file.path)) throw fail("任务产物不存在。");
      if (statSync(file.path).size > 8 * 1024 * 1024) throw fail("文件大于 8 MB，请在电脑打开。");
      const bytes = readFileSync(file.path);
      if (bytes.length > 8 * 1024 * 1024) throw fail("文件大于 8 MB，请在电脑打开。");
      return { name: path.basename(file.name), mime: "application/octet-stream", base64: bytes.toString("base64") };
    }
    if (command.action === "task.list") {
      const input = z.object({ action: z.literal("task.list"), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict().parse(command);
      const tasks = service.store.data.tasks.filter(task => !task.archivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { tasks: tasks.slice(input.offset || 0, (input.offset || 0) + (input.limit || 50)).map(task => ({ id: task.id, title: task.title, profileName: task.profileName, status: task.status, updatedAt: task.updatedAt })), total: tasks.length };
    }
    const parsed = parseTaskManagementCommand(command);
    // Keep credentials, PC-local file imports and settings outside the mobile API.
    if (!["task.create", "task.list", "task.get", "task.models", "task.control", "task.reply", "task.metadata"].includes(parsed.action)) throw fail("移动版不支持此操作。");
    const data = await executeTaskManagementCommand(parsed, service, async id => {
      const profile = (await this.options.profiles()).find(item => item.id === id);
      if (!this.saved.devices.includes(device) || !device.canControl) throw fail("此手机的操作授权已撤销。", "MOBILE_UNAUTHORIZED");
      if (!profile) throw fail("请选择当前电脑上的 Profile。");
      if (!profile.ready) throw fail(profile.reason || "此 Profile 暂不可用于任务。");
      return id;
    });
    if (data && typeof data === "object" && "task" in data) {
      const task = (data as { task?: { outputs?: Array<Record<string, unknown>> } }).task;
      if (task?.outputs) task.outputs = task.outputs.map(({ path: _, ...output }) => output);
    }
    return data;
  }
  private async stopServer(): Promise<void> {
    const server = this.server; this.server = undefined; if (!server) return;
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
  async close(): Promise<void> { this.closed = true; this.pairs.clear(); await this.startPromise?.catch(() => {}); await this.stopServer(); this.persist(); }
}
