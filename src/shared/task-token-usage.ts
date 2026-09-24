import type { BrowserTask, TaskTokenRecord, ModelTokenUsage } from "./tasks";
import { mergeCostRecords } from "./task-cost";

export type TokenSource = "all" | "model" | "jev" | "helper";
const count = (value: number | undefined): number => Number.isSafeInteger(value) && value! >= 0 ? value! : 0;

export function mergeModelTokens(previous: ModelTokenUsage[], incoming: unknown): ModelTokenUsage[] {
  const models = new Map(previous.map(m => [m.model, { ...m }]));
  if (Array.isArray(incoming)) for (const m of incoming) {
    if (!m || typeof m.model !== "string" || !m.model.trim() || m.model.length > 300) continue;
    const old = models.get(m.model);
    models.set(m.model, { model: m.model, inputTokens: Math.max(count(old?.inputTokens), count(m.inputTokens)), outputTokens: Math.max(count(old?.outputTokens), count(m.outputTokens)) });
  }
  return [...models.values()];
}

export function modelTokenTotals(records: TaskTokenRecord[]): Array<ModelTokenUsage & { historical: boolean }> {
  const groups = new Map<string, ModelTokenUsage & { historical: boolean }>();
  const add = (m: ModelTokenUsage, historical: boolean) => {
    const key = JSON.stringify([historical, m.model]);
    const old = groups.get(key) || { model: m.model, inputTokens: 0, outputTokens: 0, historical };
    old.inputTokens += m.inputTokens; old.outputTokens += m.outputTokens; groups.set(key, old);
  };
  for (const r of records) {
    let input = 0, output = 0;
    for (const m of r.models || []) { add(m, false); input += m.inputTokens; output += m.outputTokens; }
    const remainingInput = Math.max(0, r.inputTokens - input), remainingOutput = Math.max(0, r.outputTokens - output);
    if (remainingInput || remainingOutput) add({ model: r.modelNames?.length ? r.modelNames.join(" / ") : "模型未记录", inputTokens: remainingInput, outputTokens: remainingOutput }, true);
  }
  return [...groups.values()].filter(m => m.inputTokens + m.outputTokens > 0).sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
}

export function updateTokenRecords(previous: TaskTokenRecord[], tasks: BrowserTask[]): TaskTokenRecord[] {
  const records = new Map(previous.map(record => [record.taskId, record]));
  for (const task of tasks) {
    const u = task.usage;
    const next: TaskTokenRecord = {
      taskId: task.id, createdAt: task.createdAt, updatedAt: task.updatedAt,
      inputTokens: count(u.inputTokens), outputTokens: count(u.outputTokens),
      jevInputTokens: count(u.jev?.inputTokens), helperInputTokens: count(u.helper?.inputTokens),
      helperOutputTokens: count(u.helper?.outputTokens),
    };
    const old = records.get(task.id);
    next.costRecords = mergeCostRecords(old?.costRecords || [], task.costRecords || []);
    const taskCost = Number.isFinite(u.costUsd) && u.costUsd >= 0 ? u.costUsd : 0;
    // A verified pricing repair can reduce a previously inflated estimate.
    // Keep that corrected amount in the ledger as well as in the task view.
    next.sdkCostUsd = task.costAccounting ? taskCost : Math.max(old?.sdkCostUsd || 0, taskCost);
    next.models = mergeModelTokens(old?.models || [], task.modelTokenUsage);
    next.modelNames = [...new Set([...(old?.modelNames || []), ...(task.modelRuns || []).map(m => m.id)])];
    for (const key of ["inputTokens", "outputTokens", "jevInputTokens", "helperInputTokens", "helperOutputTokens"] as const) {
      next[key] = Math.max(next[key], old?.[key] || 0);
    }
    records.set(task.id, next);
  }
  return [...records.values()];
}

export function tokenTotals(records: TaskTokenRecord[], source: TokenSource = "all"): { input: number; output: number; total: number } {
  let input = 0, output = 0;
  for (const r of records) {
    if (source === "all" || source === "model") { input += count(r.inputTokens); output += count(r.outputTokens); }
    if (source === "all" || source === "jev") input += count(r.jevInputTokens);
    if (source === "all" || source === "helper") { input += count(r.helperInputTokens); output += count(r.helperOutputTokens); }
  }
  return { input, output, total: input + output };
}
