#!/usr/bin/env node
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import { randomUUID } from "node:crypto";
import packageMetadata from "../../package.json";
import { ensureChatService } from "./cli/service-launcher";
import { runPhoneCli } from "./phones/cli";
import { runAdbCli, runPhoneWrap } from "./phones/adb-wrapper";
import { runBrowserCli } from "./browser-cli";
import { parseAgentCliArgs, runAgentCli, type AgentCliRuntime, type AgentCliTransport, type ParsedAgentCliCommand } from "./profilepilot-agent-cli";
import {
  getDiagnosticLogStats,
  readDiagnosticLogs,
  type DiagnosticLogEntry,
  type DiagnosticLogLevel
} from "./diagnostic-log";
import {
  PROFILEPILOT_MANAGEMENT_MAX_MESSAGE_BYTES,
  PROFILEPILOT_PHONE_MAX_RESPONSE_BYTES,
  PROFILEPILOT_PHONE_BASIC_MAX_RESPONSE_BYTES,
  PROFILEPILOT_MANAGEMENT_PROTOCOL_VERSION,
  profilePilotManagementSecretPath,
  profilePilotManagementSocketPath,
  type ProfilePilotManagementCommand,
  type ProfilePilotManagementRequest,
  type ProfilePilotManagementResponse
} from "./profilepilot-management-protocol";

export const PROFILEPILOT_CLI_VERSION = packageMetadata.version;
const REQUEST_TIMEOUT_MS = 35_000;
const USAGE_EXIT_CODE = 2;
const SERVER_UNAVAILABLE_EXIT_CODE = 69;
const COMMAND_FAILED_EXIT_CODE = 1;

interface ParsedManagementCliCommand {
  command: ProfilePilotManagementCommand;
  json: boolean;
}

interface ParsedLogsCliCommand {
  local: "logs";
  json: boolean;
  levels: DiagnosticLogLevel[];
  since: number | null;
  limit: number;
  follow: boolean;
}

interface ParsedDoctorCliCommand {
  local: "doctor";
  json: boolean;
}

export type ParsedCliCommand = ParsedManagementCliCommand | ParsedLogsCliCommand | ParsedDoctorCliCommand | ParsedAgentCliCommand;

export async function runProfilePilotCli(
  args = process.argv.slice(2),
  io: Pick<NodeJS.Process, "stdout" | "stderr"> = process,
  runtime: AgentCliRuntime & { homeDir?: string; env?: NodeJS.ProcessEnv; request?: AgentCliTransport } = {}
): Promise<number> {
  // The Windows PowerShell entry transports argv without legacy native quoting
  // or cmd.exe reinterpreting URL/JSON characters. Consume it before any child
  // process can inherit the user's arguments; ordinary entries are unchanged.
  if (args.length === 1 && args[0] === "--profilepilot-argv-env") {
    const env = runtime.env || process.env;
    const encoded = env.PROFILEPILOT_LAUNCHER_ARGV;
    delete env.PROFILEPILOT_LAUNCHER_ARGV;
    try {
      if (!encoded) throw new Error("missing argv");
      const decoded: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      if (!Array.isArray(decoded) || decoded.some(value => typeof value !== "string")) throw new Error("invalid argv");
      args = decoded;
    } catch {
      io.stderr.write(`${JSON.stringify({ ok: false, code: "NATIVE_INVALID_REQUEST", error: "PowerShell 启动参数无效，请重新运行 ppilot。" })}\n`);
      return 64;
    }
  }
  // Keep the former top-level adb spelling as a compatibility alias.
  const phoneAdb = args[0] === "phone" && args[1] === "adb";
  if (args[0] === "adb" || phoneAdb || args[0] === "phone" && args[1] === "wrap") {
    const env = runtime.env || process.env;
    const request = runtime.request || (command => requestProfilePilotManagement(command, runtime.homeDir || os.homedir(), env, 10_000));
    return args[0] === "adb" || phoneAdb ? runAdbCli(args.slice(phoneAdb ? 2 : 1), request, io, env) : runPhoneWrap(args.slice(2), request, io, env);
  }
  if (args[0] === "phone") {
    return runPhoneCli(args.slice(1), runtime.request || (command => requestProfilePilotManagement(command, runtime.homeDir || os.homedir(), runtime.env || process.env, 125_000)), io);
  }
  if (args[0] === "browser") {
    return runBrowserCli(args.slice(1), io, runtime.env || process.env);
  }
  // The short command opens chat directly. Keep the explicit agent namespace
  // working for existing scripts alongside ppilot run/list/watch/etc.
  args = normalizeCliArgs(args);
  if (args[0] !== "agent" && (args.includes("--help") || args.includes("-h"))) {
    io.stdout.write(helpText());
    return 0;
  }
  if (args[0] !== "agent" && (args.includes("--version") || args.includes("-V"))) {
    io.stdout.write(`${PROFILEPILOT_CLI_VERSION}\n`);
    return 0;
  }

  let parsed: ParsedCliCommand;
  try {
    parsed = parseProfilePilotCliArgs(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args[0] === "agent" && args.includes("--json")) {
      io.stdout.write(`${JSON.stringify({ type: "error", ok: false, error: { code: "INVALID_ARGUMENTS", message }, exitCode: USAGE_EXIT_CODE })}\n`);
    } else io.stderr.write(`[ProfilePilot] ${message}\n\n${args[0] === "agent" ? "运行 ppilot --help 查看用法。\n" : helpText()}`);
    return USAGE_EXIT_CODE;
  }

  const homeDir = runtime.homeDir || os.homedir();
  const env = runtime.env || process.env;
  if ("local" in parsed && parsed.local === "agent") {
    if (parsed.verb === "chat" && !runtime.request && (runtime.stdin || process.stdin).isTTY) {
      try { await ensureChatService((command, signal) => requestProfilePilotManagement(command, homeDir, env, 1500, signal), homeDir, message => io.stderr.write(message)); }
      catch (error) { io.stderr.write(`[ppilot] ${error instanceof Error ? error.message : error}\n`); return SERVER_UNAVAILABLE_EXIT_CODE; }
    }
    return runAgentCli(parsed, io, runtime.request || ((command, signal) => requestProfilePilotManagement(command, homeDir, env,
      ["task.compact", "task.connection.test"].includes(command.action) ? 120_000 : REQUEST_TIMEOUT_MS, signal)), runtime);
  }
  if ("local" in parsed && parsed.local === "logs") {
    await runLogsCommand(parsed, io, homeDir, env);
    return 0;
  }
  if ("local" in parsed && parsed.local === "doctor") {
    const report = await createDoctorReport(homeDir, env);
    if (parsed.json) io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else io.stdout.write(formatDoctorReport(report));
    return report.status === "error" ? COMMAND_FAILED_EXIT_CODE : 0;
  }

  let response: ProfilePilotManagementResponse;
  try {
    response = await requestProfilePilotManagement(parsed.command, homeDir, env);
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException;
    const unavailable = candidate?.code === "ENOENT" || candidate?.code === "ECONNREFUSED" || candidate?.code === "EPIPE";
    const payload = {
      ok: false,
      error: {
        code: unavailable ? "PROFILEPILOT_APP_NOT_RUNNING" : "PROFILEPILOT_CLI_CONNECTION_ERROR",
        message: unavailable
          ? "无法连接 ProfilePilot。请先启动桌面应用后重试。"
          : candidate?.message || String(error)
      }
    };
    writeCliOutput(io, parsed.json, payload, true);
    return unavailable ? SERVER_UNAVAILABLE_EXIT_CODE : COMMAND_FAILED_EXIT_CODE;
  }

  if (!response.ok) {
    writeCliOutput(io, parsed.json, response, true);
    return COMMAND_FAILED_EXIT_CODE;
  }
  writeCliOutput(io, parsed.json, response, false, parsed.command.action);
  return 0;
}

export function parseProfilePilotCliArgs(args: string[]): ParsedCliCommand {
  args = normalizeCliArgs(args);
  if (args[0] === "agent") return parseAgentCliArgs(args.slice(1));
  const json = args.includes("--json");
  const yes = args.includes("--yes");
  if (args[0] === "logs") return parseLogsArgs(args.slice(1), json);
  if (args[0] === "doctor") {
    const extra = args.slice(1).filter((arg) => arg !== "--json");
    if (extra.length) throw new Error(`doctor 不支持参数：${extra.join(" ")}`);
    return { local: "doctor", json };
  }
  const positionals = args.filter((arg) => arg !== "--json" && arg !== "--yes");
  if (positionals[0] === "status" && positionals.length === 1) {
    return { json, command: { action: "ping" } };
  }
  const noun = positionals[0];
  const verb = positionals[1];
  if ((noun !== "profile" && noun !== "profiles") || !verb) {
    throw new Error("用法错误：请使用 profile <list|get|create|rename|start|stop|delete>。");
  }
  if (verb === "list" && positionals.length === 2) {
    return { json, command: { action: "profile.list" } };
  }
  if (verb === "get" || verb === "start" || verb === "stop" || verb === "delete") {
    const selector = requiredValue(positionals[2], `${verb} 需要 Profile 名称或 ID`);
    if (positionals.length !== 3) throw new Error(`${verb} 只接受一个 Profile 名称或 ID。`);
    const action = `profile.${verb}` as "profile.get" | "profile.start" | "profile.stop" | "profile.delete";
    return {
      json,
      command: action === "profile.delete"
        ? { action, selector, confirmed: yes }
        : { action, selector }
    };
  }
  if (verb === "create") {
    const name = positionals[2] === "--name" && positionals.length === 4
      ? positionals[3]
      : positionals.length === 3
        ? positionals[2]
        : undefined;
    return { json, command: { action: "profile.create", name: requiredValue(name, "create 需要 --name <名称>") } };
  }
  if (verb === "rename") {
    if (positionals.length !== 4) throw new Error("rename 需要 Profile 名称或 ID，以及新名称。");
    return {
      json,
      command: {
        action: "profile.rename",
        selector: requiredValue(positionals[2], "rename 需要 Profile 名称或 ID"),
        name: requiredValue(positionals[3], "rename 需要新名称")
      }
    };
  }
  throw new Error(`不支持的 profile 命令：${verb}`);
}

function normalizeCliArgs(args: string[]): string[] {
  if (!args.length) return ["agent", "chat"];
  if (["run", "chat", "list", "show", "watch", "reply", "resume", "pause", "cancel", "takeover", "send"].includes(args[0])) {
    return ["agent", ...args];
  }
  if (["--profile", "--resume", "--prompt-file", "--authorization", "--minutes", "--actions", "--budget", "--screen-reader", "--reduced-motion", "--"].includes(args[0])) {
    return ["agent", "chat", ...args];
  }
  return args;
}

function parseLogsArgs(args: string[], json: boolean): ParsedLogsCliCommand {
  const levels: DiagnosticLogLevel[] = [];
  let since: number | null = null;
  let limit = 200;
  let follow = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") continue;
    if (arg === "--follow" || arg === "-f") {
      follow = true;
      continue;
    }
    if (arg === "--level") {
      const value = args[index + 1];
      if (!isDiagnosticLogLevel(value)) throw new Error("--level 只支持 debug、info、warn 或 error。");
      levels.push(value);
      index += 1;
      continue;
    }
    if (arg === "--since") {
      since = parseSince(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      const value = Number(args[index + 1]);
      if (!Number.isSafeInteger(value) || value <= 0 || value > 5_000) {
        throw new Error("--limit 必须是 1 到 5000 之间的整数。");
      }
      limit = value;
      index += 1;
      continue;
    }
    throw new Error(`logs 不支持参数：${arg}`);
  }
  return { local: "logs", json, levels, since, limit, follow };
}

function parseSince(value: string | undefined, now = Date.now()): number {
  const normalized = String(value || "").trim();
  const relative = /^(\d+)(s|m|h|d)$/i.exec(normalized);
  if (relative) {
    const units: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return now - Number(relative[1]) * units[relative[2].toLowerCase()];
  }
  const absolute = Date.parse(normalized);
  if (Number.isFinite(absolute)) return absolute;
  throw new Error("--since 需要相对时间（如 30m、2h、7d）或 ISO 时间。");
}

function isDiagnosticLogLevel(value: string | undefined): value is DiagnosticLogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

async function runLogsCommand(
  parsed: ParsedLogsCliCommand,
  io: Pick<NodeJS.Process, "stdout" | "stderr">,
  homeDir: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const read = (): DiagnosticLogEntry[] => readDiagnosticLogs({
    homeDir,
    env,
    since: parsed.since,
    levels: parsed.levels,
    limit: parsed.limit
  });
  let entries = read();
  writeLogEntries(io.stdout, entries, parsed.json);
  if (!parsed.follow) {
    if (!parsed.json && !entries.length) io.stdout.write("没有匹配的诊断日志。\n");
    return;
  }

  const seen = new Set(entries.map(logEntryIdentity));
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      entries = read();
      const fresh = entries.filter((entry) => !seen.has(logEntryIdentity(entry)));
      for (const entry of fresh) seen.add(logEntryIdentity(entry));
      while (seen.size > 10_000) seen.delete(seen.values().next().value as string);
      writeLogEntries(io.stdout, fresh, parsed.json);
    }, 500);
    const finish = (): void => {
      clearInterval(timer);
      process.off("SIGTERM", finish);
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

function writeLogEntries(
  stream: Pick<NodeJS.WriteStream, "write">,
  entries: DiagnosticLogEntry[],
  json: boolean
): void {
  for (const entry of entries) {
    if (json) {
      stream.write(`${JSON.stringify(entry)}\n`);
      continue;
    }
    const details = entry.details === undefined ? "" : `\n  ${JSON.stringify(entry.details)}`;
    stream.write(`${entry.timestamp} ${entry.level.toUpperCase().padEnd(5)} ${entry.component}/${entry.event} ${entry.message}${details}\n`);
  }
}

function logEntryIdentity(entry: DiagnosticLogEntry): string {
  return `${entry.timestamp}\0${entry.pid}\0${entry.level}\0${entry.component}\0${entry.event}\0${entry.message}`;
}

export interface ProfilePilotDoctorReport {
  status: "ok" | "warning" | "error";
  checked_at: string;
  cli_version: string;
  runtime: {
    node: string;
    platform: string;
    arch: string;
  };
  app: {
    running: boolean;
    version: string | null;
    protocol_version: number | null;
    pid: number | null;
    error: string | null;
  };
  logs: ReturnType<typeof getDiagnosticLogStats> & {
    recent_errors: number;
    latest_error: Pick<DiagnosticLogEntry, "timestamp" | "component" | "event" | "message"> | null;
  };
}

export async function createDoctorReport(
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): Promise<ProfilePilotDoctorReport> {
  let appStatus: ProfilePilotDoctorReport["app"];
  try {
    const response = await requestProfilePilotManagement({ action: "ping" }, homeDir, env, 3_000);
    if (!response.ok) throw new Error(`${response.error.message} (${response.error.code})`);
    const data = response.data as Record<string, unknown>;
    appStatus = {
      running: true,
      version: typeof data.app_version === "string" ? data.app_version : null,
      protocol_version: typeof data.protocol_version === "number" ? data.protocol_version : null,
      pid: typeof data.pid === "number" ? data.pid : null,
      error: null
    };
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException;
    appStatus = {
      running: false,
      version: null,
      protocol_version: null,
      pid: null,
      error: candidate.code === "ENOENT" || candidate.code === "ECONNREFUSED" || candidate.code === "EPIPE"
        ? "ProfilePilot 桌面应用未运行"
        : candidate.message || String(error)
    };
  }
  const recentErrors = readDiagnosticLogs({
    homeDir,
    env,
    since: Date.now() - 24 * 60 * 60 * 1_000,
    levels: ["error"],
    limit: 5_000
  });
  const latestError = recentErrors.at(-1);
  return {
    status: appStatus.running ? (recentErrors.length ? "warning" : "ok") : "warning",
    checked_at: new Date().toISOString(),
    cli_version: PROFILEPILOT_CLI_VERSION,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    app: appStatus,
    logs: {
      ...getDiagnosticLogStats(homeDir, env),
      recent_errors: recentErrors.length,
      latest_error: latestError ? {
        timestamp: latestError.timestamp,
        component: latestError.component,
        event: latestError.event,
        message: latestError.message
      } : null
    }
  };
}

function formatDoctorReport(report: ProfilePilotDoctorReport): string {
  const state = report.status === "ok" ? "正常" : report.status === "warning" ? "需要注意" : "异常";
  const app = report.app.running
    ? `运行中 · v${report.app.version || "unknown"} · PID ${report.app.pid || "?"}`
    : `未连接 · ${report.app.error || "原因未知"}`;
  const latest = report.logs.latest_error
    ? `\n最近错误：${report.logs.latest_error.timestamp} ${report.logs.latest_error.component}/${report.logs.latest_error.event} ${report.logs.latest_error.message}`
    : "";
  return [
    `ProfilePilot Doctor：${state}`,
    `桌面应用：${app}`,
    `CLI：v${report.cli_version} · Node ${report.runtime.node} · ${report.runtime.platform}/${report.runtime.arch}`,
    `诊断日志：${report.logs.files} 个文件 · ${formatBytes(report.logs.bytes)} · 最近 24 小时 ${report.logs.recent_errors} 个错误`,
    `日志路径：${report.logs.active_file}${latest}`,
    ""
  ].join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

export async function requestProfilePilotManagement(
  command: ProfilePilotManagementCommand,
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = REQUEST_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<ProfilePilotManagementResponse> {
  signal?.throwIfAborted();
  const [token, socketPath] = await Promise.all([
    fs.readFile(profilePilotManagementSecretPath(homeDir, env), "utf8").then((value) => value.trim()),
    Promise.resolve(profilePilotManagementSocketPath(homeDir, env))
  ]);
  const request: ProfilePilotManagementRequest = {
    version: PROFILEPILOT_MANAGEMENT_PROTOCOL_VERSION,
    id: randomUUID(),
    token,
    command
  };
  signal?.throwIfAborted();
  // Phone screenshots are already bounded by the companion transport (8 MiB).
  // Allow its image plus the management envelope without relaxing request limits.
  const maxResponseBytes = command.action === "phone" && command.method === "basic-action" ? PROFILEPILOT_PHONE_BASIC_MAX_RESPONSE_BYTES
    : command.action === "phone" && ["action", "wrapper-action"].includes(command.method) ? PROFILEPILOT_PHONE_MAX_RESPONSE_BYTES : PROFILEPILOT_MANAGEMENT_MAX_MESSAGE_BYTES;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, response?: ProfilePilotManagementResponse): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else if (response) resolve(response);
    };
    const abort = (): void => finish(Object.assign(new Error("终端连接已中断。"), { name: "AbortError" }));
    signal?.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => finish(Object.assign(new Error("连接 ProfilePilot 管理服务超时。"), { code: "ETIMEDOUT" })));
    socket.once("error", (error) => finish(error));
    socket.once("end", () => finish(Object.assign(new Error("ProfilePilot 管理连接已关闭。"), { code: "ECONNRESET" })));
    socket.once("close", () => finish(Object.assign(new Error("ProfilePilot 管理连接已关闭。"), { code: "ECONNRESET" })));
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > maxResponseBytes) {
        finish(new Error("ProfilePilot 管理响应超过大小限制。"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(undefined, JSON.parse(buffer.slice(0, newline)) as ProfilePilotManagementResponse);
      } catch {
        finish(new Error("ProfilePilot 返回了无效 JSON。"));
      }
    });
  });
}

function writeCliOutput(
  io: Pick<NodeJS.Process, "stdout" | "stderr">,
  json: boolean,
  payload: unknown,
  error: boolean,
  action?: ProfilePilotManagementCommand["action"]
): void {
  const stream = error ? io.stderr : io.stdout;
  if (json) {
    stream.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (error) {
    const response = payload as { error?: { code?: string; message?: string } };
    stream.write(`[ProfilePilot] ${response.error?.message || "命令执行失败"}${response.error?.code ? ` (${response.error.code})` : ""}\n`);
    return;
  }
  stream.write(formatHumanSuccess(payload as ProfilePilotManagementResponse, action));
}

function formatHumanSuccess(response: ProfilePilotManagementResponse, action?: ProfilePilotManagementCommand["action"]): string {
  if (!response.ok) return "";
  const data = response.data as Record<string, unknown>;
  if (action === "ping") {
    return `ProfilePilot 正在运行 · App ${String(data.app_version || "unknown")} · Protocol v${String(data.protocol_version || "?")}\n`;
  }
  if (action === "profile.list") {
    const profiles = Array.isArray(data.profiles) ? data.profiles as Array<Record<string, unknown>> : [];
    if (!profiles.length) return "没有可用 Profile。\n";
    const rows = profiles.map((profile) => {
      const state = profile.running ? "运行中" : "未运行";
      const access = profile.agent_access === "blocked" ? "Agent 禁止" : "Agent 可用";
      return `${state.padEnd(5)}  ${access.padEnd(8)}  ${String(profile.name)}  ${String(profile.id)}`;
    });
    return `${rows.join("\n")}\n`;
  }
  if (action === "profile.get") {
    return `${formatProfile(data.profile as Record<string, unknown>)}\n`;
  }
  if (action === "profile.delete") {
    const deleted = data.deleted_profile as Record<string, unknown>;
    return `已删除 Profile“${String(deleted?.name || "") }”${data.recoverable ? "，数据已移入废纸篓" : ""}。\n`;
  }
  const profile = data.profile as Record<string, unknown>;
  const changed = data.changed === false ? "无需变更" : "完成";
  return `${changed}：${formatProfile(profile)}\n`;
}

function formatProfile(profile: Record<string, unknown> | undefined): string {
  if (!profile) return "Profile 状态未知";
  return `${String(profile.name)} · ${profile.running ? "运行中" : "未运行"} · ${String(profile.id)}`;
}

function requiredValue(value: string | undefined, message: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function helpText(): string {
  return `ppilot · ProfilePilot CLI ${PROFILEPILOT_CLI_VERSION}

用法：
  ppilot                                      进入对话并选择 Profile
  ppilot --profile <名称|ID>                   使用指定 Profile 对话
  ppilot --resume <任务ID>                     继续已有对话
  ppilot browser <method>                     ppilot browser CLI：扩展 / Gateway 统一浏览器控制
  ppilot browser --help                       浏览器命令与会话说明
  ppilot phone --help                         ppilot phone CLI：设备、会话与手机控制
  ppilot phone wrap --help                    为脚本或工具建立手机控制会话
  ppilot phone adb --help                     ADB 兼容命令
  ppilot <run|chat|list|show|watch|reply|resume|pause|cancel|takeover|send> [参数]
  ppilot chat --help
  ppilot status [--json]
  ppilot doctor [--json]
  ppilot logs [--level <级别>] [--since <时间>] [--limit <数量>] [--follow] [--json]
  ppilot profile list [--json]
  ppilot profile get <名称|ID> [--json]
  ppilot profile create --name <名称> [--json]
  ppilot profile rename <名称|ID> <新名称> [--json]
  ppilot profile start <名称|ID> [--json]
  ppilot profile stop <名称|ID> [--json]
  ppilot profile delete <名称|ID> --yes [--json]

说明：
  对话需要交互终端；任务与桌面应用同步，桌面应用需保持运行。
  logs 可在桌面应用未运行时读取本地脱敏诊断日志；--since 支持 30m、2h、7d 或 ISO 时间。
  doctor 检查桌面应用连接、版本、运行环境和最近 24 小时错误。
  修改操作仅支持 ProfilePilot 创建的独立 Profile。
  系统 Profile 和子 Profile 可以查询，但不能通过 Profile 管理命令修改。
  CLI 通过本机受保护 Socket 调用正在运行的 ProfilePilot，不会直接修改 profiles.json。
`;
}

if (require.main === module) {
  void runProfilePilotCli().then((code) => {
    process.exitCode = code;
  });
}
