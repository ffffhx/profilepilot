import { controlRecovery, parseControlRecovery, type ControlRecovery } from "../../shared/control-recovery";
import type { ProfilePilotManagementResponse } from "../profilepilot-management-protocol";

type Outcome = ControlRecovery["actionOutcome"];
/** Carry the dispatch boundary through IPC and CLI wrappers without guessing from translated messages. */
export function phoneFailure(code: string, message: string, outcome: Outcome = "not-executed", details?: unknown): Error & { code: string; details: { recovery: ControlRecovery; [key: string]: unknown } } {
  const extra = details && typeof details === "object" && !Array.isArray(details) ? details as Record<string, unknown> : {};
  return Object.assign(new Error(message), { code, details: { ...extra, recovery: controlRecovery(code, { actionOutcome: outcome }) } });
}

export function phoneResponseError(response: Extract<ProfilePilotManagementResponse, { ok: false }>): Error {
  return Object.assign(new Error(response.error.message), { code: response.error.code, details: response.error.details });
}

export function phoneErrorResult(error: unknown, dispatched = false) {
  const value = error as { code?: unknown; message?: unknown; details?: unknown; recovery?: unknown; issues?: { path?: (string | number)[] }[] };
  const code = typeof value?.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(value.code) && (dispatched || value.code.startsWith("PHONE_")) ? value.code
    : dispatched ? "PHONE_EXECUTION_UNCERTAIN" : "PHONE_INVALID_REQUEST";
  const details = value?.details && typeof value.details === "object" ? value.details as Record<string, unknown> : undefined;
  const supplied = parseControlRecovery(value?.recovery) || parseControlRecovery(details?.recovery);
  const recovery = supplied?.cause === code ? supplied : controlRecovery(code, !dispatched ? { actionOutcome: "not-executed" } : {});
  const message = Array.isArray(value?.issues) ? `手机参数无效：${[...new Set(value.issues.map(issue => issue.path?.join(".") || "params"))].join("、")}。运行 phone schema <命令> 查看格式。`
    : typeof value?.message === "string" ? value.message : "手机操作未完成。";
  return { ok: false as const, code, error: message, recovery, ...(details ? { details } : {}) };
}

export function phoneExitCode(recovery: ControlRecovery): number {
  if (recovery.nextStep === "fix-input") return 2;
  if (/SERVICE_UNAVAILABLE|SERVER_UNAVAILABLE/.test(recovery.cause)) return 69;
  if (recovery.actionOutcome === "unknown" || ["wait-for-owner", "return-control", "reobserve"].includes(recovery.nextStep)) return 75;
  return 1;
}
