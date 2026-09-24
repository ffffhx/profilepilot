import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const terminalRunSchema = z.object({
  command: z.string().min(1).max(100000).describe("shell 为系统命令；node 为直接执行的 JavaScript 源码，可使用 require。"), summary: z.string().min(1).max(300),
  runtime: z.enum(["shell", "node"]).default("shell"), cwd: z.string().max(2000).default(".").describe("已存在的任务工作目录或子目录，默认任务根目录。"),
  background: z.boolean().default(false).describe("HTTP 预览等长驻服务设为 true，不要自行脱离进程管理。"),
  timeout_ms: z.number().int().min(100).max(300000).default(60000).describe("普通命令总运行时限；background=true 时不应用此时限。"),
  yield_ms: z.number().int().min(0).max(10000).default(1000).describe("本次最多等待的毫秒数；返回 running 后可用 terminal_read 继续查看。")
});
export const terminalReadSchema = z.object({ process_id: z.string(), wait_ms: z.number().int().min(0).max(10000).default(1000) });
export const terminalStopSchema = z.object({ process_id: z.string() });
type Status = "running" | "succeeded" | "failed" | "stopped" | "timed_out";
export interface TerminalResult {
  process_id: string; summary: string; cwd: string; background: boolean; status: Status;
  exit_code: number | null; stdout: string; stderr: string; truncated: boolean;
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
  private closed = false;
  constructor(private readonly root: string, private readonly changed: (taskId: string, result: TerminalResult) => void = () => {}) {}
  workspace(taskId: string): string {
    if (!/^[\w-]+$/.test(taskId)) throw new Error("无效的任务目录。");
    const dir = path.join(this.root, "workspaces", taskId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return realpathSync(dir);
  }
  context(taskId: string): object {
    return { platform: process.platform, shell: process.platform === "win32" ? "PowerShell" : "Bash", workspace: this.workspace(taskId),
      nodeRuntimeAvailable: true, processes: this.list(taskId), backgroundLifetime: "Agent 完成后继续运行；暂停、接管、归档任务或退出应用时停止。应用重启后请重新检查并启动。" };
  }
  list(taskId: string): TerminalResult[] { return [...this.jobs.values()].filter(job => job.taskId === taskId).map(job => this.result(job)); }
  hasRunning(taskId: string): boolean { return [...this.jobs.values()].some(job => job.taskId === taskId && (job.status === "running" || !!job.stopping)); }
  evidence(taskId: string): string[] { return this.list(taskId).filter(job => job.status === "succeeded" || (job.background && job.status === "running")).map(job => job.stdout); }
  async run(taskId: string, args: unknown): Promise<TerminalResult> {
    if (this.closed) throw new Error("应用正在退出，无法执行终端命令。");
    const input = terminalRunSchema.parse(args);
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
    };
    child.stdout!.setEncoding("utf8").on("data", data => append("stdout", data));
    child.stderr!.setEncoding("utf8").on("data", data => append("stderr", data));
    child.on("error", error => append("stderr", error.message));
    child.once("close", code => {
      job.exit_code = code;
      if (job.status === "running") job.status = code === 0 ? "succeeded" : "failed";
      if (job.timer) clearTimeout(job.timer);
      job.settle(); this.changed(taskId, this.result(job));
    });
    if (!input.background) {
      job.timer = setTimeout(() => { void this.stopJob(job, "timed_out").catch(error => append("stderr", String(error))); }, input.timeout_ms);
      job.timer.unref();
    }
    await this.wait(job, input.yield_ms);
    return this.result(job);
  }
  async read(taskId: string, args: unknown): Promise<TerminalResult> {
    const input = terminalReadSchema.parse(args); const job = this.owned(taskId, input.process_id);
    await this.wait(job, input.wait_ms); return this.result(job);
  }
  async stop(taskId: string, args: unknown): Promise<TerminalResult> {
    const input = terminalStopSchema.parse(args); const job = this.owned(taskId, input.process_id);
    await this.stopJob(job); return this.result(job);
  }
  async stopTask(taskId: string, includeBackground = true): Promise<void> {
    await Promise.all([...this.jobs.values()].filter(job => job.taskId === taskId && (includeBackground || !job.background)).map(job => this.stopJob(job)));
  }
  async close(): Promise<void> { this.closed = true; await Promise.all([...this.jobs.values()].map(job => this.stopJob(job))); }
  private owned(taskId: string, id: string): Job {
    const job = this.jobs.get(id);
    if (!job || job.taskId !== taskId) throw new Error("终端进程不存在或不属于当前任务；应用重启后需重新启动服务。");
    return job;
  }
  private result(job: Job): TerminalResult {
    const { process_id, summary, cwd, background, status, exit_code, stdout, stderr, truncated } = job;
    return { process_id, summary, cwd, background, status, exit_code, stdout, stderr, truncated };
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
    })().catch(error => { job.status = "running"; throw error; }).finally(() => { job.stopping = undefined; });
    return job.stopping;
  }
}
