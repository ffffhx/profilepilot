import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { BrowserTask } from "../../shared/tasks";
import { DEEPSEEK_PRICE_VERSION, deepseekModel, isDirectDeepseek, priceDeepseek, type PriceTokens } from "./pricing";

export interface CostBaseline { taskUsd: number; sdkUsd: number; sessionId?: string; }
export function costBaseline(task: BrowserTask): CostBaseline {
  return { taskUsd: task.usage.costUsd, sdkUsd: task.sdkSessionId ? task.costAccounting?.sdkUsd ?? task.usage.costUsd : 0, sessionId: task.sdkSessionId };
}
export function applyPricedCost(task: BrowserTask, baseline: CostBaseline, sdkUsd: number, priceVersion?: string): void {
  if (!Number.isFinite(sdkUsd) || sdkUsd < 0) return;
  if (!priceVersion && !task.costAccounting) { task.usage.costUsd = Math.max(task.usage.costUsd, sdkUsd); return; }
  // Startup-error results carry zero. They must not erase the resume baseline.
  if (sdkUsd === 0 && baseline.sdkUsd > 0) return;
  const previous = baseline.sessionId === task.sdkSessionId ? baseline.sdkUsd : 0;
  const delta = sdkUsd >= previous ? sdkUsd - previous : sdkUsd; // SDK /clear can reset counters.
  task.usage.costUsd = Math.max(task.usage.costUsd, Number((baseline.taskUsd + delta).toFixed(12)));
  task.costAccounting = { ...task.costAccounting, version: priceVersion || task.costAccounting!.version, sessionId: task.sdkSessionId!, sdkUsd };
}

type CostRow = { at: string; totalCostUSD: number; hasUnknownModelCost: boolean; modelUsage: Record<string, PriceTokens> };
export interface LegacyCostCorrection { costUsd: number; cacheReadInputTokens: number; accounting: NonNullable<BrowserTask["costAccounting"]>; }
export function legacyCostCorrection(root: string, task: BrowserTask): LegacyCostCorrection | undefined {
  if (task.costAccounting || !task.sdkSessionId || !/^[\w-]+$/.test(task.id) || !/^[\w-]+$/.test(task.sdkSessionId)) return;
  // An alias at a gateway can have different rates. Never infer its provider
  // from the model name or today's application settings.
  if (!task.modelRuns?.length || task.modelRuns.some(run => !isDirectDeepseek(run.endpoint) || !deepseekModel(run.id))) return;
  const projects = path.join(root, "sessions", task.id, "projects");
  const rows: CostRow[] = [];
  let at: string | undefined;
  try {
    if (!existsSync(projects)) return;
    const files = readdirSync(projects, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(projects, entry.name, `${task.sdkSessionId}.jsonl`)).filter(file => existsSync(file));
    if (files.length !== 1 || statSync(files[0]).size > 64 * 1024 * 1024) return;
    for (const line of readFileSync(files[0], "utf8").split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (typeof record.timestamp === "string" && Number.isFinite(Date.parse(record.timestamp))) at = record.timestamp;
      if (record.type === "cost-state" && record.sessionId === task.sdkSessionId && at) rows.push({ ...record, at });
    }
  } catch { return; } // Missing, unreadable and partial transcripts stay untouched.
  const last = rows.at(-1);
  if (!last?.hasUnknownModelCost || !Number.isFinite(last.totalCostUSD) || !last.modelUsage) return;
  if (Math.abs(last.totalCostUSD - task.usage.costUsd) > 0.000001) return;
  let costUsd = 0, input = 0, output = 0, cacheReadInputTokens = 0;
  const previous = new Map<string, PriceTokens>();
  for (const row of rows) {
    // Restrict automatic historical repair to the period we actually audited.
    if (row.at < "2026-09-23" || !row.modelUsage) return;
    for (const [model, usage] of Object.entries(row.modelUsage)) {
      if (!deepseekModel(model)) return;
      const old = previous.get(model);
      const delta = {} as PriceTokens;
      for (const key of ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"] as const) {
        if (!Number.isSafeInteger(usage[key]) || usage[key] < (old?.[key] || 0)) return;
        delta[key] = usage[key] - (old?.[key] || 0);
      }
      const priced = priceDeepseek(model, delta, new Date(row.at)); if (priced === undefined) return;
      costUsd += priced; input += delta.inputTokens + delta.cacheReadInputTokens + delta.cacheCreationInputTokens;
      output += delta.outputTokens; cacheReadInputTokens += delta.cacheReadInputTokens; previous.set(model, usage);
    }
  }
  if (input !== task.usage.inputTokens || output !== task.usage.outputTokens || costUsd >= task.usage.costUsd) return;
  return { costUsd: Number(costUsd.toFixed(12)), cacheReadInputTokens,
    accounting: { version: DEEPSEEK_PRICE_VERSION, sessionId: task.sdkSessionId, sdkUsd: last.totalCostUSD, originalUsd: task.usage.costUsd, correctedAt: new Date().toISOString() } };
}
