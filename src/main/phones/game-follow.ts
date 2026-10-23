import fs from "node:fs";
import path from "node:path";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay, performance, type IntervalHistogram } from "node:perf_hooks";
import { z } from "zod";
import type { FollowAnalysis, FollowCommand, FollowFrame, FollowRuntime, FollowStatus, GameFollowConfig } from "../../shared/game-follow";
import type { PhoneDevice } from "../../shared/phones";
import { adbLaunchDelays, phoneRequestTimings } from "./adb";
import { cameraProofSchema, captureReadyAt } from "./screenshot-transfer";
import { GameFollowCamera } from "./game-follow-camera";
import { CameraSampler, cameraSampleCommandSchema } from "./camera-sample";

const unit = z.number().finite().min(0).max(1);
const image = z.string().min(16).max(4_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/);
const rect = z.object({ x: unit, y: unit, width: unit.min(.015), height: unit.min(.015) }).strict()
  .refine(r => r.x + r.width <= 1.00001 && r.y + r.height <= 1.00001, "选区超出画面");
const hudRect = z.object({ x: unit, y: unit, width: unit.min(.001), height: unit.min(.001) }).strict()
  .refine(r => r.x + r.width <= 1 && r.y + r.height <= 1, "存活提示选区超出画面");
const targetRingSchema = z.object({ hueMin: z.number().int().min(0).max(179), hueMax: z.number().int().min(0).max(179),
  saturationMin: z.number().int().min(1).max(255), valueMin: z.number().int().min(1).max(255),
  radiusPixels: z.number().finite().min(5).max(100) }).strict().refine(r => r.hueMin <= r.hueMax, "颜色范围无效");
const cameraAssistSchema = z.object({
    referenceWidth: z.number().int().min(100).max(5000), referenceHeight: z.number().int().min(100).max(5000),
    targetLabel: image.max(256_000), healthBarTemplate: image.max(256_000),
    healthBar: z.object({ width: z.number().int().min(20).max(500), height: z.number().int().min(8).max(80),
      offsetX: z.number().finite().min(-500).max(500), offsetY: z.number().finite().min(-100).max(200) }).strict(),
    region: rect,
    matrix: z.tuple([z.tuple([z.number().finite().min(-10000).max(10000), z.number().finite().min(-10000).max(10000)]),
      z.tuple([z.number().finite().min(-10000).max(10000), z.number().finite().min(-10000).max(10000)]),
      z.tuple([z.number().finite().min(-10000).max(10000), z.number().finite().min(-10000).max(10000)])]),
    anchorBounds: z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative(),
      width: z.number().finite().positive(), height: z.number().finite().positive() }).strict(),
    projectionErrorPx: z.number().finite().nonnegative().max(100).optional()
  }).strict();
export const gameFollowConfigSchema = z.object({
  version: z.literal(1), name: z.string().trim().min(1).max(80),
  width: z.number().int().min(100).max(5000), height: z.number().int().min(100).max(5000),
  map: rect, selfTemplate: image, targetTemplate: image, selfRotates: z.boolean(),
  grid: z.object({ columns: z.number().int().min(16).max(100), rows: z.number().int().min(16).max(100),
    blocked: z.array(z.number().int().min(0)).max(10000), clearance: z.number().int().min(0).max(3) }).strict()
    .refine(g => g.blocked.every(i => i < g.columns * g.rows), "障碍格超出地图"),
  joystick: z.object({ x: unit, y: unit, radius: z.number().finite().min(.01).max(.2),
    rotation: z.number().finite().min(-180).max(180) }).strict(),
  confidence: z.number().finite().min(.65).max(.999), stopDistance: z.number().finite().min(.02).max(.3),
  intervalMs: z.number().int().min(350).max(1000),
  capture: z.enum(["auto", "full"]).optional(),
  nearby: z.object({ selfLabel: image, targetLabel: image, region: rect,
    pixelsPerMapUnit: z.number().finite().min(100).max(100000) }).strict().optional(),
  selfMarker: z.object({ hueMin: z.number().int().min(0).max(179), hueMax: z.number().int().min(0).max(179),
    saturationMin: z.number().int().min(0).max(255), valueMin: z.number().int().min(0).max(255),
    radiusPixels: z.number().finite().min(3).max(100), partialArc: z.boolean().optional()
  }).strict().refine(m => m.hueMin <= m.hueMax, "颜色范围无效").optional(),
  targetRing: targetRingSchema.optional(),
  targetPartial: z.object({
    ring: targetRingSchema,
    alive: z.object({ portraitTemplate: image.max(256_000), portraitRegion: hudRect, healthBarRegion: hudRect }).strict()
  }).strict().optional(),
  cameraAssist: cameraAssistSchema.extend({ team: z.literal("blue").optional() }).strict().optional(),
  selfCameraAssist: cameraAssistSchema.extend({ team: z.literal("green") }).strict().optional()
}).strict().refine(c => c.width * c.height <= 8_000_000, "画面过大")
  .refine(c => [c.cameraAssist, c.selfCameraAssist].every(a => !a || a.referenceWidth === c.width && a.referenceHeight === c.height
    && a.anchorBounds.x + a.anchorBounds.width <= c.width
    && a.anchorBounds.y + a.anchorBounds.height <= c.height), "镜头校准尺寸或有效范围不匹配")
  .refine(c => {
    const j = c.joystick, r = j.radius * Math.min(c.width, c.height);
    return j.x * c.width >= r && (1 - j.x) * c.width >= r && j.y * c.height >= r && (1 - j.y) * c.height >= r;
  }, "摇杆范围超出屏幕");
const frameSchema = z.object({ mime: z.enum(["image/jpeg", "image/png"]), base64: image,
  width: z.number().int().min(100).max(5000), height: z.number().int().min(100).max(5000),
  cameraProof: cameraProofSchema.optional(),
  region: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(),
    width: z.number().int().positive(), height: z.number().int().positive() }).strict().optional()
}).strict().refine(f => !f.region || f.region.x + f.region.width <= f.width && f.region.y + f.region.height <= f.height, "截图区域超出原始画面")
  .refine(f => !f.cameraProof || !f.region && f.cameraProof.x < f.width && f.cameraProof.y < f.height, "镜头凭据需要完整画面");

function mapCaptureRegion(config: GameFollowConfig) {
  const r = config.map, x = Math.floor(r.x * config.width), y = Math.floor(r.y * config.height);
  // Include the independently rounded origin/size used by existing vision,
  // including half-pixel ties, without resampling the minimap's native pixels.
  const right = Math.min(config.width, Math.max(Math.ceil((r.x + r.width) * config.width), Math.round(r.x * config.width) + Math.round(r.width * config.width)));
  const bottom = Math.min(config.height, Math.max(Math.ceil((r.y + r.height) * config.height), Math.round(r.y * config.height) + Math.round(r.height * config.height)));
  return { x, y, width: right - x, height: bottom - y };
}
export const followCommandSchema = z.discriminatedUnion("op", [
  cameraSampleCommandSchema,
  z.object({ op: z.enum(["runtime", "setup", "status", "load"]) }).strict(),
  z.object({ op: z.literal("save"), config: gameFollowConfigSchema }).strict(),
  z.object({ op: z.literal("analyze"), config: gameFollowConfigSchema, frame: frameSchema }).strict(),
  z.object({ op: z.literal("start"), id: z.string().min(1).max(200), mode: z.enum(["observe", "control"]), backend: z.enum(["app", "basic"]).default("app"), recoverTransport: z.boolean().optional(), config: gameFollowConfigSchema }).strict(),
  z.object({ op: z.literal("stop"), runId: z.string().uuid() }).strict()
]);
type Python = { executable: string; args: string[] };
function execute(executable: string, args: string[], timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => execFile(executable, args, { windowsHide: true, timeout, maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => error ? reject(new Error(stderr.trim().slice(-800) || error.message)) : resolve(stdout.trim())));
}
export class VisionWorker {
  private child: ChildProcessWithoutNullStreams;
  private pending?: { id: string; resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout };
  private buffer = "";
  private ended = false;
  constructor(python: Python, script: string) {
    this.child = spawn(python.executable, [...python.args, "-u", script], {
      windowsHide: true, stdio: "pipe", env: { ...process.env, PYTHONIOENCODING: "utf-8" }
    });
    let stderr = "";
    this.child.stderr.on("data", value => { stderr = (stderr + value).slice(-1000); });
    this.child.stdin.on("error", () => this.fail(new Error("视觉进程连接已关闭")));
    this.child.on("error", error => { this.ended = true; this.fail(error); });
    this.child.on("exit", () => { this.ended = true; this.fail(new Error(stderr || "视觉进程已退出")); });
    this.child.stdout.on("data", chunk => {
      this.buffer += chunk.toString("utf8");
      if (this.buffer.length > 2_000_000) { this.close(); return; }
      let index: number;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        try {
          const data = JSON.parse(line), pending = this.pending;
          if (!pending || data.id !== pending.id) continue;
          this.pending = undefined; clearTimeout(pending.timer);
          data.ok ? pending.resolve(data.data) : pending.reject(new Error(data.error || "视觉处理失败"));
        } catch { this.fail(new Error("视觉进程返回了无效数据")); }
      }
    });
  }
  request(params: object): Promise<any> {
    if (this.ended) return Promise.reject(new Error("视觉进程已退出"));
    if (this.pending) return Promise.reject(new Error("上一帧仍在处理"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.fail(new Error("视觉处理超时，已停止操作")); this.close(); }, 10000);
      this.pending = { id, resolve, reject, timer };
      this.child.stdin.write(JSON.stringify({ ...params, id }) + "\n");
    });
  }
  private fail(error: Error) {
    if (this.pending) { const p = this.pending; this.pending = undefined; clearTimeout(p.timer); p.reject(error); }
  }
  close() { this.ended = true; this.fail(new Error("视觉处理已停止")); this.child.kill(); }
}
export interface FollowHost {
  startWrapper(id: string, mode: "view" | "control", controller: string, task: string, backend?: "app" | "basic", recoverTransport?: boolean): Promise<{ lease: string; device: PhoneDevice }>;
  pulseWrapper(lease: string): PhoneDevice;
  syncWrapper(lease: string): Promise<PhoneDevice>;
  recoverWrapper?(lease: string, generation: number): Promise<PhoneDevice>;
  stopWrapper(lease: string): Promise<void>;
  live(lease: string, generation: number, command: object): Promise<any>;
}
type Run = { id: string; lease?: string; generation: number; sequence: number; cancelled: boolean;
  recoverTransport: boolean; recoveryEpoch: number; recovery?: Promise<boolean>; resetVision?: boolean;
  worker?: VisionWorker; starting?: Promise<void>; done?: Promise<void>; stop?: Promise<void>; cleanup?: Promise<void>; heartbeat?: NodeJS.Timeout;
  heartbeatPending?: Promise<void>; lastHeartbeatAt?: number; heartbeatTickAt?: number;
  beganAt?: number; eventLoop?: IntervalHistogram; camera?: GameFollowCamera };
export class GameFollower {
  private readonly cameraSampler: CameraSampler;
  private python?: Python;
  private preview?: VisionWorker;
  private previewConfig = "";
  private analyzing = false;
  private setupJob?: Promise<FollowRuntime>;
  private run?: Run;
  private closing = false;
  private value: FollowStatus = { running: false, frames: 0, actions: 0, fps: 0, error: "" };
  readonly script = path.resolve(__dirname, "../../../public/vision/game_follower.py").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
  constructor(private root: string, private host: FollowHost) { this.cameraSampler = new CameraSampler(host); }
  private get managedPython() { return path.join(this.root, "vision-runtime", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"); }
  private candidates(): Python[] {
    return [
      ...(fs.existsSync(this.managedPython) ? [{ executable: this.managedPython, args: [] }] : []),
      ...(process.env.PROFILEPILOT_PYTHON ? [{ executable: process.env.PROFILEPILOT_PYTHON, args: [] }] : []),
      { executable: process.platform === "win32" ? "python" : "python3", args: [] },
      ...(process.platform === "win32" ? [{ executable: "py", args: ["-3"] }] : [])
    ];
  }
  async runtime(): Promise<FollowRuntime> {
    for (const python of this.candidates()) {
      try {
        const version = await execute(python.executable, [...python.args, "-c", "import cv2,numpy,sys; assert sys.version_info >= (3,10); print(cv2.__version__)"]);
        this.python = python; return { available: true, python: python.executable, version, error: "" };
      } catch { /* Try other installed Python interpreters, without modifying them. */ }
    }
    return { available: false, python: "", version: "", error: "需要 Python 3.10+ 和 OpenCV。可安装视觉组件；若未安装 Python，请先安装 Python。" };
  }
  async setup(): Promise<FollowRuntime> {
    if (this.setupJob) return this.setupJob;
    this.setupJob = (async () => {
      for (const python of this.candidates()) {
        try { await execute(python.executable, [...python.args, "-c", "import sys; assert sys.version_info >= (3,10)"]); }
        catch { continue; }
        const envPath = path.dirname(path.dirname(this.managedPython));
        if (!fs.existsSync(this.managedPython)) await execute(python.executable, [...python.args, "-m", "venv", envPath], 90000);
        await execute(this.managedPython, ["-m", "pip", "install", "opencv-python-headless==4.12.0.88", "numpy==2.2.6"], 240000);
        return this.runtime();
      }
      throw new Error("未找到 Python 3.10+。安装 Python 后重新点击安装视觉组件。");
    })().finally(() => { this.setupJob = undefined; });
    return this.setupJob;
  }
  async command(input: FollowCommand): Promise<any> {
    const command = followCommandSchema.parse(input);
    if (this.closing) throw new Error("ProfilePilot 正在退出");
    if (command.op === "runtime") return this.runtime();
    if (command.op === "setup") return this.setup();
    if (command.op === "status") return structuredClone(this.value);
    const file = path.join(this.root, "game-follow.json");
    if (command.op === "load") return fs.existsSync(file) ? gameFollowConfigSchema.parse(JSON.parse(await fs.promises.readFile(file, "utf8"))) : null;
    if (command.op === "save") {
      await fs.promises.mkdir(this.root, { recursive: true });
      const temporary = file + "." + randomUUID() + ".tmp";
      await fs.promises.writeFile(temporary, JSON.stringify(command.config));
      await fs.promises.rename(temporary, file); return command.config;
    }
    if (command.op === "stop") {
      if (this.run?.id !== command.runId) throw new Error("跟随任务已改变，请刷新状态");
      await this.stop(this.run); return structuredClone(this.value);
    }
    if (this.cameraSampler.busy) throw new Error("请等待镜头标定采样结束");
    if (this.run) {
      if (!this.run.cancelled) throw new Error("请先停止当前跟随任务");
      await this.stop(this.run);
    }
    if (command.op === "camera-sample") {
      if (this.analyzing) throw new Error("上一帧仍在分析");
      return this.cameraSampler.sample(command);
    }
    if (command.op === "analyze") {
      if (this.analyzing) throw new Error("上一帧仍在分析");
      this.analyzing = true;
      try {
        await this.ready();
        const key = JSON.stringify(command.config);
        if (!this.preview || this.previewConfig !== key) {
          this.preview?.close(); this.preview = new VisionWorker(this.python!, this.script);
          await this.preview.request({ op: "configure", config: command.config }); this.previewConfig = key;
        }
        if (command.frame.width !== command.config.width || command.frame.height !== command.config.height)
          throw new Error("手机分辨率或方向已改变，请重新校准");
        return await this.preview.request({ op: "analyze", base64: command.frame.base64, region: command.frame.region }) as FollowAnalysis;
      } catch (error) { this.preview?.close(); this.preview = undefined; throw error; }
      finally { this.analyzing = false; }
    }
    if (command.op === "start") return this.start(command.id, command.mode, command.config, command.backend, command.recoverTransport);
    throw new Error("未知视觉跟随操作");
  }
  private async ready() {
    if (!this.python && !(await this.runtime()).available) throw new Error("视觉组件未就绪，请先安装");
  }
  private async start(id: string, mode: "observe" | "control", config: GameFollowConfig, backend: "app" | "basic", recoverTransport = false): Promise<FollowStatus> {
    if ((config.cameraAssist || config.selfCameraAssist) && backend !== "app") throw new Error("镜头辅助需要手机 App 模式");
    if (this.closing) throw new Error("ProfilePilot 正在退出");
    if (this.run && !this.run.cancelled) throw new Error("请先停止当前跟随任务");
    if (this.analyzing) throw new Error("请等待当前图像分析完成");
    const run: Run = { id: randomUUID(), generation: 0, sequence: 0, cancelled: false,
      recoverTransport: recoverTransport && backend === "app", recoveryEpoch: 0 };
    let started!: () => void;
    run.starting = new Promise<void>(resolve => { started = resolve; });
    this.run = run;
    this.value = { running: false, runId: run.id, deviceId: id, mode, backend, frames: 0, actions: 0, fps: 0, error: "" };
    try {
      await this.ready();
      if (run.cancelled) throw new Error("跟随任务已停止");
      run.worker = new VisionWorker(this.python!, this.script);
      // Basic captures can take up to 3 s plus a bounded 350 ms gesture.
      // Recognition continuity must tolerate that cadence; frame age below
      // still independently prevents movement from an overly delayed capture.
      await run.worker.request({ op: "configure", config, maxFrameGapMs: backend === "basic" ? 4000 : 1500 });
      const owner = await this.host.startWrapper(id, mode === "observe" ? "view" : "control", "本机视觉跟随", config.name, backend, run.recoverTransport);
      run.lease = owner.lease; run.generation = owner.device.state!.generation;
      if (run.cancelled) throw new Error("跟随任务已停止");
      const probe = await this.host.live(run.lease, run.generation, { op: "probe" });
      if (probe?.protocol !== 1) throw new Error("请更新手机开发版 App，以启用视觉跟随");
      if ((config.cameraAssist || config.selfCameraAssist) && probe?.cameraFrameProvenance !== 1) throw new Error("请更新手机开发版 App，以启用镜头画面凭据");
      run.camera = new GameFollowCamera({ enabled: !!(config.cameraAssist || config.selfCameraAssist), mode, backend,
        provenanceVersion: probe?.cameraFrameProvenance, targetEnabled: !!config.cameraAssist, intervalMs: config.intervalMs,
        ...(config.cameraAssist ? { placement: { ...config, cameraAssist: config.cameraAssist } } : {}),
        ...(config.selfCameraAssist ? { selfPlacement: { ...config, cameraAssist: config.selfCameraAssist } } : {}) });
      if (run.cancelled) throw new Error("跟随任务已停止");
      this.value = { running: true, runId: run.id, deviceId: id, mode, backend, frames: 0, actions: 0, fps: 0, error: "" };
      run.beganAt = Date.now(); run.heartbeatTickAt = performance.now();
      run.eventLoop = monitorEventLoopDelay({ resolution: 20 }); run.eventLoop.enable();
      run.heartbeat = setInterval(() => {
        const epoch = run.recoveryEpoch;
        try {
          // Measure when this host timer actually runs, independently of the
          // authenticated phone response. A late timer is not lease evidence.
          const tickAt = performance.now(), lag = Math.max(0, Math.round(tickAt - run.heartbeatTickAt! - 1000));
          run.heartbeatTickAt = tickAt;
          this.value.timings = { ...this.value.timings, heartbeatTimerLagMs: lag,
            maxHeartbeatTimerLagMs: Math.max(this.value.timings?.maxHeartbeatTimerLagMs || 0, lag) };
          this.sampleHostTimings(run);
          if (run.recovery) return;
          const state = this.host.pulseWrapper(run.lease!).state;
          if (!state || state.generation !== run.generation || !["viewing", "controlling", "executing"].includes(state.phase)) throw new Error("手机已暂停或会话已改变");
          // pulseWrapper only keeps the host-side owner alive. The phone's
          // separate eight-second lease needs a real authenticated sync, even
          // while discovery, another device, or this capture is slow.
          const sentAt = Date.now();
          if (!run.heartbeatPending) run.heartbeatPending = this.host.syncWrapper(run.lease!).then(device => {
            if (run.cancelled || this.run !== run || epoch !== run.recoveryEpoch) return;
            const current = device.state;
            if (!current || current.generation !== run.generation || !["viewing", "controlling", "executing"].includes(current.phase)) throw new Error("手机已暂停或会话已改变");
            const now = Date.now();
            this.value.timings = { ...this.value.timings, heartbeatMs: now - sentAt,
              ...(run.lastHeartbeatAt === undefined ? {} : { heartbeatGapMs: now - run.lastHeartbeatAt }) };
            run.lastHeartbeatAt = now;
          }).catch(error => {
            this.heartbeatFailed(run, epoch, error);
          }).finally(() => { run.heartbeatPending = undefined; });
        } catch (error) { this.heartbeatFailed(run, epoch, error); }
      }, 1000);
      run.done = this.loop(run, config, mode, backend);
      return structuredClone(this.value);
    } catch (error) {
      run.cancelled = true; clearInterval(run.heartbeat); run.eventLoop?.disable(); run.worker?.close();
      await this.cleanup(run); throw error;
    } finally { started(); }
  }
  private sampleHostTimings(run: Run) {
    this.value.timings = { ...this.value.timings,
      eventLoopMaxDelayMs: Math.round((run.eventLoop?.max || 0) / 1_000_000),
      slowAdbStarts: adbLaunchDelays(run.beganAt ?? Date.now()),
      httpRequests: phoneRequestTimings(run.beganAt ?? Date.now()) };
  }
  private sampleCameraStatus(run: Run) {
    if (this.run === run && this.value.camera && run.camera) this.value.camera = run.camera.status(performance.now());
  }
  private heartbeatFailed(run: Run, epoch: number, error: unknown): void {
    if (run.cancelled || this.run !== run || epoch !== run.recoveryEpoch) return;
    void this.tryRecover(run).then(recovered => {
      if (!recovered && !run.cancelled) { this.value.error ||= (error as Error).message; void this.stop(run); }
    });
  }
  private tryRecover(run: Run): Promise<boolean> {
    run.camera?.invalidate("transport-gap");
    this.sampleCameraStatus(run);
    if (run.cancelled || !run.recoverTransport || !this.host.recoverWrapper) return Promise.resolve(false);
    if (run.recovery) return run.recovery;
    run.recoveryEpoch++; this.value.recovering = true;
    run.recovery = Promise.resolve().then(() => this.host.recoverWrapper!(run.lease!, run.generation)).then(device => {
      if (run.cancelled || this.run !== run) return false;
      if (device.state?.generation !== run.generation || !["viewing", "controlling"].includes(device.state.phase))
        throw new Error("手机未确认原来的有效会话，跟随已停止。");
      // Never use an analysis from before the gap. Configure resets tracking,
      // requiring two fresh observations before any new movement decision.
      run.resetVision = true; this.value.analysis = undefined; this.value.error = "";
      this.value.recoveries = (this.value.recoveries || 0) + 1; return true;
    }).catch(error => { if (!run.cancelled && this.run === run) this.value.error = (error as Error).message; return false; })
      .finally(() => { if (this.run === run) this.value.recovering = false; run.recovery = undefined; });
    return run.recovery;
  }
  private async loop(run: Run, config: GameFollowConfig, mode: "observe" | "control", backend: "app" | "basic") {
    const began = Date.now(), cameraEnabled = !!(config.cameraAssist || config.selfCameraAssist);
    const region = backend === "app" && config.capture !== "full" && !config.nearby && !config.targetPartial && !cameraEnabled ? mapCaptureRegion(config) : undefined;
    try {
      while (!run.cancelled) {
        if (run.recovery && !await run.recovery) throw new Error(this.value.error || "跟随连接恢复失败");
        if (run.cancelled) break;
        if (run.resetVision) {
          run.resetVision = false;
          if (mode === "control" && cameraEnabled) {
            await this.host.live(run.lease!, run.generation, { op: "touch", sequence: ++run.sequence, points: [], ttlMs: 1200 });
            if (run.cancelled) break;
          }
          await run.worker!.request({ op: "configure", config, maxFrameGapMs: 1500 });
          if (run.cancelled) break;
        }
        const epoch = run.recoveryEpoch;
        try {
          const at = Date.now(), requestAt = performance.now();
          const rawFrame = await this.host.live(run.lease!, run.generation, { op: "frame", ...(region ? { region } : {}),
            ...(cameraEnabled ? { cameraFrameProvenance: 1 } : {}) });
          const frame: FollowFrame = frameSchema.parse(rawFrame);
          const capturedAt = Date.now();
          // Wi-Fi latency can vary between requests. A late capture followed by an
          // early one can violate Android's screenshot interval even when host
          // request starts are spaced correctly. A full chunked App frame already
          // proves capture completion when its descriptor arrives: downloading its
          // pages may count toward the interval. Only trust the host-local timestamp
          // attached to this exact image; ROI/legacy/basic retain their cadence.
          const completedAt = performance.now();
          const readyAt = backend === "app" && !region && !frame.region ? captureReadyAt(rawFrame) : undefined;
          const intervalAt = backend === "basic" ? requestAt
            : readyAt !== undefined && readyAt >= requestAt && readyAt <= completedAt ? readyAt : completedAt;
          const nextFrameAt = intervalAt + config.intervalMs;
          if (run.cancelled) break;
          if (epoch !== run.recoveryEpoch) continue;
          if (frame.width !== config.width || frame.height !== config.height) throw new Error("手机分辨率或方向已改变，请重新校准");
          const cameraContext = run.camera?.beforeAnalyze(frame.cameraProof, performance.now());
          const analysis: FollowAnalysis = await run.worker!.request({ op: "analyze", base64: frame.base64, region: frame.region,
            ...(cameraContext ? { cameraContext } : {}) });
          if (run.cancelled) break;
          if (epoch !== run.recoveryEpoch) continue;
          this.value.frame = frame; this.value.analysis = analysis; this.value.frames++;
          this.value.timings = { ...this.value.timings, captureMs: capturedAt - at, analysisMs: Date.now() - capturedAt, inputMs: 0 };
          this.value.fps = Math.round(this.value.frames * 10000 / Math.max(1, Date.now() - began)) / 10;
          if (mode === "control") {
            // File captures on older emulators are slower; their movement is a
            // bounded 350 ms stroke. Never move from an unboundedly delayed frame.
            const toNative = (point: FollowAnalysis["target"]) => point
              && Number.isFinite(point.x) && point.x >= 0 && point.x <= 1
              && Number.isFinite(point.y) && point.y >= 0 && point.y <= 1
              ? { x: (config.map.x + point.x * config.map.width) * config.width,
                y: (config.map.y + point.y * config.map.height) * config.height } : undefined;
            // Camera and marker locators already enforce their own current-pixel
            // thresholds. Do not reapply the unrelated portrait threshold.
            const nativeTarget = analysis.target && (analysis.targetSource === "camera"
              || analysis.target.confidence >= config.confidence) ? toNative(analysis.target) : undefined;
            const nativeSelf = analysis.self && (analysis.selfSource === "camera" || analysis.selfSource === "marker"
              || analysis.self.confidence >= config.confidence) ? toNative(analysis.self) : undefined;
            const cameraPlan = run.camera?.afterAnalyze({
              fullTarget: analysis.targetSource === "template" ? nativeTarget : undefined,
              currentTarget: analysis.targetSource !== "camera" ? nativeTarget : undefined,
              cameraTarget: config.cameraAssist && analysis.targetSource === "camera" ? nativeTarget : undefined,
              fullSelf: (!analysis.selfSource || analysis.selfSource === "template") ? nativeSelf : undefined,
              currentSelf: analysis.selfSource !== "camera" ? nativeSelf : undefined,
              markerSelf: analysis.selfSource === "marker" ? nativeSelf : undefined,
              cameraSelf: config.selfCameraAssist && analysis.selfSource === "camera" ? nativeSelf : undefined,
              lost: !nativeTarget, selfLost: !nativeSelf, captureMs: completedAt - requestAt
            }, performance.now() - requestAt, performance.now());
            if (cameraEnabled) this.value.camera = run.camera!.status(performance.now());
            const direction = Date.now() - at < (backend === "basic" ? 3000 : 1000)
              && !cameraPlan?.stopJoystick
              && (analysis.targetSource !== "camera" || !!config.cameraAssist && cameraPlan?.allowCameraMovement)
              && (analysis.selfSource !== "camera" || !!config.selfCameraAssist && cameraPlan?.allowCameraMovement)
              ? analysis.direction : null;
            const joystick = config.joystick, rotation = joystick.rotation * Math.PI / 180;
            const dx = direction ? direction.x * Math.cos(rotation) - direction.y * Math.sin(rotation) : 0;
            const dy = direction ? direction.x * Math.sin(rotation) + direction.y * Math.cos(rotation) : 0;
            const cx = Math.round(joystick.x * config.width), cy = Math.round(joystick.y * config.height);
            const radius = joystick.radius * Math.min(config.width, config.height);
            const points = direction ? [{ id: 0, x: Math.round(cx + dx * radius), y: Math.round(cy + dy * radius), fromX: cx, fromY: cy }] : [];
            if (cameraPlan?.point) points.push({ id: 1, x: cameraPlan.point.x, y: cameraPlan.point.y,
              fromX: cameraPlan.point.x, fromY: cameraPlan.point.y });
            const inputAt = Date.now();
            const sequence = ++run.sequence;
            const accepted = await this.host.live(run.lease!, run.generation, { op: "touch", sequence, points, ttlMs: cameraPlan?.ttlMs ?? 1200 });
            if (run.cancelled) break;
            if (epoch !== run.recoveryEpoch) continue;
            if (cameraEnabled && (accepted?.accepted !== true || accepted?.acceptedSequence !== sequence)) {
              run.camera?.invalidate("uncertain-input"); this.sampleCameraStatus(run); throw new Error("手机未确认本次镜头触控，已停止操作");
            }
            if (cameraPlan && !run.camera!.commit(cameraPlan, sequence, performance.now()))
              throw new Error("镜头触控确认已过期，已停止操作");
            if (cameraEnabled) this.value.camera = run.camera!.status(performance.now());
            this.value.timings = { ...this.value.timings, inputMs: Date.now() - inputAt };
            if (direction) this.value.actions++;
          }
          await new Promise(resolve => setTimeout(resolve, Math.max(0, nextFrameAt - performance.now())));
        } catch (error) {
          if (run.cancelled) break;
          if (epoch !== run.recoveryEpoch) continue;
          if (await this.tryRecover(run)) continue;
          throw error;
        }
      }
    } catch (error) { if (!run.cancelled) this.value.error = (error as Error).message; }
    finally {
      // Do not await run.done from inside its own cleanup.
      run.camera?.invalidate("cancel");
      this.sampleCameraStatus(run);
      run.cancelled = true;
      clearInterval(run.heartbeat); this.sampleHostTimings(run); run.eventLoop?.disable(); run.worker?.close();
      await this.cleanup(run);
      this.value.running = false;
    }
  }
  private async stop(run: Run) {
    if (run.stop) return run.stop;
    run.camera?.invalidate("cancel");
    this.sampleCameraStatus(run);
    run.cancelled = true; clearInterval(run.heartbeat); run.eventLoop?.disable(); run.worker?.close();
    run.stop = (async () => {
      // Revoking the phone session releases held touches even if a frame is pending.
      await this.cleanup(run);
      await run.starting;
      // A lease may have arrived after cancellation while startWrapper was pending.
      await this.cleanup(run);
      await run.done; this.value.running = false;
    })();
    return run.stop;
  }
  private async cleanup(run: Run) {
    if (!run.lease) return;
    run.cleanup ||= this.host.stopWrapper(run.lease).catch(error => { this.value.error ||= (error as Error).message; });
    await run.cleanup;
  }
  async close() { this.closing = true; await this.cameraSampler.close(); if (this.run) await this.stop(this.run); this.preview?.close(); }
}
