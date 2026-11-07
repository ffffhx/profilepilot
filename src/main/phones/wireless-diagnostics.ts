import { randomUUID } from "node:crypto";
import { writeDiagnosticLog } from "../diagnostic-log";
import type { WirelessServerEvidence } from "./wireless-server-log";

export type WirelessStage = "discovery" | "pairing" | "connection" | "readiness";
export interface WirelessEvidence {
  exitCode?: number | string;
  signal?: string;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  server?: WirelessServerEvidence;
}

/** Only bounded, redacted output from wireless ADB operations may cross this boundary.
 * Never include argv, stdin, Error.stack, pairing codes or pairing GUIDs. */
export function sanitizeWirelessOutput(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[REDACTED]")
    .replace(/\d{6,}/g, "[REDACTED]")
    .replace(/\b(guid|token|password|secret|credential|authorization|cookie|pairing[_ -]?code)\s*[:=]\s*[^\s\]]+/gi, "$1=[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, "$1 [REDACTED]")
    .replace(/\b(https?|socks5?):\/\/[^\s/@]+@/gi, "$1://[REDACTED]@")
    .trim().slice(0, 1200);
}

export function wirelessEvidence(error: unknown): WirelessEvidence {
  const candidate = error as { code?: unknown; message?: unknown; wirelessEvidence?: WirelessEvidence } | null;
  const evidence = candidate?.wirelessEvidence;
  const exitCode = evidence?.exitCode ?? candidate?.code;
  return {
    ...(typeof exitCode === "number" || typeof exitCode === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(exitCode) ? { exitCode } : {}),
    ...(evidence?.signal && /^SIG[A-Z]{1,12}$/.test(evidence.signal) ? { signal: evidence.signal } : {}),
    ...(evidence?.timedOut ? { timedOut: true } : {}),
    ...(evidence?.stdout ? { stdout: sanitizeWirelessOutput(evidence.stdout) } : {}),
    ...(evidence?.stderr ? { stderr: sanitizeWirelessOutput(evidence.stderr) } : {}),
    ...(evidence?.server?.source === "adb-server" && ["AUTH_REQUIRED", "CONNECTION_REFUSED", "NETWORK_TIMEOUT"].includes(evidence.server.reason)
      ? { server: { source: "adb-server" as const, reason: evidence.server.reason, signature: sanitizeWirelessOutput(evidence.server.signature) } } : {}),
    ...(!evidence && typeof candidate?.message === "string" ? { stderr: sanitizeWirelessOutput(candidate.message) } : {})
  };
}

const stages: Record<WirelessStage, string> = { discovery: "发现设备", pairing: "无线调试配对", connection: "建立无线连接", readiness: "确认设备就绪" };
const messages = {
  ADB_MISSING: ["未找到 Android Platform Tools。", "请先安装或修复电脑上的 Android Platform Tools。"],
  AUTH_REQUIRED: ["电脑未通过平板或手机的无线调试认证。", "在设备上打开「无线调试 → 使用配对码配对」，用最新的 6 位码重新配对。仅允许当前网络不等于完成电脑配对。"],
  CONNECTION_REFUSED: ["无线调试端口拒绝连接。", "地址可能已过期，或无线调试服务未启动。请重新查找，并核对无线调试主页面的连接端口；配对端口不能用作连接端口。"],
  NETWORK_TIMEOUT: ["网络连接超时或地址不可达。", "确认两端在同一局域网，检查访客网络隔离与防火墙；macOS 还需检查本地网络权限。端口超时不能证明尚未配对。"],
  COMMAND_TIMEOUT: ["无线调试命令等待超时，结果尚未确认。", "请先检查设备当前状态并重新查找地址；不要连续提交配对。配对时请保持配对码弹窗打开。"],
  PAIRING_REJECTED: ["设备未确认配对成功，配对码可能错误或已过期。", "重新打开「使用配对码配对」，核对弹窗里的配对地址和最新 6 位码，并保持弹窗打开。"],
  ADB_UNSUPPORTED: ["当前 Android Platform Tools 不支持此无线调试操作。", "请更新电脑上的 Android Platform Tools 后重试。"],
  DEVICE_NOT_READY: ["连接请求已提交，但尚未确认设备就绪。", "请保持设备解锁，重新查找并检查连接状态；此状态不能证明配对失败。"],
  NO_ENDPOINT: ["尚未发现这台设备当前的连接端口。", "请在设备上确认允许当前网络并开启无线调试，再重新查找；也可手动填写主页面的地址。未发现端口不能证明无线调试未开启。"],
  DISCOVERY_FAILED: ["自动发现暂不可用，原因尚未确认。", "可以手动输入设备当前显示的地址。请检查同网连接、防火墙，以及 macOS 本地网络权限。"],
  UNKNOWN: ["失败原因尚未确认。", "请确认设备已允许当前网络，并重新查找当前地址。若这台电脑尚未配对，请使用 6 位配对码；已配对时核对主页面的连接端口。"]
} as const;
type WirelessReason = keyof typeof messages;

export class WirelessFailure extends Error {
  readonly code: string;
  readonly details: { wireless: {
    diagnosticId: string; stage: WirelessStage; reason: WirelessReason; address?: string;
    durationMs: number; evidence: WirelessEvidence;
  } };
  constructor(stage: WirelessStage, address: string | undefined, began: number, evidence: WirelessEvidence, reason?: WirelessReason) {
    evidence = wirelessEvidence({ wirelessEvidence: evidence });
    const output = `${evidence.exitCode ?? ""}\n${evidence.stderr || ""}\n${evidence.stdout || ""}`;
    reason ??= evidence.exitCode === "ENOENT" ? "ADB_MISSING"
      : evidence.timedOut ? "COMMAND_TIMEOUT"
      : /unknown command|unrecognized (?:command|option)|not supported/i.test(output) ? "ADB_UNSUPPORTED"
      : evidence.server?.reason ? evidence.server.reason
      : /authenticate|authentication|unauthorized|CERTIFICATE_UNKNOWN|CERTIFICATE_VERIFY_FAILED|UNKNOWN_CA/i.test(output) ? "AUTH_REQUIRED"
      : /refused|ECONNREFUSED|10061|拒绝/i.test(output) ? "CONNECTION_REFUSED"
      : /timed?\s*out|ETIMEDOUT|10060|unreachable|EHOSTUNREACH|ENETUNREACH|超时/i.test(output) ? "NETWORK_TIMEOUT"
      : stage === "pairing" && /incorrect|wrong code|invalid code|pairing code.*(?:invalid|expired)/i.test(output) ? "PAIRING_REJECTED"
      : stage === "discovery" ? "DISCOVERY_FAILED" : "UNKNOWN";
    const diagnosticId = randomUUID();
    const prefix = stage === "pairing" ? "配对未完成：设备未确认配对成功。" : stage === "discovery" ? "" : "手机未建立无线连接：";
    const code = `PHONE_WIFI_${reason}`;
    const manual = stage === "discovery" && reason === "ADB_UNSUPPORTED" ? " 自动发现不可用时，可手动填写设备当前地址。" : "";
    const guidance = stage === "pairing" && (reason === "CONNECTION_REFUSED" || reason === "UNKNOWN")
      ? "请重新打开「使用配对码配对」，核对该弹窗里的配对地址和最新 6 位码，并保持弹窗打开。主页面的连接端口不能用作配对端口。"
      : messages[reason][1];
    super(`${prefix}${messages[reason][0]}\n${guidance}${manual}\n诊断编号：${diagnosticId}\n阶段：${stages[stage]}${address ? ` · 地址：${address}` : ""}\n错误代码：${code}`);
    this.name = "WirelessFailure";
    this.code = code;
    this.details = { wireless: { diagnosticId, stage, reason, ...(address ? { address } : {}), durationMs: Math.max(0, Date.now() - began), evidence } };
    writeDiagnosticLog("warn", "phone-wireless", "wireless.failed", `${stages[stage]}失败：${messages[reason][0]}`, { code, ...this.details.wireless });
  }
}
