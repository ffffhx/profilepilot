import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentControlNotice } from "../shared/types";
import type { GatewayProfileBinding } from "./browser-gateway-control";

const SAFE_SESSION_RE = /^[A-Za-z0-9._:-]+$/;

export function agentControlNoticePaths(homeDir: string, session: string): string[] {
  return [
    path.join(homeDir, ".agent-browser", `${session}.profilepilot-control.json`),
    path.join(homeDir, ".profilepilot", "agent-control", `${session}.json`)
  ];
}

export function writeGatewayDriverNoticeSync(
  homeDir: string,
  session: string,
  profile: GatewayProfileBinding,
  state: "reconnecting" | "connected" | "exhausted",
  expiresAt?: string
): AgentControlNotice | null {
  if (!SAFE_SESSION_RE.test(session)) return null;
  const currentVersion = newestControlVersion(homeDir, session);
  const terminal = state === "exhausted";
  const reason = state === "reconnecting"
    ? "driver_disconnected"
    : state === "connected"
      ? "driver_reconnected"
      : "driver_reconnect_exhausted";
  const notice: AgentControlNotice = {
    version: 1,
    controlVersion: currentVersion + 1,
    code: terminal ? "AGENT_DRIVER_RECONNECT_FAILED" : state === "connected" ? "AGENT_DRIVER_RECONNECTED" : "AGENT_DRIVER_RECONNECTING",
    reason,
    ownership: terminal ? "user" : "agent",
    message: terminal
      ? "浏览器驱动重连失败，Gateway 已结束旧 Session 并释放 Profile"
      : state === "connected"
        ? "浏览器驱动已重新连接 Gateway"
        : "浏览器驱动连接已中断，Gateway 正在等待 Agent 重连",
    action: terminal
      ? "停手：旧 Session 已失效，不要静默重连；如需继续，请显式创建新的 Agent Session"
      : state === "connected"
        ? "重新 snapshot 后继续，不要复用断连前的元素引用"
        : "最多重试连接 3 次；连接恢复后重新 snapshot，再继续操作",
    hardStop: terminal,
    profileId: profile.profileId,
    profileName: profile.profileName,
    pid: profile.daemonPid || process.pid,
    label: profile.driverLabel || profile.driverKind || "browser driver",
    session,
    sessionTitle: profile.project,
    agent: profile.agent,
    at: new Date().toISOString(),
    expiresAt: expiresAt || (terminal ? "9999-12-31T23:59:59.999Z" : new Date(Date.now() + 60_000).toISOString())
  };
  for (const filePath of agentControlNoticePaths(homeDir, session)) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(notice, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, filePath);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return notice;
}

function newestControlVersion(homeDir: string, session: string): number {
  let version = 0;
  for (const filePath of agentControlNoticePaths(homeDir, session)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<AgentControlNotice>;
      if (parsed.session === session && Number.isSafeInteger(parsed.controlVersion)) {
        version = Math.max(version, Number(parsed.controlVersion));
      }
    } catch {
      // Try the mirrored path.
    }
  }
  return version;
}
