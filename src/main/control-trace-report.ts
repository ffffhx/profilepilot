import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CONTROL_TRACE_ROUTES, type ControlTraceRoute } from "./control-trace";

export interface RecordedControlTrace {
  at: string; route: ControlTraceRoute; scope: "cli"; requestId: string;
  method?: string; actionKind?: string; taskKind: "real" | "verification" | "unspecified";
  taskHash?: string; sessionHash?: string; operationHash?: string; recoveryOfHash?: string;
  ok: boolean; durationMs: number; requiresUser?: boolean; code?: string;
}
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{16}$/.test(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(value);

export function readControlTraceSamples(root: string, since = 0, until = Date.now()) {
  const directory = path.join(root, "control-diagnostics");
  const rows: RecordedControlTrace[] = [];
  const seen = new Set<string>();
  let skippedLines = 0, filesRead = 0;
  let files: string[];
  try { files = readdirSync(directory); } catch { return { rows, skippedLines, filesRead }; }
  for (const route of CONTROL_TRACE_ROUTES) for (const name of [`cli-${route}.jsonl.1`, `cli-${route}.jsonl`]) {
    if (!files.includes(name)) continue;
    try {
      const file = path.join(directory, name), stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) continue;
      filesRead++;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const value = JSON.parse(line), timestamp = Date.parse(value.at);
          if (value.scope !== "cli" || value.route !== route || !Number.isFinite(timestamp) || typeof value.ok !== "boolean") { skippedLines++; continue; }
          if (timestamp < since || timestamp > until) continue;
          if (identifier(value.invocationId)) { if (seen.has(value.invocationId)) continue; seen.add(value.invocationId); }
          rows.push({ at: new Date(timestamp).toISOString(), route, scope: "cli", requestId: identifier(value.requestId) ? value.requestId : "unknown",
            method: identifier(value.method) ? value.method : undefined, actionKind: identifier(value.actionKind) ? value.actionKind : undefined,
            taskKind: ["real", "verification"].includes(value.taskKind) ? value.taskKind : "unspecified",
            taskHash: hash(value.taskHash) ? value.taskHash : undefined, sessionHash: hash(value.sessionHash) ? value.sessionHash : undefined,
            operationHash: hash(value.operationHash) ? value.operationHash : undefined, recoveryOfHash: hash(value.recoveryOfHash) ? value.recoveryOfHash : undefined,
            ok: value.ok, durationMs: Number.isFinite(value.durationMs) && value.durationMs >= 0 ? value.durationMs : 0,
            requiresUser: value.requiresUser === true, code: identifier(value.code) ? value.code : undefined });
        } catch { skippedLines++; }
      }
    } catch { /* A writer may rotate between listing and reading. */ }
  }
  rows.sort((a, b) => a.at.localeCompare(b.at));
  return { rows, skippedLines, filesRead };
}

const usefulMethods = new Set(["observe", "snapshot", "screenshot", "read", "get", "action", "click", "dblclick", "fill", "type", "press", "scroll", "eval", "cdp", "open", "newTab", "app", "exec", "install", "call"]);
const distribution = (values: number[]) => {
  if (!values.length) return { samples: 0, median: null, mean: null, max: null };
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return { samples: sorted.length, median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    mean: Math.round(values.reduce((a, b) => a + b, 0) / values.length * 100) / 100, max: sorted[sorted.length - 1] };
};

export function summarizeControlTraces(rows: RecordedControlTrace[]) {
  const ordered = [...rows].sort((a, b) => a.at.localeCompare(b.at));
  const byRoute: Record<string, { calls: number; successful: number; failed: number }> = {};
  const byTaskKind: Record<string, number> = { real: 0, verification: 0, unspecified: 0 };
  const tasks = new Map<string, RecordedControlTrace[]>(), operations = new Map<string, RecordedControlTrace[]>();
  const userInterventionReasons: Record<string, number> = {};
  const taskScope = (row: RecordedControlTrace) => row.taskHash ? `${row.taskKind}:task:${row.taskHash}` : row.sessionHash ? `${row.taskKind}:${row.route}:session:${row.sessionHash}` : `${row.taskKind}:${row.route}:unscoped`;
  for (const row of ordered) {
    const count = byRoute[row.route] ||= { calls: 0, successful: 0, failed: 0 };
    count.calls++; row.ok ? count.successful++ : count.failed++;
    byTaskKind[row.taskKind]++;
    // Explicit task IDs can span routes. Sessions remain scoped to their route.
    const task = row.taskHash ? `${row.taskKind}:task:${row.taskHash}` : row.sessionHash ? `${row.taskKind}:${row.route}:session:${row.sessionHash}` : undefined;
    if (task) { const list = tasks.get(task) || []; list.push(row); tasks.set(task, list); }
    if (row.operationHash) { const key = `${taskScope(row)}:${row.operationHash}`; const list = operations.get(key) || []; list.push(row); operations.set(key, list); }
    if (row.requiresUser) { const reason = row.code || "UNSPECIFIED"; userInterventionReasons[reason] = (userInterventionReasons[reason] || 0) + 1; }
  }
  const preparationCommands: number[] = [];
  for (const task of tasks.values()) {
    const first = task.findIndex(row => row.ok && usefulMethods.has(row.method || ""));
    if (first >= 0) preparationCommands.push(first); // excludes the first useful command itself
  }
  let firstAttemptSuccesses = 0, recoveredOperations = 0;
  const recoveryDurations: number[] = [];
  for (const list of operations.values()) {
    if (list[0].ok) firstAttemptSuccesses++;
    const failure = list.find(row => !row.ok);
    if (!failure) continue;
    const recovered = ordered.find(row => row.ok && taskScope(row) === taskScope(failure) && row.at > failure.at &&
      (row.operationHash === failure.operationHash || row.recoveryOfHash === failure.operationHash));
    if (recovered) { recoveredOperations++; recoveryDurations.push(Date.parse(recovered.at) - Date.parse(failure.at)); }
  }
  return { recordedCalls: ordered.length, successfulCalls: ordered.filter(row => row.ok).length,
    failedCalls: ordered.filter(row => !row.ok).length, byRoute, byTaskKind, correlatedTasks: tasks.size,
    commandsBeforeFirstEffectiveOperation: distribution(preparationCommands),
    firstAttempt: { explicitlyCorrelatedOperations: operations.size, successes: firstAttemptSuccesses,
      successRate: operations.size ? firstAttemptSuccesses / operations.size : null },
    recovery: { explicitlyLinkedAttempts: ordered.filter(row => row.recoveryOfHash).length, recoveredOperations, durationMs: distribution(recoveryDurations) },
    userIntervention: { requiredResponses: ordered.filter(row => row.requiresUser).length, reasons: userInterventionReasons },
    definitions: { effectiveOperation: "Successful observe/read/snapshot/screenshot or a productive command; excludes discovery, help, schema, claim and status.",
      firstAttempt: "First recorded call for each explicit --operation-id, within the selected window; not inferred from similar command text.",
      recovery: "A failed explicit operation followed by a successful call sharing its operation ID or explicitly linking --recovery-of.",
      coverage: "Best-effort bounded CLI trace samples, not a complete task success rate. Service events are excluded to prevent double counting. Window boundaries and rotated/missing events can make histories partial." } };
}
