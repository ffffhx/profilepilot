import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync, readFileSync, existsSync, renameSync, openSync, closeSync, fsyncSync, unlinkSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const terminalRunSchema = z.object({
  command: z.string().min(1).max(100000).describe("runtime=shell 为系统命令；runtime=node 必须是 JavaScript 源码（如 console.log(1)），不要包含 node -e、node -p 或 shell 包装，可使用 require。"), summary: z.string().min(1).max(300),
  runtime: z.enum(["shell", "node"]).default("shell"), cwd: z.string().max(2000).default(".").describe("已存在的任务工作目录或子目录，默认任务根目录。"),
  background: z.boolean().default(false).describe("HTTP 预览等长驻服务设为 true，不要自行脱离进程管理。"),
  timeout_ms: z.number().int().min(100).max(300000).default(60000).describe("普通命令总运行时限；background=true 时不应用此时限。"),
  yield_ms: z.number().int().min(0).max(10000).default(1000).describe("本次最多等待的毫秒数；返回 running 后可用 terminal_read 继续查看。")
});
export const terminalReadSchema = z.object({ process_id: z.string(), wait_ms: z.number().int().min(0).max(10000).default(1000) });
export const terminalStopSchema = z.object({ process_id: z.string() });

// Reject a runtime mismatch before permission prompts and execution. Shell
// quoting cannot be safely reinterpreted across Windows and POSIX.
export function validateTerminalSource(input: { runtime: "shell" | "node"; command: string }): void {
  if (input.runtime === "node" && /^\s*(?:node(?:\.exe)?|nodejs)\s+(?:(?:--[\w-]+(?:=[^\s]+)?)\s+)*(?:-(?:e|p)(?![A-Za-z])|--(?:eval|print)(?==|\s|$))/i.test(input.command)) {
    throw new Error('runtime=node 的 command 必须直接填写 JavaScript 源码，例如 console.log(1)，不能包含 node -e 或 node -p。请移除命令包装后重试；尚未执行命令。');
  }
}
type Status = "running" | "succeeded" | "failed" | "stopped" | "timed_out" | "interrupted";
export interface TerminalResult {
  process_id: string; summary: string; cwd: string; background: boolean; status: Status;
  exit_code: number | null; stdout: string; stderr: string; truncated: boolean;
  /** Current storage failure, separate from the command's actual stderr. */
  persistenceError?: string;
}
interface Job extends TerminalResult {
  taskId: string; child: ChildProcess; done: Promise<void>; settle: () => void;
  timer?: NodeJS.Timeout; stopping?: Promise<void>;
}
const OUTPUT_LIMIT = 24000;
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// Do not pass model credentials, SDK configuration or Electron flags to commands.
export function terminalEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_.*|HTTPS?_PROXY|NO_PROXY)$/i;
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.test(key)));
}
export function terminalInvocation(platform: NodeJS.Platform, runtime: "shell" | "node", script: string, command: string): { executable: string; args: string[]; source: string } {
  if (runtime === "node") return { executable: process.execPath, args: [script], source: command };
  if (platform === "win32") return {
    executable: path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
    source: '\uFEFF$ErrorActionPreference = "Stop"\n$ProgressPreference = "SilentlyContinue"\n[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n' + command + '\nif ($LASTEXITCODE) { exit $LASTEXITCODE }\n'
  };
  return { executable: "/bin/bash", args: ["--noprofile", "--norc", script], source: "set -eo pipefail\n" + command + "\n" };
}

/** Task-owned processes. The working directory is scoped, but this is not an OS sandbox. */
export class TaskTerminal {
  private readonly jobs = new Map<string, Job>();
  private readonly history = new Map<string, TerminalResult & { taskId: string }>();
  private persistTimer?: NodeJS.Timeout;
  private persistError?: Error;
  private reportedPersistError?: string;
  private notificationError?: Error;
  private closing?: Promise<void>;
  private closed = false;
  get persistenceError(): Error | undefined { return this.persistError; }
  constructor(private readonly root: string, private readonly changed: (taskId: string, result: TerminalResult) => void = () => {}) {
    const file = path.join(root, "terminal-history.json");
    if (!existsSync(file)) return;
    const records = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(records)) throw new Error("终端历史格式无效，原文件已保留。");
    for (const record of records) {
      if (!record || typeof record.taskId !== "string" || typeof record.process_id !== "string") continue;
      if (record.status === "running") {
        record.status = "interrupted";
        record.stderr = `${record.stderr || ""}\n应用中断，无法重新附加原进程；请检查原服务后再启动。此记录不表示进程已停止。`;
      }
      this.history.set(record.process_id, record);
    }
    this.persist();
  }
  private persist(): void {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = undefined; }
    let temp: string | undefined, descriptor: number | undefined, ownsTemp = false;
    try {
      const values = [...this.history.values(), ...[...this.jobs.values()].map(job => ({ ...this.result(job, false), taskId: job.taskId }))].slice(-500);
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const file = path.join(this.root, "terminal-history.json");
      temp = `${file}.${randomUUID()}.tmp`;
      descriptor = openSync(temp, "wx", 0o600); ownsTemp = true;
      writeFileSync(descriptor, JSON.stringify(values), { encoding: "utf8" });
      fsyncSync(descriptor);
      closeSync(descriptor); descriptor = undefined;
      renameSync(temp, file); ownsTemp = false;
      this.persistError = undefined; this.reportedPersistError = undefined;
    } catch (error) {
      this.persistError = new Error(`终端历史保存失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
      throw this.persistError;
    } finally {
      if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* preserve the storage error */ }
      if (ownsTemp && temp) try { unlinkSync(temp); } catch { /* never remove the previous history */ }
    }
  }
  private persistInBackground(): void {
    try { this.persist(); }
    catch (error) {
      // Event/timer callbacks must never throw storage failures out of the event
      // loop. read/list expose the error; close retries and rejects if still bad.
      const message = this.persistError!.message;
      if (message !== this.reportedPersistError) console.error(message, error);
      this.reportedPersistError = message;
    }
  }
  private persistSoon(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => { this.persistTimer = undefined; this.persistInBackground(); }, 100);
    this.persistTimer.unref();
  }
  forgetTask(taskId: string): void {
    if (this.hasRunning(taskId)) throw new Error("任务仍有终端进程运行。");
    const history = [...this.history], jobs = [...this.jobs];
    for (const [id, record] of this.history) if (record.taskId === taskId) this.history.delete(id);
    for (const [id, job] of this.jobs) if (job.taskId === taskId) this.jobs.delete(id);
    try { this.persist(); }
    catch (error) {
      this.history.clear(); this.jobs.clear();
      for (const [id, record] of history) this.history.set(id, record);
      for (const [id, job] of jobs) this.jobs.set(id, job);
      throw error;
    }
  }
  workspace(taskId: string): string {
    if (!/^[\w-]+$/.test(taskId)) throw new Error("无效的任务目录。");
    const dir = path.join(this.root, "workspaces", taskId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return realpathSync(dir);
  }
  context(taskId: string): object {
    return { platform: process.platform, shell: process.platform === "win32" ? "PowerShell" : "Bash", workspace: this.workspace(taskId),
      nodeRuntimeAvailable: true, nodeCommandFormat: "JavaScript 源码，例如 console.log(1)；不加 node -e/--eval 包装。", processes: this.list(taskId), backgroundLifetime: "Agent 完成后继续运行；暂停、接管、归档任务或退出应用时停止。应用重启后请重新检查并启动。" };
  }
  list(taskId: string): TerminalResult[] { return [...this.history.values(), ...this.jobs.values()].filter(job => job.taskId === taskId).map(job => this.result(job)); }
  hasRunning(taskId: string): boolean { return [...this.jobs.values()].some(job => job.taskId === taskId && (job.status === "running" || !!job.stopping)); }
  evidence(taskId: string): string[] { return this.list(taskId).filter(job => job.status === "succeeded" || (job.background && job.status === "running")).map(job => job.stdout); }
  async run(taskId: string, args: unknown): Promise<TerminalResult> {
    if (this.closed) throw new Error("应用正在退出，无法执行终端命令。");
    const input = terminalRunSchema.parse(args);
    validateTerminalSource(input);
    const running = [...this.jobs.values()].filter(job => job.status === "running" || job.stopping);
    if (running.length >= 16 || running.filter(job => job.taskId === taskId).length >= 4) throw new Error("运行中的终端进程已达上限，请先停止不再需要的进程。");
    const workspace = this.workspace(taskId);
    const cwd = realpathSync(path.resolve(workspace, input.cwd));
    const relative = path.relative(workspace, cwd);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("终端工作目录必须位于当前任务目录内。");
    // Bound completed output retained in memory; active jobs are never evicted.
    const finished = [...this.jobs.values()].filter(job => job.status !== "running" && !job.stopping);
    for (const job of finished.slice(0, Math.max(0, finished.length - 99))) this.jobs.delete(job.process_id);
    const id = randomUUID();
    const scripts = path.join(this.root, "terminals", taskId);
    mkdirSync(scripts, { recursive: true, mode: 0o700 });
    const script = path.join(scripts, id + (input.runtime === "node" ? ".cjs" : process.platform === "win32" ? ".ps1" : ".sh"));
    const invocation = terminalInvocation(process.platform, input.runtime, script, input.command);
    writeFileSync(script, invocation.source, { encoding: "utf8", mode: 0o600 });
    const env = terminalEnvironment();
    if (input.runtime === "node") env.ELECTRON_RUN_AS_NODE = "1";
    const child = spawn(invocation.executable, invocation.args, { cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let settle!: () => void;
    const done = new Promise<void>(resolve => { settle = resolve; });
    const job: Job = { process_id: id, taskId, child, cwd, background: input.background, summary: input.summary,
      status: "running", exit_code: null, stdout: "", stderr: "", truncated: false, done, settle };
    this.jobs.set(id, job);
    const append = (field: "stdout" | "stderr", value: string): void => {
      const combined = job[field] + value;
      job.truncated ||= combined.length > OUTPUT_LIMIT;
      job[field] = combined.slice(-OUTPUT_LIMIT);
      this.persistSoon();
    };
    child.stdout!.setEncoding("utf8").on("data", data => append("stdout", data));
    child.stderr!.setEncoding("utf8").on("data", data => append("stderr", data));
    child.on("error", error => append("stderr", error.message));
    child.once("close", code => {
      job.exit_code = code;
      if (job.status === "running") job.status = code === 0 ? "succeeded" : "failed";
      if (job.timer) clearTimeout(job.timer);
      job.settle(); this.persistInBackground();
      try { this.changed(taskId, this.result(job)); }
      catch (error) {
        // The service's notification callback can itself fail while saving tasks.
        this.notificationError = new Error(`终端结束通知失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
        console.error(this.notificationError.message, error);
      }
    });
    if (!input.background) {
      job.timer = setTimeout(() => { void this.stopJob(job, "timed_out").catch(error => append("stderr", String(error))); }, input.timeout_ms);
      job.timer.unref();
    }
    // Install error/close/output listeners and the timeout before any fallible
    // history I/O. A launched process remains owned even if its first save fails.
    try { this.persist(); }
    catch (error) {
      append("stderr", "\n终端启动记录未能保存，已请求停止进程。命令可能已经执行，请先核查副作用再重试。\n");
      try { await this.stopJob(job); }
      catch (stopError) {
        throw new AggregateError([error, stopError], `终端启动记录保存失败，且无法确认进程已停止：${String(stopError)}`);
      }
      throw new Error("终端启动记录保存失败，进程已收尾；命令可能已经执行，请先核查副作用再重试。", { cause: error });
    }
    await this.wait(job, input.yield_ms);
    return this.result(job);
  }
  async read(taskId: string, args: unknown): Promise<TerminalResult> {
    const input = terminalReadSchema.parse(args);
    const historical = this.history.get(input.process_id);
    if (historical?.taskId === taskId) return this.result(historical);
    const job = this.owned(taskId, input.process_id);
    await this.wait(job, input.wait_ms); return this.result(job);
  }
  async stop(taskId: string, args: unknown): Promise<TerminalResult> {
    const input = terminalStopSchema.parse(args); const job = this.owned(taskId, input.process_id);
    await this.stopJob(job); return this.result(job);
  }
  async stopTask(taskId: string, includeBackground = true): Promise<void> {
    await Promise.all([...this.jobs.values()].filter(job => job.taskId === taskId && (includeBackground || !job.background)).map(job => this.stopJob(job)));
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const stopped = await Promise.allSettled([...this.jobs.values()].map(job => this.stopJob(job)));
      const errors: unknown[] = stopped.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
      // Persist all final states even when stopping an individual process failed.
      try { this.persist(); } catch (error) { errors.push(error); }
      if (this.notificationError) errors.push(this.notificationError);
      if (errors.length) throw new AggregateError(errors, `终端关闭未完全成功：${errors.map(error => error instanceof Error ? error.message : String(error)).join("；")}`);
    })().finally(() => { this.closing = undefined; });
    return this.closing;
  }
  private owned(taskId: string, id: string): Job {
    const job = this.jobs.get(id);
    if (!job || job.taskId !== taskId) throw new Error("终端进程不存在或不属于当前任务；应用重启后需重新启动服务。");
    return job;
  }
  private result(job: TerminalResult, includePersistenceError = true): TerminalResult {
    const { process_id, summary, cwd, background, status, exit_code, stdout, stderr, truncated } = job;
    return { process_id, summary, cwd, background, status, exit_code, stdout, stderr, truncated,
      ...(includePersistenceError && this.persistError ? { persistenceError: this.persistError.message } : {}) };
  }
  private async wait(job: Job, ms: number): Promise<void> {
    if (job.status !== "running" || ms === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([job.done, new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]);
    if (timer) clearTimeout(timer);
  }
  private stopJob(job: Job, reason: "stopped" | "timed_out" = "stopped"): Promise<void> {
    if (job.stopping) return job.stopping;
    if (job.status !== "running") return Promise.resolve();
    job.stopping = (async () => {
      if (job.timer) clearTimeout(job.timer);
      const pid = job.child.pid;
      if (pid && job.child.exitCode === null && job.child.signalCode === null) {
        job.status = reason;
        if (process.platform === "win32") {
          await new Promise<void>((resolve, reject) => execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 8000 }, error => {
            if (error && job.child.exitCode === null && job.child.signalCode === null) reject(new Error("无法停止任务终端进程：" + error.message)); else resolve();
          }));
        } else {
          try { process.kill(-pid, "SIGTERM"); } catch (error: any) { if (error.code !== "ESRCH") throw error; }
          await Promise.race([job.done, delay(300)]);
          // A child may outlive the shell and still belong to its process group.
          try { process.kill(-pid, "SIGKILL"); } catch (error: any) { if (error.code !== "ESRCH") throw error; }
        }
      }
      await Promise.race([job.done, delay(1500)]);
      if (job.child.exitCode === null && job.child.signalCode === null) throw new Error("终端进程尚未确认退出，请检查进程后重试停止。");
    })().catch(error => { job.status = "running"; throw error; }).finally(() => { job.stopping = undefined; });
    return job.stopping;
  }
}
