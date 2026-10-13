import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { z } from "zod";
import { deviceShell, findAdb, type AdbRunner } from "./adb";
import type { ScreenCameraCapabilities, ScreenCameraSource, ScreenCameraCrop, ScreenCameraStart, ScreenCameraState, ScreenCameraCommand } from "../../shared/screen-camera";

export const cameraLeaseSchema = z.object({ id: z.string().min(1), sessionId: z.string().min(1).max(100), generation: z.number().int().nonnegative() });
export const cameraCropSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict()
  .refine(crop => crop.x + crop.width <= 1.000001 && crop.y + crop.height <= 1.000001, "截取区域超出画面");
export const cameraStartSchema = cameraLeaseSchema.extend({ sourceId: z.string().min(1).max(300).optional(), crop: cameraCropSchema.optional() }).strict();
export const cameraCommandSchema = z.discriminatedUnion("op", [
  cameraLeaseSchema.extend({ op: z.enum(["status", "preview", "apps", "stop"]) }).strict(),
  cameraLeaseSchema.extend({ op: z.literal("frame"), base64: z.string().min(4).max(2800000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict(),
  cameraLeaseSchema.extend({ op: z.literal("launch"), component: z.string().regex(/^[a-zA-Z0-9_.$]+\/[a-zA-Z0-9_.$]+$/).max(500) }).strict(),
  cameraLeaseSchema.extend({ op: z.literal("tap"), x: z.number().int().min(0).max(719), y: z.number().int().min(0).max(1279) }).strict(),
  cameraLeaseSchema.extend({ op: z.literal("key"), key: z.literal("back") }).strict()
]);
export interface CameraCapture {
  sources(): Promise<ScreenCameraSource[]>;
  capture(sourceId: string, crop?: ScreenCameraCrop): Promise<string>;
}
export interface CameraWorker {
  request(op: string, params?: Record<string, unknown>): Promise<any>;
  close(): void;
}
export interface CameraOptions {
  adb: AdbRunner; root: string; dexPath: string; capture?: CameraCapture;
  authorize(input: { id: string; sessionId: string; generation: number }): Promise<{ instanceId: string; token: string }>;
  spawnWorker?: (id: string, remote: string) => CameraWorker;
  changed?: () => void;
}

/** Length-prefixed stdin preserves images on Windows and avoids placing credentials in argv. */
export class AndroidCameraWorker implements CameraWorker {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private closed = false;
  constructor(id: string, remote: string, executable = findAdb()) {
    this.child = spawn(executable, ["-s", id, "shell", "-T", deviceShell(["env", `CLASSPATH=${remote}`, "app_process", "/", "io.github.profilepilot.camera.ScreenCamera"])],
      { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let diagnostic = "";
    this.child.stderr.on("data", bytes => { diagnostic = (diagnostic + bytes.toString("utf8")).slice(-2000); });
    this.child.on("error", () => this.fail("无法启动 Android 屏幕摄像头"));
    this.child.on("close", () => this.fail(`Android 屏幕摄像头已退出${diagnostic ? `：${diagnostic.replace(/[a-f0-9]{64}/gi, "[credential]")}` : ""}`));
    this.child.stdin.on("error", () => this.fail("屏幕摄像头连接已断开"));
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", line => {
      if (line.length > 8 * 1024 * 1024) { this.fail("屏幕摄像头响应过大"); return; }
      let reply: { id: number; ok: boolean; data?: unknown; error?: string };
      try { reply = JSON.parse(line); } catch { return; } // app_process can print startup diagnostics.
      const waiting = this.pending.get(reply.id); if (!waiting) return;
      this.pending.delete(reply.id); clearTimeout(waiting.timer);
      if (reply.ok) waiting.resolve(reply.data); else waiting.reject(new Error(reply.error || "屏幕摄像头操作失败"));
    });
  }
  request(op: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error("屏幕摄像头连接已关闭"));
    if (this.pending.size > 8) return Promise.reject(new Error("屏幕摄像头正在处理操作"));
    const id = ++this.sequence, bytes = Buffer.from(JSON.stringify({ ...params, op, id }));
    if (bytes.length > 3 * 1024 * 1024) return Promise.reject(new Error("屏幕摄像头请求过大"));
    const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("屏幕摄像头操作结果未返回，请先检查窗口状态")); this.close(); }, op === "start" ? 20000 : 8000);
      this.pending.set(id, { resolve, reject, timer }); this.child.stdin.write(Buffer.concat([header, bytes]));
    });
  }
  private fail(message: string): void {
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear();
  }
  close(): void {
    this.fail("屏幕摄像头已停止"); this.child.stdin.end();
    // EOF lets Android close its camera, display and association before the host transport exits.
    const timer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill(); }, 4000); timer.unref();
  }
}

export class ScreenCamera {
  private worker?: CameraWorker;
  private state?: ScreenCameraState;
  private starting = false;
  private startingLease?: ScreenCameraStart;
  private startingWorker?: CameraWorker;
  private version = 0;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private detachOwner?: () => void;
  constructor(private options: CameraOptions) {}
  snapshot(id: string): ScreenCameraState | undefined { return this.state?.id === id ? structuredClone(this.state) : undefined; }
  async sources(): Promise<ScreenCameraSource[]> {
    if (!this.options.capture) throw new Error("当前运行环境不支持电脑画面采集");
    return this.options.capture.sources();
  }
  async probe(id: string): Promise<ScreenCameraCapabilities> {
    const sdk = Number(await this.options.adb.run(["-s", id, "shell", deviceShell(["getprop", "ro.build.version.sdk"])]));
    const release = (await this.options.adb.run(["-s", id, "shell", deviceShell(["getprop", "ro.build.version.release"])] )).slice(0, 30);
    if (!Number.isInteger(sdk) || sdk < 36) return { sdk: Number.isInteger(sdk) ? sdk : 0, release, supported: false, reason: "屏幕摄像头需要 Android 16 或更新版本；旧系统不能使用此功能" };
    const worker = await this.prepareWorker(id);
    try { return await worker.request("probe"); } finally { worker.close(); }
  }
  private async prepareWorker(id: string): Promise<CameraWorker> {
    if (!fs.existsSync(this.options.dexPath)) throw new Error("缺少屏幕摄像头组件，请运行 npm run build:screen-camera 或更新完整安装包");
    const bytes = fs.readFileSync(this.options.dexPath), hash = createHash("sha256").update(bytes).digest("hex");
    fs.mkdirSync(this.options.root, { recursive: true });
    const local = path.join(this.options.root, "profilepilot-screen-camera.dex");
    fs.writeFileSync(local, bytes, { mode: 0o600 });
    const remote = `/data/local/tmp/profilepilot-camera-${hash.slice(0, 20)}.dex`;
    await this.options.adb.run(["-s", id, "push", local, remote], 20000);
    return this.options.spawnWorker?.(id, remote) || new AndroidCameraWorker(id, remote);
  }
  async start(raw: ScreenCameraStart, owner?: { signal: AbortSignal; detached(): void }): Promise<ScreenCameraState> {
    const input = cameraStartSchema.parse(raw);
    if (this.starting || this.worker) throw new Error("已有屏幕摄像头会话，请先关闭它");
    if (owner?.signal.aborted) throw new Error("扫码窗口已关闭");
    this.starting = true; const version = ++this.version;
    this.startingLease = input;
    if (owner) {
      const abort = () => this.stop("扫码窗口已关闭");
      owner.signal.addEventListener("abort", abort, { once: true });
      this.detachOwner = () => { owner.signal.removeEventListener("abort", abort); owner.detached(); };
    }
    let worker: CameraWorker | undefined;
    try {
      const lease = await this.options.authorize(input);
      if (version !== this.version) throw new Error("屏幕摄像头启动已取消");
      if (input.sourceId && !(await this.sources()).some(source => source.id === input.sourceId)) throw new Error("选定的电脑窗口已关闭，请重新选择");
      const supported = await this.probe(input.id);
      if (!supported.supported) throw new Error(supported.reason);
      if (version !== this.version) throw new Error("屏幕摄像头启动已取消");
      worker = await this.prepareWorker(input.id);
      this.startingWorker = worker;
      if (version !== this.version) throw new Error("屏幕摄像头启动已取消");
      await this.options.authorize(input);
      const result = await worker.request("start", { lease: { ...lease, sessionId: input.sessionId, generation: input.generation } });
      if (version !== this.version) throw new Error("屏幕摄像头启动已取消");
      this.worker = worker;
      const state: ScreenCameraState = { ...input, ...result, active: true, error: "" };
      this.state = state;
      await this.tick();
      if (!state.active) throw new Error(state.error);
      this.timer = setInterval(() => void this.tick(), input.sourceId ? 300 : 1000); this.timer.unref();
      this.options.changed?.(); return structuredClone(state);
    } catch (error) { worker?.close(); this.worker = undefined; this.detachOwner?.(); this.detachOwner = undefined; throw error; }
    finally { this.starting = false; this.startingLease = undefined; this.startingWorker = undefined; }
  }
  private async tick(): Promise<void> {
    if (this.ticking || !this.worker || !this.state?.active) return;
    this.ticking = true; const worker = this.worker, state = this.state;
    try {
      await this.options.authorize(state);
      let result;
      if (state.sourceId) {
        const base64 = await this.options.capture!.capture(state.sourceId, state.crop);
        if (worker !== this.worker) return;
        await this.options.authorize(state);
        result = await worker.request("frame", { base64 });
      } else result = await worker.request("pulse");
      if (worker === this.worker) {
        if (result?.error) throw new Error(result.error);
        Object.assign(state, result);
      }
    } catch (error) { if (worker === this.worker) this.stop((error as Error).message); }
    finally { this.ticking = false; }
  }
  async command(raw: ScreenCameraCommand): Promise<any> {
    const input = cameraCommandSchema.parse(raw), state = this.state;
    if (input.op === "stop" && this.startingLease?.id === input.id && this.startingLease.sessionId === input.sessionId && this.startingLease.generation === input.generation) {
      this.stop(); return { active: false };
    }
    if (!state || input.id !== state.id || input.sessionId !== state.sessionId || input.generation !== state.generation) throw new Error("屏幕摄像头会话已改变，请重新读取状态");
    if (input.op === "stop") { this.stop(); return this.snapshot(input.id); }
    if (input.op === "status") return this.snapshot(input.id);
    if (!this.worker || !state.active) throw new Error(state.error || "屏幕摄像头已停止");
    const worker = this.worker;
    try { await this.options.authorize(input); }
    catch (error) { if (worker === this.worker) this.stop((error as Error).message); throw error; }
    if (worker !== this.worker) throw new Error("屏幕摄像头会话已停止");
    const result = await worker.request(input.op, input);
    if (worker !== this.worker) throw new Error("屏幕摄像头会话已停止");
    if (result?.error) { this.stop(result.error); throw new Error(result.error); }
    if (!["preview", "apps"].includes(input.op)) Object.assign(state, result);
    return result;
  }
  stop(error = ""): void {
    this.version++; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    this.detachOwner?.(); this.detachOwner = undefined;
    this.worker?.close(); this.worker = undefined; this.startingWorker?.close(); this.startingWorker = undefined;
    if (this.state) { this.state.active = false; this.state.error = error; }
    this.options.changed?.();
  }
  stopFor(id: string, error = ""): void { if (this.state?.active && this.state.id === id || this.startingLease?.id === id) this.stop(error); }
}
