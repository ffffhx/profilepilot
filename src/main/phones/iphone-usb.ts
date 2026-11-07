import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { IphoneTools, iphoneUdid, parseGoIosJson } from "./iphone-tools";
import { forwardIphone, type IphoneForward } from "./iphone-usbmux";
import { requestWda, wdaSessionId, type WdaRequest } from "./iphone-wda";
import type { IphoneUsbStatus } from "../../shared/iphones";

export const iphoneBundleId = z.string().regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/).max(255);
export const iphoneUsbInput = z.object({ udid: iphoneUdid, bundleId: iphoneBundleId.optional(), name: z.string().trim().min(1).max(80).optional() }).strict();
type Input = z.infer<typeof iphoneUsbInput>;
type Job = { state: IphoneUsbStatus; abort: AbortController; children: Set<ChildProcess>; forward?: IphoneForward; work?: Promise<void>; stopping?: Promise<void> };
type Hooks = { ready(state: IphoneUsbStatus): Promise<string>; ended(state: IphoneUsbStatus): void; changed(): void };
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const port = (server.address() as net.AddressInfo).port; server.close(() => resolve(port)); });
});

/** Per-device, explicitly started USB jobs. Never use/stop the global go-ios agent. */
export class IphoneUsb {
  private jobs = new Map<string, Job>();
  private closed = false;
  constructor(private tools: IphoneTools, private hooks: Hooks, private forward = forwardIphone, private request: WdaRequest = requestWda) {}
  status(): IphoneUsbStatus[] { return [...this.jobs.values()].map(job => structuredClone(job.state)); }
  start(raw: unknown): IphoneUsbStatus {
    const input = iphoneUsbInput.parse(raw);
    if (this.closed) throw new Error("iPhone USB 服务已关闭。");
    const previous = this.jobs.get(input.udid);
    if (previous && !["error", "stopped"].includes(previous.state.phase)) throw new Error("该 iPhone 已在连接；请查看状态或先停止连接。");
    if (previous?.stopping) throw new Error("上次 USB 连接尚在清理，请稍后重试。");
    const job: Job = { state: { udid: input.udid, name: input.name || "iPhone", bundleId: input.bundleId || "", phase: "checking", message: "检查 USB、信任状态与已安装的控制组件…" }, children: new Set(), abort: new AbortController() };
    this.jobs.set(input.udid, job); this.hooks.changed();
    job.work = this.run(job, input).catch(async error => {
      if (job.abort.signal.aborted) { await this.dispose(job); return; }
      job.state.phase = "error"; job.state.message = (error as Error).message;
      await this.dispose(job); this.hooks.ended(job.state); this.hooks.changed();
    });
    return structuredClone(job.state);
  }
  private check(job: Job): void { job.abort.signal.throwIfAborted(); }
  private phase(job: Job, phase: IphoneUsbStatus["phase"], message: string): void { this.check(job); job.state.phase = phase; job.state.message = message; this.hooks.changed(); }
  private child(job: Job, args: string[], longRunning = true): ChildProcess {
    this.check(job); const child = this.tools.spawn(args); job.children.add(child);
    const failed = () => {
      job.children.delete(child);
      if (longRunning && !job.abort.signal.aborted) {
        const phase = job.state.phase;
        job.state.phase = "error"; job.state.message = phase === "runner" || phase === "ready"
          ? "iPhone 控制组件已退出。请检查开发者模式、证书有效期和 .xctest 签名，再重新连接。"
          : "iPhone USB 隧道已退出。请解锁手机、检查信任状态并重新连接。";
        void this.dispose(job).then(() => { this.hooks.ended(job.state); this.hooks.changed(); });
      }
    };
    child.once("error", failed); child.once("exit", failed); return child;
  }
  private async operation(job: Job, args: string[], timeoutMs: number): Promise<void> {
    const child = this.child(job, args, false);
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); job.abort.signal.removeEventListener("abort", abort); child.off("error", failed); child.off("exit", exited); error ? reject(error) : resolve(); };
      const abort = () => { child.kill(); finish(new Error("iPhone USB 连接已取消。")); };
      const failed = () => finish(new Error("无法启动 iPhone USB 工具。"));
      const exited = (code: number | null) => finish(code === 0 ? undefined : new Error("iPhone 开发者镜像准备失败。请检查网络和手机开发者模式，再重新连接。"));
      const timer = setTimeout(() => { child.kill(); finish(new Error("iPhone 开发者镜像准备超时，请检查网络后重试。")); }, timeoutMs);
      child.once("error", failed); child.once("exit", exited); job.abort.signal.addEventListener("abort", abort, { once: true });
    }); this.check(job);
  }
  private async run(job: Job, input: Input): Promise<void> {
    const device = (await this.tools.devices()).find(item => item.udid === input.udid); this.check(job);
    if (!device || device.error) throw new Error(device?.error || "没有找到所选 iPhone，请用数据线连接、解锁并信任电脑。");
    if (Number(device.version?.split(".")[0]) < 18 || !device.version) throw new Error("自动 USB 连接目前面向 iOS 18 及以上；其他版本可在启动 WDA 后使用手动控制地址。");
    job.state.name = input.name || device.name.slice(0, 80);
    job.forward = await this.forward(input.udid); this.check(job); job.state.endpoint = job.forward.endpoint;
    const existing = await this.request(job.forward.endpoint, "/status", "GET", undefined, AbortSignal.any([job.abort.signal, AbortSignal.timeout(2000)])).catch(() => undefined); this.check(job);
    if (existing) {
      if (existing.value?.ready !== true) throw new Error("iPhone 上的控制组件尚未就绪。");
      if (wdaSessionId(existing)) throw new Error("该 iPhone 的控制组件正被其他会话使用，请先在原控制器中结束。");
    } else {
      const apps = z.array(z.object({ CFBundleIdentifier: z.string(), CFBundleExecutable: z.string().optional(), CFBundleName: z.string().optional() }).passthrough()).max(5000).parse(parseGoIosJson(await this.tools.run(["apps", "--all", `--udid=${input.udid}`]))); this.check(job);
      const candidates = apps.filter(app => /WebDriverAgentRunner/i.test(`${app.CFBundleName} ${app.CFBundleExecutable} ${app.CFBundleIdentifier}`));
      const app = input.bundleId ? candidates.find(app => app.CFBundleIdentifier === input.bundleId) : candidates.length === 1 ? candidates[0] : undefined;
      if (!app) throw new Error(candidates.length > 1 ? "手机有多个 WebDriverAgent，请填写要使用的 bundle ID。" : "未找到签名后的 WebDriverAgent。请先在「准备控制组件」中准备、签名并安装，然后重试。");
      job.state.bundleId = iphoneBundleId.parse(app.CFBundleIdentifier);
      const tunnelPort = await freePort(); this.check(job);
      const common = [`--udid=${input.udid}`, `--tunnel-info-host=127.0.0.1`, `--tunnel-info-port=${tunnelPort}`];
      const pairing = path.join(this.tools.directory, "pairing", input.udid); await fs.mkdir(pairing, { recursive: true });
      this.phase(job, "tunnel", "正在建立 iPhone 开发者隧道，请留意手机上的信任提示…");
      this.child(job, ["tunnel", "start", "--userspace", `--pair-record-path=${pairing}`, ...common]);
      const deadline = Date.now() + 45000; let ready = false;
      while (!ready && Date.now() < deadline) {
        this.check(job);
        try { const tunnels = parseGoIosJson(await this.tools.run(["tunnel", "ls", ...common], 3000)); ready = Array.isArray(tunnels) && tunnels.some(item => (item.udid || item.Udid) === input.udid); } catch { /* Agent may still be pairing. */ }
        if (!ready) await delay(750, undefined, { signal: job.abort.signal });
      }
      if (!ready) throw new Error("iPhone 隧道未就绪，请解锁手机、确认信任并开启开发者模式。");
      this.phase(job, "image", "正在准备 iOS 开发者镜像，首次连接需要下载…");
      await this.operation(job, ["image", "auto", `--basedir=${path.join(this.tools.directory, "images")}`, ...common], 180000);
      this.phase(job, "runner", "正在启动 WebDriverAgent，请保持手机解锁…");
      this.child(job, ["runwda", `--bundleid=${job.state.bundleId}`, `--testrunnerbundleid=${job.state.bundleId}`, "--xctestconfig=WebDriverAgentRunner.xctest", ...common]);
      let running = false; const runnerDeadline = Date.now() + 60000;
      while (!running && Date.now() < runnerDeadline) {
        this.check(job);
        const status = await this.request(job.forward.endpoint, "/status", "GET", undefined, AbortSignal.any([job.abort.signal, AbortSignal.timeout(2000)])).catch(() => undefined);
        running = status?.value?.ready === true;
        if (status && running && wdaSessionId(status)) throw new Error("WDA 已有其他控制会话，请在原控制器中结束后重试。");
        if (!running) await delay(750, undefined, { signal: job.abort.signal });
      }
      if (!running) throw new Error("WebDriverAgent 未启动。请确认开发者模式、证书有效期，以及控制组件内部 .xctest 已签名。");
    }
    this.check(job); job.state.deviceId = await this.hooks.ready(structuredClone(job.state)); this.check(job);
    this.phase(job, "ready", "USB 连接已就绪；请单独开始查看或控制会话。");
  }
  private async dispose(job: Job): Promise<void> {
    if (job.stopping) return job.stopping;
    job.abort.abort();
    job.stopping = (async () => {
      const waits = [...job.children].map(child => new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode) return resolve();
        const timer = setTimeout(resolve, 3000); child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill();
      }));
      await job.forward?.close(); await Promise.all(waits); job.children.clear(); job.state.endpoint = undefined;
    })();
    await job.stopping; job.stopping = undefined;
  }
  async stop(udid: string): Promise<void> {
    iphoneUdid.parse(udid); const job = this.jobs.get(udid); if (!job) return;
    job.state.phase = "stopped"; job.state.message = "USB 连接已停止。";
    await this.dispose(job); await job.work; this.hooks.ended(job.state); this.hooks.changed();
  }
  async close(): Promise<void> { this.closed = true; await Promise.all([...this.jobs.keys()].map(udid => this.stop(udid))); }
}
