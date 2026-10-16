import { randomUUID } from "node:crypto";
import path from "node:path";
import { adbCommand } from "./adb-command";
import type { AdbRunner } from "./adb";
import type { AdbProcess } from "./adb-process";
import { AdbForwarding } from "./adb-forwarding";

export interface AdbJobInput { lease: string; generation: number; requestId: string; args: string[]; timeoutMs?: number; cwd?: string; stdin?: boolean; }
type Authorization = { id: string; release(): void };
type Chunk = { offset: number; channel: "stdout" | "stderr"; data: string };
type Job = {
  input: AdbJobInput; id: string; process?: AdbProcess; done?: Promise<void>;
  status: "running" | "completed" | "interrupted" | "failed"; code: number | null; error?: string;
  chunks: Chunk[]; nextOffset: number; ackOffset: number; buffered: number; inputSequence: number; inputEnded: boolean;
  timer?: NodeJS.Timeout; deadline?: NodeJS.Timeout; checking?: Promise<void>; release(): void;
};

/** Desktop-owned, bounded native ADB processes. The CLI can disappear without
 * leaving its child alive. Output is acknowledged, not destructively read. */
export class ManagedAdbJobs {
  private jobs = new Map<string, Job>();
  private requests = new Map<string, Set<string>>();
  private closed = false;
  private forwarding: AdbForwarding;
  private resources: NodeJS.Timeout;
  private resourceChecks = new Set<string>();
  constructor(private adb: AdbRunner,
    private authorize: (lease: string, generation: number, mode: "view" | "control", acquire: boolean) => Promise<Authorization>, journal?: string) {
    this.forwarding = new AdbForwarding(adb, journal);
    this.resources = setInterval(() => {
      for (const owner of this.forwarding.owners()) {
        if (this.resourceChecks.has(owner.lease)) continue;
        this.resourceChecks.add(owner.lease);
        void this.authorize(owner.lease, owner.generation, "control", false).catch(() => this.forwarding.cleanup(owner.lease))
          .catch(() => { /* Ownership is retained and cleanup retried next tick. */ }).finally(() => this.resourceChecks.delete(owner.lease));
      }
    }, 500); this.resources.unref();
  }
  async start(input: AdbJobInput) {
    if (this.closed || !this.adb.spawn) throw new Error("当前运行环境不支持托管 ADB 进程。");
    const command = adbCommand(input.args);
    if (input.stdin) command.mode = "control";
    if (input.cwd && !path.isAbsolute(input.cwd)) throw new Error("工作目录必须是绝对路径。");
    const timeout = input.timeoutMs ?? 120000;
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 3600000) throw new Error("ADB 超时须在 100–3600000 毫秒之间。");
    const requests = this.requests.get(input.lease) || new Set<string>();
    if (requests.has(input.requestId)) throw new Error("此 ADB 请求已提交，不能重放；请查询原任务状态。");
    if (requests.size >= 4096) throw new Error("此会话请求数已达上限。");
    const owner = await this.authorize(input.lease, input.generation, command.mode, true);
    // Consume before starting, including launch failure; retries require a new
    // explicit operation after the caller has reconciled the result.
    requests.add(input.requestId); this.requests.set(input.lease, requests);
    const id = randomUUID();
    const job: Job = { input, id: owner.id, status: "running", code: null, chunks: [], nextOffset: 0, ackOffset: 0, buffered: 0, inputSequence: 0, inputEnded: false, release: owner.release };
    this.jobs.set(id, job);
    const append = (channel: Chunk["channel"], bytes: Buffer) => {
      if (job.status !== "running") return;
      // Small chunks fit the management protocol even when base64 encoded.
      for (let start = 0; start < bytes.length; start += 24576) {
        const part = bytes.subarray(start, start + 24576);
        if (job.buffered + part.length > 8 * 1024 * 1024) { this.interrupt(job, "输出超过 8 MiB 未读缓冲区，任务已停止；已接收输出仍可读取。"); return; }
        job.chunks.push({ offset: job.nextOffset++, channel, data: part.toString("base64") }); job.buffered += part.length;
      }
    };
    try {
      const options = { cwd: input.cwd, stdout: (bytes: Buffer) => append("stdout", bytes), stderr: (bytes: Buffer) => append("stderr", bytes) };
      job.process = ["forward", "reverse"].includes(command.args[0]) ? this.forwarding.spawn(input.lease, input.generation, owner.id, command.args, options)
        : this.adb.spawn(["-s", owner.id, ...command.args], options);
      if (!input.stdin) { job.process.end(); job.inputEnded = true; }
      job.timer = setInterval(() => {
        if (job.checking || job.status !== "running") return;
        job.checking = this.authorize(input.lease, input.generation, command.mode, false).then(() => {}).catch(error => this.interrupt(job, (error as Error).message)).finally(() => { job.checking = undefined; });
      }, 250);
      job.deadline = setTimeout(() => this.interrupt(job, "ADB 操作超时。已提交的手机操作可能生效，请先核对结果。"), timeout);
      job.done = this.finish(job, command.mode);
    } catch (error) {
      job.status = "failed"; job.error = (error as Error).message; this.cleanup(job);
    }
    return { jobId: id };
  }
  private async finish(job: Job, mode: "view" | "control") {
    try {
      const result = await job.process!.done; job.code = result.code;
      if (job.status === "running") {
        await this.authorize(job.input.lease, job.input.generation, mode, false);
        if (job.status === "running") job.status = "completed";
      }
    } catch (error) {
      if (job.status === "running") { job.status = "failed"; job.error = (error as Error).message; }
    } finally { this.cleanup(job); }
  }
  private cleanup(job: Job) { clearInterval(job.timer); clearTimeout(job.deadline); job.release(); }
  private interrupt(job: Job, reason: string) {
    if (job.status !== "running") return;
    job.status = "interrupted"; job.error = reason + " 不会自动重试；结束本地进程不能撤销已完成或已分离的手机操作。";
    job.process?.abort();
  }
  private owned(lease: string, id: string) {
    const job = this.jobs.get(id);
    if (!job || job.input.lease !== lease) throw new Error("ADB 任务不存在或不属于此会话。");
    return job;
  }
  status(lease: string, id: string, offset = 0) {
    const job = this.owned(lease, id);
    if (!Number.isInteger(offset) || offset < job.ackOffset || offset > job.nextOffset) throw new Error("ADB 输出游标无效。");
    while (job.chunks[0] && job.chunks[0].offset < offset) { const chunk = job.chunks.shift()!; job.buffered -= Buffer.byteLength(chunk.data, "base64"); }
    job.ackOffset = offset;
    const chunks = job.chunks.slice(0, 8); // <= 262 KiB JSON per response
    return { jobId: id, status: job.status, code: job.code, error: job.error, chunks,
      nextOffset: chunks.length ? chunks[chunks.length - 1].offset + 1 : offset, drained: offset + chunks.length === job.nextOffset };
  }
  async input(lease: string, id: string, sequence: number, data: string, eof = false) {
    const job = this.owned(lease, id);
    if (job.status !== "running" || !job.input.stdin || job.inputEnded || sequence !== job.inputSequence) throw new Error("ADB 输入已关闭、会话改变或序号重复；不能重放输入。");
    if (data.length > 87384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error("ADB 输入不是有效的 base64 数据块。");
    // Every stdin write can execute a new command, even for an initial read.
    await this.authorize(lease, job.input.generation, "control", false);
    if (job.status !== "running" || sequence !== job.inputSequence) throw new Error("ADB 会话已改变，输入未提交。");
    job.inputSequence++;
    if (data) await job.process!.write(Buffer.from(data, "base64"));
    if (eof) { job.inputEnded = true; job.process!.end(); }
    return { sequence: job.inputSequence };
  }
  cancel(lease: string, id: string) { const job = this.owned(lease, id); this.interrupt(job, "ADB 任务已取消。"); return { status: job.status }; }
  async release(lease: string) {
    const owned = [...this.jobs].filter(([, job]) => job.input.lease === lease);
    for (const [, job] of owned) this.interrupt(job, "手机会话已结束。");
    await Promise.allSettled(owned.map(([, job]) => job.done));
    await this.forwarding.cleanup(lease);
    for (const [id] of owned) this.jobs.delete(id);
    this.requests.delete(lease);
  }
  async close() {
    this.closed = true; clearInterval(this.resources);
    const leases = new Set([...this.requests.keys(), ...this.forwarding.owners().map(o => o.lease)]);
    const results = await Promise.allSettled([...leases].map(lease => this.release(lease)));
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (errors.length) throw new Error(errors.map(e => String(e.reason)).join("; "));
  }
}
