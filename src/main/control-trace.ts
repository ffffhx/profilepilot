import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { RUNNING_CONTROL_BUILD } from "./runtime-identity";
import type { ControlRecovery } from "../shared/control-recovery";
import { parseDebuggerDiagnostic, type DebuggerDiagnostic } from "../shared/debugger-diagnostic";

export interface ControlTraceEvent {
  requestId: string; sessionId?: string; target?: string; method: string; durationMs: number;
  generation?: number; code?: string; recovery?: ControlRecovery; extensionVersion?: string;
  debuggerDiagnostic?: DebuggerDiagnostic;
  scope?: "cli" | "service";
  taskKind?: "real" | "verification" | "unspecified";
  taskId?: string;
  operationId?: string;
  recoveryOf?: string;
  actionKind?: string;
  actionRequestId?: string;
  ok?: boolean;
  exitCode?: number;
  invocationId?: string;
}
export const CONTROL_TRACE_ROUTES = ["extension", "gateway", "phone", "desktop", "electron", "gpui", "remote", "management"] as const;
export type ControlTraceRoute = typeof CONTROL_TRACE_ROUTES[number];
const digest = (value: unknown) => typeof value === "string" ? createHash("sha256").update(value).digest("hex").slice(0, 16) : undefined;
const identifier = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : undefined;
const actionKinds = new Set(("tap swipe key text snapshot screenshot click dblclick double_click fill type press scroll hover focus select toggle check uncheck upload move drag wheel invoke set_value type_text press_key expand collapse restore minimize maximize launch stop install uninstall clear-data click_element double_click_element hover_element drag_element keyboard set_text scroll_element ping get_element get_element_bounds find_elements screenshot_element screenshot_region get_logs get_frame_report get_frame_stats get_performance_report list_app_commands get_text_info get_value get_element_state highlight_elements clear_highlights record_performance").split(" "));
const safeKind = (value: unknown) => typeof value === "string" ? actionKinds.has(value) ? value : `unknown:${digest(value)}` : undefined;
/** Whitelist metadata instead of attempting to redact arbitrary page/error text.
 * One writer per service/process file; two bounded generations, best effort. */
export function writeControlTrace(root: string, route: ControlTraceRoute, event: ControlTraceEvent, limit = 2 * 1024 * 1024): void {
  let lock: string | undefined;
  try {
    if (!CONTROL_TRACE_ROUTES.includes(route)) return;
    const directory = path.join(root, "control-diagnostics");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // CLI processes are short lived. Keep a bounded stream per route rather
    // than creating thousands of PID files. An exclusive lock protects rotation
    // as well as appends across concurrent agents; contention skips diagnostics.
    const file = path.join(directory, event.scope === "cli" ? `cli-${route}.jsonl` : `${route}-${process.pid}.jsonl`);
    if (event.scope === "cli") {
      const candidate = file + ".lock";
      try { mkdirSync(candidate); lock = candidate; }
      catch {
        // A crashed CLI must not permanently silence this route. Never remove
        // a lock whose owner is still alive (including permission-denied PIDs).
        // Serialize reclaimers, then re-read the old owner under that guard.
        // A normal writer may win after rmdir; in that case we never own or
        // clean up its new lock. A second reclaimer cannot delete that lock.
        const reclaim = candidate + ".recover";
        try { mkdirSync(reclaim); } catch { return; }
        try {
          let stale = false;
          try {
            const owner = Number(readFileSync(path.join(candidate, "pid"), "utf8"));
            if (Number.isSafeInteger(owner) && owner > 0) {
              try { process.kill(owner, 0); } catch (error) { stale = (error as NodeJS.ErrnoException).code === "ESRCH"; }
            }
          } catch { stale = Date.now() - statSync(candidate).mtimeMs > 60_000; }
          if (!stale) return;
          try { unlinkSync(path.join(candidate, "pid")); } catch { /* crashed before owner write */ }
          rmdirSync(candidate); mkdirSync(candidate); lock = candidate;
        } finally { rmdirSync(reclaim); }
      }
      writeFileSync(path.join(lock, "pid"), String(process.pid), { flag: "wx" });
    }
    if (existsSync(file) && statSync(file).size >= limit) {
      const previous = file + ".1";
      if (existsSync(previous)) unlinkSync(previous);
      renameSync(file, previous);
    }
    const row = { version: 2, at: new Date().toISOString(), route, pid: process.pid, platform: process.platform,
      buildId: RUNNING_CONTROL_BUILD.buildId, requestId: /^[a-f0-9-]{16,128}$/i.test(event.requestId) ? event.requestId : digest(event.requestId),
      sessionHash: digest(event.sessionId), targetHash: digest(event.target), method: identifier(event.method),
      durationMs: Math.max(0, Math.round(event.durationMs)), generation: Number.isSafeInteger(event.generation) ? event.generation : undefined,
      code: identifier(event.code), stage: event.recovery?.stage, actionOutcome: event.recovery?.actionOutcome,
      scope: event.scope === "cli" ? "cli" : "service",
      invocationId: identifier(event.invocationId),
      taskKind: ["real", "verification"].includes(event.taskKind || "") ? event.taskKind : "unspecified",
      taskHash: digest(event.taskId), operationHash: digest(event.operationId), recoveryOfHash: digest(event.recoveryOf),
      actionKind: safeKind(event.actionKind), actionRequestId: digest(event.actionRequestId),
      ok: typeof event.ok === "boolean" ? event.ok : undefined,
      exitCode: Number.isSafeInteger(event.exitCode) ? event.exitCode : undefined,
      requiresUser: event.recovery?.requiresUser === true, nextStep: event.recovery?.nextStep,
      extensionVersion: identifier(event.extensionVersion), debuggerDiagnostic: parseDebuggerDiagnostic(event.debuggerDiagnostic), automaticReplay: false };
    appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
  } catch { /* Diagnostics must not change command outcome or trigger replay. */ }
  finally { if (lock) { try { unlinkSync(path.join(lock, "pid")); rmdirSync(lock); } catch { /* best effort */ } } }
}
