import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from "node:crypto";
import { z } from "zod";
import { InternetPhoneBroker, internetFault } from "./internet-broker";

const uuid = z.string().uuid();
const secret = z.string().regex(/^[a-f0-9]{64}$/);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const storedSchema = z.object({
  version: z.literal(1), id: uuid, enabled: z.boolean(), port: z.number().int().min(0).max(65535), advertisedUrl: z.string(),
  devices: z.array(z.object({ id: uuid, name: z.string().min(1).max(80), tokenHash: secret, pairedAt: z.number() }).strict()).max(32)
}).strict();
type Stored = z.infer<typeof storedSchema>;
type Identity = { key: string; cert: string };
type Live = { connectionId: string; seenAt: number };
interface Options {
  root: string;
  computer: string;
  pairingScheme: string;
  changed?(): void;
  connected?(id: string, name: string, connectionId: string): void;
  disconnected?(id: string, connectionId: string): void;
  now?: () => number;
  identity?: Identity;
  broker?: InternetPhoneBroker;
}
export function internetEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.port === "0")
    throw internetFault("PHONE_INVALID_REQUEST", "外网控制地址必须是 HTTPS 地址，不能包含路径、凭据或查询参数。");
  return url.origin;
}
function atomic(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
}

/** The cloud desktop is the endpoint. No local computer, public ADB or status relay is used. */
export class InternetPhoneHub {
  private saved: Stored;
  private readonly file: string;
  private readonly broker: InternetPhoneBroker;
  private readonly now: () => number;
  private server?: https.Server;
  private starting?: Promise<void>;
  private fingerprint = "";
  private error = "";
  private closed = false;
  private live = new Map<string, Live>();
  private invitations = new Map<string, { expiresAt: number; claimed?: { id: string; tokenHash: string } }>();
  private rates = new Map<string, { at: number; count: number }>();
  private timer?: ReturnType<typeof setInterval>;
  private artifacts = new Map<string, { id: string; connectionId: string; file: string; bytes: number; sentBytes: number; expiresAt: number; authorize: () => Promise<void> }>();
  constructor(private readonly options: Options) {
    fs.mkdirSync(options.root, { recursive: true, mode: 0o700 });
    this.file = path.join(options.root, "internet-control.json");
    this.saved = fs.existsSync(this.file) ? storedSchema.parse(JSON.parse(fs.readFileSync(this.file, "utf8")))
      : { version: 1, id: randomUUID(), enabled: false, port: 0, advertisedUrl: "", devices: [] };
    if (this.saved.advertisedUrl) this.saved.advertisedUrl = internetEndpoint(this.saved.advertisedUrl);
    this.broker = options.broker || new InternetPhoneBroker();
    this.now = options.now || Date.now;
  }
  private changed(): void { this.options.changed?.(); }
  private persist(): void { atomic(this.file, this.saved); }
  private diagnostic(event: string, code: string, route = ""): void {
    // Bounded operational evidence only; never persist headers, bodies, pairing
    // links, artifact IDs, screenshots or device credentials.
    try {
      const file = path.join(this.options.root, "internet-events.json");
      const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
      const events = Array.isArray(previous) ? previous.slice(-63) : [];
      events.push({ at: this.now(), event, code: /^[A-Z_0-9]{1,80}$/.test(code) ? code : "UNKNOWN", route });
      atomic(file, events);
    } catch { /* Diagnostics cannot affect control. */ }
  }
  status() {
    return {
      enabled: this.saved.enabled, listening: !!this.server?.listening, id: this.saved.id, computer: this.options.computer,
      port: this.saved.port, advertisedUrl: this.saved.advertisedUrl, fingerprint: this.fingerprint, error: this.error,
      devices: this.saved.devices.map(device => ({ id: `internet-${device.id}`, name: device.name, pairedAt: device.pairedAt,
        connected: this.live.has(device.id), lastSeenAt: this.live.get(device.id)?.seenAt ?? null })),
      transfers: [...this.artifacts.values()].map(({ id, bytes, sentBytes }) => ({ id, bytes, sentBytes }))
    };
  }
  async start(): Promise<void> {
    if (!this.saved.enabled || this.closed || this.server?.listening) return;
    if (!this.starting) this.starting = this.listen().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async listen(): Promise<void> {
    try {
      const file = path.join(this.options.root, "internet-identity.json");
      let identity = this.options.identity;
      if (!identity && fs.existsSync(file)) identity = z.object({ key: z.string(), cert: z.string() }).strict().parse(JSON.parse(fs.readFileSync(file, "utf8")));
      if (!identity) {
        const { generate } = await import("selfsigned");
        const generated = await generate([{ name: "commonName", value: `ProfilePilot ${this.saved.id}` }],
          { keySize: 2048, algorithm: "sha256", notAfterDate: new Date(this.now() + 10 * 365 * 86400000) });
        identity = { key: generated.private, cert: generated.cert };
        atomic(file, identity);
      }
      this.fingerprint = new X509Certificate(identity.cert).fingerprint256.replaceAll(":", "").toLowerCase();
      if (this.closed || !this.saved.enabled) return;
      const server = https.createServer({ ...identity, minVersion: "TLSv1.2", headersTimeout: 10000, requestTimeout: 15000, maxHeaderSize: 8192 },
        (request, response) => { void this.handle(request, response); });
      this.server = server;
      server.on("clientError", (error, socket) => { this.diagnostic("http-error", (error as NodeJS.ErrnoException).code || "UNKNOWN"); socket.destroy(); });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.saved.port, "0.0.0.0", () => { server.removeListener("error", reject); resolve(); });
      });
      server.on("error", () => { this.error = "外网控制监听异常，请检查端口。"; this.changed(); });
      const address = server.address();
      if (address && typeof address !== "string") this.saved.port = address.port;
      this.error = ""; this.persist(); this.changed();
      this.timer = setInterval(() => this.expire(), 5000); this.timer.unref();
    } catch (error) { this.error = "外网控制服务启动失败，请检查端口和身份文件。"; this.changed(); throw error; }
  }
  async configure(input: unknown) {
    const value = z.object({ enabled: z.boolean(), port: z.number().int().min(0).max(65535).optional(), advertisedUrl: z.string().max(2048).optional() }).strict().parse(input);
    const advertisedUrl = value.advertisedUrl === undefined ? this.saved.advertisedUrl : internetEndpoint(value.advertisedUrl);
    if (value.enabled && !advertisedUrl) throw internetFault("PHONE_INVALID_REQUEST", "请设置手机可访问的 HTTPS 电脑地址。");
    const restart = !value.enabled || value.port !== undefined && value.port !== this.saved.port;
    if (restart) await this.stopListening();
    this.saved.enabled = value.enabled;
    if (value.port !== undefined) this.saved.port = value.port;
    this.saved.advertisedUrl = advertisedUrl; this.persist();
    await this.start(); this.changed(); return this.status();
  }
  pair() {
    if (!this.server?.listening || !this.saved.advertisedUrl) throw internetFault("PHONE_SERVICE_UNAVAILABLE", "请先配置并开启外网控制连接。");
    this.expire();
    if (this.saved.devices.length >= 32 || this.invitations.size >= 8) throw internetFault("PHONE_TARGET_BUSY", "配对数量已达上限，请移除不用的设备或等待配对码过期。");
    const token = randomBytes(32).toString("hex"), expiresAt = this.now() + 180000;
    this.invitations.set(hash(token), { expiresAt });
    const uri = `${this.options.pairingScheme}://internet?${new URLSearchParams({ v: "1", id: this.saved.id,
      url: this.saved.advertisedUrl, fp: this.fingerprint, token, name: this.options.computer })}`;
    return { uri, expiresAt, computer: this.options.computer, endpoint: this.saved.advertisedUrl };
  }
  forget(id: string): void {
    const raw = uuid.parse(id.replace(/^internet-/, ""));
    if (!this.saved.devices.some(device => device.id === raw)) throw internetFault("PHONE_DEVICE_NOT_FOUND", "外网配对设备不存在。");
    this.disconnect(raw);
    this.saved.devices = this.saved.devices.filter(device => device.id !== raw);
    this.persist(); this.changed();
  }
  request(id: string, method: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.broker.request(id, method, body, signal);
  }
  connection(id: string): string | undefined { return this.broker.connection(id); }
  offerArtifact(id: string, file: string, bytes: number, sha256: string, authorize: () => Promise<void>) {
    const connectionId = this.connection(id);
    if (!connectionId || !path.isAbsolute(file) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 512 * 1024 * 1024)
      throw internetFault("PHONE_INVALID_REQUEST", "外网安装需要当前连接和不超过 512 MiB 的 APK。");
    secret.parse(sha256);
    if (this.artifacts.size >= 8) throw internetFault("PHONE_TARGET_BUSY", "外网安装任务过多。");
    const artifactId = randomBytes(32).toString("hex");
    this.artifacts.set(artifactId, { id, connectionId, file, bytes, sentBytes: 0, expiresAt: this.now() + 600000, authorize });
    return { artifactId, connectionId, bytes, sha256 };
  }
  revokeArtifact(artifactId: string): void { this.artifacts.delete(artifactId); }
  private disconnect(raw: string, expected?: string): void {
    const current = this.live.get(raw);
    if (!current || expected !== undefined && current.connectionId !== expected) return;
    this.live.delete(raw); this.broker.disconnect(`internet-${raw}`, current.connectionId);
    for (const [key, value] of this.artifacts) if (value.id === `internet-${raw}`) this.artifacts.delete(key);
    this.options.disconnected?.(`internet-${raw}`, current.connectionId); this.changed();
  }
  private expire(): void {
    for (const [id, live] of this.live) if (this.now() - live.seenAt > 35000) this.disconnect(id, live.connectionId);
    for (const [key, value] of this.invitations) if (value.expiresAt <= this.now()) this.invitations.delete(key);
    for (const [key, value] of this.rates) if (this.now() - value.at > 60000) this.rates.delete(key);
    for (const [key, value] of this.artifacts) if (value.expiresAt <= this.now()) this.artifacts.delete(key);
  }
  private limit(key: string, maximum: number): void {
    let value = this.rates.get(key);
    if (!value || this.now() - value.at >= 60000) {
      if (this.rates.size >= 4096) this.expire();
      if (this.rates.size >= 4096) throw Object.assign(internetFault("PHONE_RATE_LIMITED", "连接请求过多，请稍后再试。"), { httpStatus: 429 });
      this.rates.set(key, value = { at: this.now(), count: 0 });
    }
    if (++value.count > maximum) throw Object.assign(internetFault("PHONE_RATE_LIMITED", "连接请求过多，请稍后再试。"), { httpStatus: 429 });
  }
  private async body(request: IncomingMessage, maximum: number): Promise<unknown> {
    if (request.headers["transfer-encoding"] || !/^\d+$/.test(String(request.headers["content-length"] || ""))
      || Number(request.headers["content-length"]) > maximum) throw internetFault("PHONE_INVALID_REQUEST", "请求长度无效。");
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maximum) throw internetFault("PHONE_INVALID_REQUEST", "请求内容过大。");
      chunks.push(Buffer.from(chunk));
    }
    if (size !== Number(request.headers["content-length"])) throw internetFault("PHONE_INVALID_REQUEST", "请求内容不完整。");
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  private reply(response: ServerResponse, status: number, body: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    const bytes = Buffer.from(JSON.stringify(body));
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": bytes.length, "Cache-Control": "no-store" });
    response.end(bytes);
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== "POST" || !["/v1/pair", "/v1/connect", "/v1/poll", "/v1/result", "/v1/disconnect", "/v1/artifact"].includes(request.url || "")) {
        this.reply(response, 404, { ok: false, code: "PHONE_ROUTE_NOT_FOUND" }); return;
      }
      this.limit(`ip:${request.socket.remoteAddress || "unknown"}`, 1200);
      const token = secret.parse(/^Bearer ([a-f0-9]{64})$/.exec(String(request.headers.authorization || ""))?.[1]);
      if (request.url === "/v1/pair") {
        this.limit(`pair:${request.socket.remoteAddress || "unknown"}`, 12);
        const invitation = this.invitations.get(hash(token));
        if (!invitation || invitation.expiresAt <= this.now()) throw Object.assign(internetFault("PHONE_PAIRING_REQUIRED", "配对链接已失效。"), { httpStatus: 401 });
        const input = z.object({ serverId: uuid, deviceId: uuid, name: z.string().min(1).max(80), token: secret }).strict().parse(await this.body(request, 4096));
        if (input.serverId !== this.saved.id) throw internetFault("PHONE_PAIRING_REQUIRED", "配对电脑身份不匹配。");
        const tokenHash = hash(input.token);
        if (invitation.claimed && (invitation.claimed.id !== input.deviceId || !same(invitation.claimed.tokenHash, tokenHash)))
          throw internetFault("PHONE_PAIRING_REQUIRED", "此配对链接已被使用。");
        const existing = this.saved.devices.find(device => device.id === input.deviceId);
        if (existing && !same(existing.tokenHash, tokenHash)) throw internetFault("PHONE_PAIRING_REQUIRED", "此手机已配对，请先移除原连接后重新配对。");
        if (!existing) {
          if (this.saved.devices.length >= 32) throw internetFault("PHONE_TARGET_BUSY", "已配对设备数量达到上限。");
          this.saved.devices.push({ id: input.deviceId, name: input.name, tokenHash, pairedAt: this.now() });
          this.persist();
        }
        invitation.claimed = { id: input.deviceId, tokenHash }; this.changed();
        this.reply(response, 200, { ok: true, serverId: this.saved.id, computer: this.options.computer, deviceId: input.deviceId }); return;
      }
      const device = this.saved.devices.find(value => same(value.tokenHash, hash(token)));
      if (!device) throw Object.assign(internetFault("PHONE_PAIRING_REQUIRED", "外网配对已失效。"), { httpStatus: 401 });
      this.limit(`device:${device.id}`, 900);
      const raw = await this.body(request, request.url === "/v1/result" ? 4 * 1024 * 1024 + 4096 : 4096);
      if (request.url === "/v1/artifact") {
        const part = z.object({ deviceId: uuid, connectionId: uuid, artifactId: secret, offset: z.number().int().nonnegative() }).strict().parse(raw);
        const artifact = this.artifacts.get(part.artifactId);
        const id = `internet-${device.id}`;
        if (!artifact || part.deviceId !== device.id || artifact.id !== id || artifact.connectionId !== part.connectionId
            || this.connection(id) !== part.connectionId || artifact.expiresAt <= this.now() || part.offset >= artifact.bytes)
          throw internetFault("PHONE_CONNECTION_REQUIRED", "安装文件授权已失效。");
        await artifact.authorize();
        const file = await fs.promises.open(artifact.file, "r");
        try {
          const buffer = Buffer.alloc(Math.min(768 * 1024, artifact.bytes - part.offset));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, part.offset);
          if (!bytesRead) throw internetFault("PHONE_INVALID_REQUEST", "安装文件已改变。");
          await artifact.authorize();
          this.reply(response, 200, { ok: true, offset: part.offset, base64: buffer.subarray(0, bytesRead).toString("base64") });
          artifact.sentBytes = Math.max(artifact.sentBytes, part.offset + bytesRead);
        } finally { await file.close(); }
        return;
      }
      const input = z.object({ deviceId: uuid, connectionId: uuid, requestId: uuid.optional(), result: z.unknown().optional() }).strict().parse(raw);
      if (input.deviceId !== device.id) throw internetFault("PHONE_PAIRING_REQUIRED", "手机身份与配对记录不匹配。");
      const id = `internet-${device.id}`;
      if (request.url === "/v1/connect") {
        const old = this.live.get(device.id);
        if (old && old.connectionId !== input.connectionId) { this.diagnostic("reconnect", "PHONE_CONNECTION_REPLACED"); this.disconnect(device.id, old.connectionId); }
        const fresh = !this.live.has(device.id);
        this.broker.connect(id, input.connectionId);
        this.live.set(device.id, { connectionId: input.connectionId, seenAt: this.now() });
        if (fresh) this.options.connected?.(id, device.name, input.connectionId);
        this.changed(); this.reply(response, 200, { ok: true, computer: this.options.computer }); return;
      }
      const live = this.live.get(device.id);
      if (!live || live.connectionId !== input.connectionId) throw internetFault("PHONE_CONNECTION_REQUIRED", "外网连接已改变，请重新连接并核对会话。");
      live.seenAt = this.now();
      if (request.url === "/v1/disconnect") {
        this.disconnect(device.id, input.connectionId); this.reply(response, 200, { ok: true }); return;
      }
      if (request.url === "/v1/result") {
        if (!input.requestId || input.result === undefined) throw internetFault("PHONE_INVALID_REQUEST", "缺少操作回执。");
        this.broker.respond(id, input.connectionId, input.requestId, input.result);
        this.reply(response, 200, { ok: true }); return;
      }
      const abort = new AbortController();
      const cancel = () => abort.abort();
      response.once("close", cancel);
      try { this.reply(response, 200, { ok: true, command: await this.broker.poll(id, input.connectionId, abort.signal) }); }
      finally { response.removeListener("close", cancel); }
    } catch (error) {
      const fault = error as { code?: string; httpStatus?: number; message?: string; actionOutcome?: string };
      this.diagnostic("request-rejected", fault.code || "PHONE_INVALID_REQUEST", /^\/v1\/[a-z-]+$/.test(request.url || "") ? request.url! : "");
      this.reply(response, fault.httpStatus || 400, { ok: false, code: fault.code || "PHONE_INVALID_REQUEST",
        error: fault.code ? fault.message : "外网控制请求无效。", actionOutcome: fault.actionOutcome || "not-executed" });
    }
  }
  private async stopListening(): Promise<void> {
    clearInterval(this.timer); this.timer = undefined;
    this.invitations.clear();
    for (const id of [...this.live.keys()]) this.disconnect(id);
    const server = this.server; this.server = undefined;
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.starting) await this.starting.catch(() => {});
    await this.stopListening(); this.broker.close();
  }
}
