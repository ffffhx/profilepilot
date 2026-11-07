import os from "node:os";
import { randomUUID } from "node:crypto";
import { profilePilotManagementRoot } from "./profilepilot-management-protocol";
import { CONTROL_TRACE_ROUTES, writeControlTrace, type ControlTraceEvent, type ControlTraceRoute } from "./control-trace";
import { controlTraceContext, noteControlTraceCommand, noteControlTraceResponse } from "./control-trace-context";
import { readControlTraceSamples, summarizeControlTraces } from "./control-trace-report";
import { controlRecovery } from "../shared/control-recovery";
import { parseBrowserCliRoute } from "./browser-cli";

type IO = Pick<NodeJS.Process, "stdout" | "stderr">;
interface Runtime { homeDir?: string; env?: NodeJS.ProcessEnv; request?: (...args: any[]) => Promise<any> }
const traceFlags = new Set(["--task-kind", "--task-id", "--operation-id", "--recovery-of"]);
const methods = new Set(("status list windows doctor inspect readiness claim start stop select observe wait snapshot screenshot read get action click dblclick double_click fill type press scroll eval cdp open newTab tabs switch close complete release handoff resume receipt connect disconnect configure install app exec host wireless-discover wireless-pair wireless-connect wireless-disconnect emulator-list emulator-connect iphone accessibility-repair wrap adb call profiles profile create rename delete service schema help network console errors debug pointer upload download logs history record").split(" "));

export function parseTraceOptions(input: string[]) {
  const args: string[] = [], values = new Map<string, string>();
  for (let i = 0; i < input.length; i++) {
    const equals = input[i].indexOf("="), flag = equals < 0 ? input[i] : input[i].slice(0, equals);
    // Global metadata only precedes the route. After the route, every byte
    // belongs to that command (including text/JS resembling our flag names).
    if (!traceFlags.has(flag)) { args.push(...input.slice(i)); break; }
    if (values.has(flag)) throw new Error(`重复参数 ${flag}。`);
    const value = equals < 0 ? input[++i] : input[i].slice(equals + 1);
    if (!value || value.startsWith("--") || value.length > 200 || /[\x00-\x1f]/.test(value)) throw new Error(`${flag} 需要 1–200 字符的标识。`);
    values.set(flag, value);
  }
  const taskKind = values.get("--task-kind") || "unspecified";
  if (!["real", "verification", "unspecified"].includes(taskKind)) throw new Error("--task-kind 只接受 real 或 verification；省略表示未分类。");
  return { args, metadata: { taskKind: taskKind as ControlTraceEvent["taskKind"], taskId: values.get("--task-id"),
    operationId: values.get("--operation-id"), recoveryOf: values.get("--recovery-of") } };
}

function argument(args: string[], name: string): string | undefined {
  const equals = args.find(value => value.startsWith(name + "="));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined;
}

export function describeTraceCommand(args: string[]): { route: ControlTraceRoute; method: string; sessionId?: string; target?: string } | undefined {
  const group = args[0];
  if (!["browser", "electron", "phone", "desktop", "gpui", "remote"].includes(group)) return;
  let route: ControlTraceRoute = group === "browser" ? "extension" : group as ControlTraceRoute;
  let verb = args[1], metadataArgs = args.slice(2), help = args.length === 1;
  if (group === "browser" || group === "electron") {
    try {
      const parsed = parseBrowserCliRoute(args.slice(1));
      if (group === "browser") route = parsed.connection === "gateway" ? "gateway" : "extension";
      verb = parsed.args[parsed.commandIndex];
      metadataArgs = parsed.args.slice(0, parsed.commandIndex);
      const tail = parsed.args.slice(parsed.commandIndex + 1);
      help ||= parsed.help || tail.length === 1 && ["--help", "-h"].includes(tail[0]);
      if (group === "electron" && parsed.commandIndex === 0) metadataArgs = args.slice(2);
    } catch { verb = "unknown"; metadataArgs = []; }
  } else help ||= args.includes("--help") || args.includes("-h");
  const method = help ? "help" : methods.has(verb) ? verb : "unknown";
  return { route, method, sessionId: argument(metadataArgs, "--session"), target: argument(metadataArgs, "--device") || argument(metadataArgs, "--window") || argument(metadataArgs, "--target") || argument(metadataArgs, "--profile") || argument(metadataArgs, "--app") };
}

export const traceHelp = `ppilot trace report [--since ISO_DATE|14d] [--route extension|gateway|phone|desktop|electron|gpui|remote] [--task-kind real|verification|unspecified] [--json]
只读汇总本机保留的 CLI 元数据，不记录正文、URL、截图、参数或凭据。
控制命令的路由前可加全局前缀：ppilot --task-kind real|verification --task-id TASK --operation-id STEP phone list。
恢复步骤可用 --recovery-of STEP 关联之前的失败；不会授权自动重试或交还控制。
ID 仅以哈希保存。省略 task-kind 为 unspecified；不推断真实任务/验收。
首次成功率只统计显式 operation-id；统计窗口、轮转及并发写入可能使记录不完整。
每条路线最多保留两个 2 MiB 文件。trace 失败不改变命令结果。
`;

async function runTraceReport(args: string[], io: IO, runtime: Runtime): Promise<number> {
  if (args.includes("--help") || args.includes("-h") || args.length === 1) { io.stdout.write(traceHelp); return 0; }
  try {
    if (args[1] !== "report") throw new Error("使用 ppilot trace report 查看统计。");
    const values = new Map<string, string>(); let json = false;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--json" && !json) { json = true; continue; }
      const match = /^--(since|route|task-kind)(?:=(.*))?$/.exec(args[i]);
      if (!match || values.has(match[1])) throw new Error("未知或重复参数：" + args[i]);
      const value = match[2] ?? args[++i]; if (!value || value.startsWith("--")) throw new Error("参数缺少值。");
      values.set(match[1], value);
    }
    const until = Date.now(), sinceArg = values.get("since") || "14d";
    const days = /^(\d+)d$/.exec(sinceArg), since = days ? until - Number(days[1]) * 86400000 : Date.parse(sinceArg);
    if (!Number.isFinite(since) || since < 0 || since > until || days && Number(days[1]) < 1) throw new Error("--since 需要过去的 ISO 日期或正整数天数，例如 14d。");
    const route = values.get("route"), taskKind = values.get("task-kind");
    if (route && !CONTROL_TRACE_ROUTES.includes(route as ControlTraceRoute)) throw new Error("未知 trace route。");
    if (taskKind && !["real", "verification", "unspecified"].includes(taskKind)) throw new Error("未知 task-kind。");
    const root = profilePilotManagementRoot(runtime.homeDir || os.homedir(), runtime.env || process.env);
    const { rows, ...coverage } = readControlTraceSamples(root, since, until);
    const filtered = rows.filter(row => (!route || row.route === route) && (!taskKind || row.taskKind === taskKind));
    const report = { ok: true, window: { since: new Date(since).toISOString(), until: new Date(until).toISOString() }, ...coverage, ...summarizeControlTraces(filtered) };
    io.stdout.write(JSON.stringify(report, null, json ? undefined : 2) + "\n"); return 0;
  } catch (error) { io.stderr.write(JSON.stringify({ ok: false, code: "TRACE_INVALID_ARGUMENTS", message: (error as Error).message }) + "\n"); return 2; }
}

/** One CLI sample per invocation, separate from service traces. I/O is passed
 * through unchanged. Bounded response capture is discarded after extracting
 * protocol metadata; it is never persisted. */
export async function runWithControlTrace<T extends Runtime>(args: string[], io: IO, runtime: T,
  execute: (args: string[], io: IO, runtime: T) => Promise<number>): Promise<number> {
  if (args[0] === "trace") return runTraceReport(args, io, runtime);
  let parsed: ReturnType<typeof parseTraceOptions>;
  try { parsed = parseTraceOptions(args); }
  catch (error) { io.stderr.write(JSON.stringify({ ok: false, code: "TRACE_INVALID_ARGUMENTS", message: (error as Error).message }) + "\n"); return 2; }
  if (parsed.args[0] === "trace") return runTraceReport(parsed.args, io, runtime);
  const description = describeTraceCommand(parsed.args);
  if (!description) return execute(parsed.args, io, runtime);
  const started = Date.now(), invocationId = randomUUID(), context: Partial<ControlTraceEvent> = { ...parsed.metadata, ...description, requestId: invocationId, invocationId };
  const buffers = new Map<string, string>();
  const capture = (name: "stdout" | "stderr") => {
    const stream = Object.create(io[name]);
    stream.write = (chunk: any, ...rest: any[]) => {
      const previous = buffers.get(name) ?? "";
      if (previous.length <= 262144) {
        const next = previous + (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
        buffers.set(name, next.length <= 262144 ? next : " ".repeat(262145));
      }
      return (io[name].write as any).call(io[name], chunk, ...rest);
    };
    return stream;
  };
  let exitCode = 1;
  return controlTraceContext.run(context, async () => {
    try {
      const tracedRuntime = runtime.request ? { ...runtime, request: async (...values: any[]) => {
        noteControlTraceCommand(values[0]); const result = await runtime.request!(...values); noteControlTraceResponse(result); return result;
      } } as T : runtime;
      exitCode = await execute(parsed.args, { stdout: capture("stdout"), stderr: capture("stderr") }, tracedRuntime);
      return exitCode;
    } finally {
      for (const content of buffers.values()) {
        if (content.length > 262144) continue;
        try { noteControlTraceResponse(JSON.parse(content)); }
        catch { for (const line of content.trim().split("\n").slice(-8)) { try { noteControlTraceResponse(JSON.parse(line)); } catch { /* non JSON output */ } } }
      }
      buffers.clear();
      if (context.code && !context.recovery && exitCode !== 0) context.recovery = controlRecovery(context.code);
      writeControlTrace(profilePilotManagementRoot(runtime.homeDir || os.homedir(), runtime.env || process.env), description.route,
        { ...context, scope: "cli", requestId: context.requestId!, method: description.method, durationMs: Date.now() - started, exitCode, ok: exitCode === 0 });
    }
  });
}
