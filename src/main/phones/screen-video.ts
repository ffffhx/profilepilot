import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { deviceShell, type AdbRunner } from "./adb";
import type { AdbProcess } from "./adb-process";
import type { PhoneVideoPacket } from "../../shared/phones";

const LIMIT = 2 * 1024 * 1024;
const prefix = Buffer.from([0, 0, 0, 1]);

/** Annex B access units, independent of ADB's arbitrary transport chunk sizes.
 * Never guess a NAL boundary from a network delay. Keep at most one partial AU.
 */
export class AnnexBVideo {
  private tail = Buffer.alloc(0);
  private units: Buffer[] = [];
  private bytes = 0;
  private picture = false;
  private key = false;
  private sps?: Buffer;
  private pps?: Buffer;
  constructor(private emit: (packet: PhoneVideoPacket) => void) {}
  push(data: Buffer): void {
    this.tail = Buffer.concat([this.tail, data]);
    if (this.tail.length + this.bytes > LIMIT) throw new Error("视频缓冲区已满，请重新连接预览。");
    const starts: { at: number; length: number }[] = [];
    for (let i = 0; i + 2 < this.tail.length; i++) {
      if (this.tail[i] || this.tail[i + 1]) continue;
      const length = this.tail[i + 2] === 1 ? 3 : this.tail[i + 2] === 0 && this.tail[i + 3] === 1 ? 4 : 0;
      if (length) { starts.push({ at: i, length }); i += length - 1; }
    }
    if (!starts.length) return;
    if (starts[0].at) throw new Error("手机返回的视频格式无效。");
    for (let i = 0; i + 1 < starts.length; i++) this.nal(this.tail.subarray(starts[i].at + starts[i].length, starts[i + 1].at));
    const last = starts.at(-1)!;
    this.tail = Buffer.from(this.tail.subarray(last.at));
    // A new picture's header suffices to deliver the preceding complete AU;
    // waiting for the entire next picture would add another frame of latency.
    const type = this.tail[last.length] & 31;
    if (this.picture && (type === 9 || type === 7 || type === 8 || type === 6
      || (type === 1 || type === 5) && !!(this.tail[last.length + 1] & 128))) this.flush();
  }
  private nal(data: Buffer): void {
    if (!data.length) return;
    const type = data[0] & 31;
    if (this.picture && (type === 9 || type === 7 || type === 8 || type === 6
      || (type === 1 || type === 5) && !!(data[1] & 128))) this.flush();
    const nal = Buffer.concat([prefix, data]);
    if (type === 7) { if (data.length < 4) throw new Error("视频参数无效。"); this.sps = nal; return; }
    if (type === 8) { this.pps = nal; return; }
    if (![1, 5, 6].includes(type)) return;
    this.units.push(nal); this.bytes += nal.length;
    if (type === 1 || type === 5) { this.picture = true; this.key ||= type === 5; }
  }
  private flush(): void {
    if (this.picture && this.sps && this.pps) {
      const data = Buffer.concat(this.key ? [this.sps, this.pps, ...this.units] : this.units);
      this.emit({ codec: `avc1.${this.sps.subarray(5, 8).toString("hex")}`, key: this.key,
        timestamp: Math.round(performance.now() * 1000), data: new Uint8Array(data) });
    }
    this.units = []; this.bytes = 0; this.picture = false; this.key = false;
  }
}

/** One bounded, read-only encoder per desktop preview. No video is stored. */
export class PhoneVideoStream {
  readonly id = randomUUID();
  private child?: AdbProcess;
  private queue: PhoneVideoPacket[] = [];
  private bytes = 0;
  private wake?: () => void;
  private reading = false;
  private stopped = false;
  private error = "";
  private touched = Date.now();
  private monitor?: NodeJS.Timeout;
  private pulse?: NodeJS.Timeout;
  private received = false;
  private began = Date.now();
  constructor(private adb: AdbRunner, private device: string, private guard: () => void, private signal: AbortSignal,
    private componentPath = path.resolve(__dirname, "../../../public/phone-video/preview.dex")) {}
  async start(): Promise<void> {
    this.guard(); this.signal.throwIfAborted();
    if (!this.adb.spawn) throw new Error("当前连接不支持视频预览。");
    const bytes = await fs.readFile(this.componentPath);
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 20);
    const remote = `/data/local/tmp/profilepilot-video-${hash}.dex`;
    // adb cannot read inside app.asar. Stage only the small bundled component.
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "profilepilot-video-"));
    try {
      const staged = path.join(temporary, "preview.dex"); await fs.writeFile(staged, bytes);
      this.guard(); this.signal.throwIfAborted();
      await this.adb.run(["-s", this.device, "push", staged, remote], 10000, undefined, this.signal);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    this.guard(); this.signal.throwIfAborted(); this.began = Date.now();
    this.signal.addEventListener("abort", this.abort, { once: true });
    let tail = "", diagnostic = "";
    const child = this.adb.spawn(["-s", this.device, "shell", "-T", deviceShell(["env", `CLASSPATH=${remote}`, "app_process", "/", "io.github.profilepilot.video.PhoneVideo"])], {
      stdout: data => {
        if (this.stopped) return;
        try {
          tail += data.toString("utf8");
          if (tail.length > LIMIT * 2) throw new Error("视频缓冲区已满。");
          let end: number;
          while ((end = tail.indexOf("\n")) >= 0) {
            const line = tail.slice(0, end).trimEnd(); tail = tail.slice(end + 1);
            if (!line.startsWith("PPV1 ")) continue;
            const item = JSON.parse(line.slice(5));
            if (item.type === "error") throw new Error("当前手机暂不支持实时视频，已切换为连续预览。");
            if (item.type !== "frame") continue;
            this.guard(); this.signal.throwIfAborted();
            if (!/^avc1\.[0-9a-f]{6}$/i.test(item.codec) || typeof item.key !== "boolean" || !Number.isSafeInteger(item.timestamp)
              || ![item.width, item.height, item.screenWidth, item.screenHeight].every(n => Number.isInteger(n) && n > 0 && n <= 16384)
              || typeof item.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data)) throw new Error("视频画面格式无效。");
            const data = Buffer.from(item.data, "base64"); this.bytes += data.length;
            if (this.queue.length >= 90 || this.bytes > LIMIT) throw new Error("视频处理跟不上手机画面，已切换为连续预览。");
            this.received = true;
            this.queue.push({ codec: item.codec, key: item.key, timestamp: item.timestamp, data: new Uint8Array(data),
              width: item.width, height: item.height, screenWidth: item.screenWidth, screenHeight: item.screenHeight });
            this.wake?.();
          }
        } catch (error) { this.stop((error as Error).message); }
      }, stderr: data => { diagnostic = (diagnostic + data.toString("utf8")).slice(-800); }
    });
    this.child = child;
    void child.done.then(() => { if (!this.stopped) this.stop(`手机视频已断开${diagnostic ? "：" + diagnostic : ""}`); }, () => this.stop("无法启动手机视频预览。"));
    this.pulse = setInterval(() => { void child.write(Buffer.from(".\n")).catch(() => this.stop("视频连接已断开。")); }, 1000); this.pulse.unref();
    this.monitor = setInterval(() => {
      try {
        this.guard(); this.signal.throwIfAborted();
        if (Date.now() - this.touched > 3000) this.stop("预览窗口已停止读取画面。");
        else if (!this.received && Date.now() - this.began > 10000) this.stop("手机未返回视频，已切换为定时截图。");
      } catch (error) { this.stop((error as Error).message); }
    }, 250); this.monitor.unref();
  }
  private abort = () => this.stop("画面预览已停止。");
  async read(): Promise<{ packets: PhoneVideoPacket[]; error: string }> {
    if (this.reading) throw new Error("正在读取视频画面。");
    this.reading = true; this.touched = Date.now();
    try {
      if (!this.stopped) { this.guard(); this.signal.throwIfAborted(); }
      if (!this.queue.length && !this.stopped) await new Promise<void>(resolve => {
        const timeout = setTimeout(() => { this.wake = undefined; resolve(); }, 500);
        this.wake = () => { clearTimeout(timeout); this.wake = undefined; resolve(); };
      });
      if (!this.stopped) { this.guard(); this.signal.throwIfAborted(); }
      const packets = this.queue; this.queue = []; this.bytes = 0;
      return { packets, error: this.error };
    } finally { this.reading = false; this.touched = Date.now(); }
  }
  stop(error = ""): void {
    if (this.stopped) return;
    this.stopped = true; this.error = error; clearInterval(this.monitor); clearInterval(this.pulse);
    this.signal.removeEventListener("abort", this.abort);
    this.queue = []; this.bytes = 0; this.wake?.();
    const child = this.child; this.child = undefined;
    if (child) {
      child.end();
      const timer = setTimeout(() => child.abort(), 1500); timer.unref();
      void child.done.finally(() => clearTimeout(timer)).catch(() => {});
    }
  }
}
