#!/usr/bin/env node
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  PROFILEPILOT_MANAGEMENT_MAX_MESSAGE_BYTES,
  PROFILEPILOT_MANAGEMENT_PROTOCOL_VERSION,
  profilePilotManagementSecretPath,
  profilePilotManagementSocketPath,
  type ProfilePilotManagementCommand,
  type ProfilePilotManagementRequest,
  type ProfilePilotManagementResponse
} from "./profilepilot-management-protocol";

export const PROFILEPILOT_CLI_VERSION = "0.1.0";
const REQUEST_TIMEOUT_MS = 35_000;
const USAGE_EXIT_CODE = 2;
const SERVER_UNAVAILABLE_EXIT_CODE = 69;
const COMMAND_FAILED_EXIT_CODE = 1;

interface ParsedCliCommand {
  command: ProfilePilotManagementCommand;
  json: boolean;
}

export async function runProfilePilotCli(
  args = process.argv.slice(2),
  io: Pick<NodeJS.Process, "stdout" | "stderr"> = process
): Promise<number> {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    io.stdout.write(helpText());
    return 0;
  }
  if (args.includes("--version") || args.includes("-V")) {
    io.stdout.write(`${PROFILEPILOT_CLI_VERSION}\n`);
    return 0;
  }

  let parsed: ParsedCliCommand;
  try {
    parsed = parseProfilePilotCliArgs(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`[ProfilePilot] ${message}\n\n${helpText()}`);
    return USAGE_EXIT_CODE;
  }

  let response: ProfilePilotManagementResponse;
  try {
    response = await requestProfilePilotManagement(parsed.command);
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
  const json = args.includes("--json");
  const yes = args.includes("--yes");
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

export async function requestProfilePilotManagement(
  command: ProfilePilotManagementCommand,
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): Promise<ProfilePilotManagementResponse> {
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
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, response?: ProfilePilotManagementResponse): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else if (response) resolve(response);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => finish(Object.assign(new Error("连接 ProfilePilot 管理服务超时。"), { code: "ETIMEDOUT" })));
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > PROFILEPILOT_MANAGEMENT_MAX_MESSAGE_BYTES) {
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
  return `ProfilePilot 管理 CLI ${PROFILEPILOT_CLI_VERSION}

用法：
  profilepilot status [--json]
  profilepilot profile list [--json]
  profilepilot profile get <名称|ID> [--json]
  profilepilot profile create --name <名称> [--json]
  profilepilot profile rename <名称|ID> <新名称> [--json]
  profilepilot profile start <名称|ID> [--json]
  profilepilot profile stop <名称|ID> [--json]
  profilepilot profile delete <名称|ID> --yes [--json]

说明：
  修改操作仅支持 ProfilePilot 创建的独立 Profile。
  系统 Profile 和子 Profile 可以查询，但不能通过管理 CLI 修改。
  CLI 通过本机受保护 Socket 调用正在运行的 ProfilePilot，不会直接修改 profiles.json。
`;
}

if (require.main === module) {
  void runProfilePilotCli().then((code) => {
    process.exitCode = code;
  });
}
