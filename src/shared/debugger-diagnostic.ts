export interface DebuggerDiagnostic {
  id: string;
  at: string;
  reason: "target_closed" | "canceled_by_user" | "unknown";
  phase: "detached" | "attaching" | "recovered" | "failed" | "cancelled";
  attempts: number;
  code?: string;
}

/** Keep lifecycle metadata only: no page URLs, credentials or exception text. */
export function parseDebuggerDiagnostic(value: unknown): DebuggerDiagnostic | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as DebuggerDiagnostic;
  if (typeof v.id !== "string" || !/^[a-f0-9-]{36}$/i.test(v.id) ||
      typeof v.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.at) ||
      !["target_closed", "canceled_by_user", "unknown"].includes(v.reason) ||
      !["detached", "attaching", "recovered", "failed", "cancelled"].includes(v.phase) ||
      !Number.isInteger(v.attempts) || v.attempts < 0 || v.attempts > 2) return;
  return { id: v.id, at: v.at, reason: v.reason, phase: v.phase, attempts: v.attempts,
    ...(typeof v.code === "string" && /^NATIVE_[A-Z_]{1,64}$/.test(v.code) ? { code: v.code } : {}) };
}
