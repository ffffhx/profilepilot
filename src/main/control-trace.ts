import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { RUNNING_CONTROL_BUILD } from "./runtime-identity";
import type { ControlRecovery } from "../shared/control-recovery";

export interface ControlTraceEvent {
  requestId: string; sessionId?: string; target?: string; method: string; durationMs: number;
  generation?: number; code?: string; recovery?: ControlRecovery; extensionVersion?: string;
}
const digest = (value: unknown) => typeof value === "string" ? createHash("sha256").update(value).digest("hex").slice(0, 16) : undefined;
const identifier = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : undefined;
/** Whitelist metadata instead of attempting to redact arbitrary page/error text.
 * One writer per service/process file; two bounded generations, best effort. */
export function writeControlTrace(root: string, route: "extension" | "gateway" | "phone", event: ControlTraceEvent, limit = 2 * 1024 * 1024): void {
  try {
    const directory = path.join(root, "control-diagnostics");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${route}-${process.pid}.jsonl`);
    if (existsSync(file) && statSync(file).size >= limit) {
      const previous = file + ".1";
      if (existsSync(previous)) unlinkSync(previous);
      renameSync(file, previous);
    }
    const row = { at: new Date().toISOString(), route, pid: process.pid, platform: process.platform,
      buildId: RUNNING_CONTROL_BUILD.buildId, requestId: /^[a-f0-9-]{16,128}$/i.test(event.requestId) ? event.requestId : digest(event.requestId),
      sessionHash: digest(event.sessionId), targetHash: digest(event.target), method: identifier(event.method),
      durationMs: Math.max(0, Math.round(event.durationMs)), generation: Number.isSafeInteger(event.generation) ? event.generation : undefined,
      code: identifier(event.code), stage: event.recovery?.stage, actionOutcome: event.recovery?.actionOutcome,
      extensionVersion: identifier(event.extensionVersion), automaticReplay: false };
    appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
  } catch { /* Diagnostics must not change command outcome or trigger replay. */ }
}
