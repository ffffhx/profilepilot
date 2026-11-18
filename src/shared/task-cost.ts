import type { TaskCostRecord, TaskTokenRecord } from "./tasks";
import type { TokenSource } from "./task-token-usage";

// Official price snapshots, refreshed 2026-11-17. Freeze quotes on receipt; never reprice history.
// https://api-docs.deepseek.com/quick_start/pricing/
// https://platform.kimi.com/docs/pricing/chat
// https://docs.anthropic.com/en/docs/about-claude/pricing
// https://openai.com/api/pricing/
// https://ai.google.dev/pricing
const LEGACY_PRICE_DATE = "2026-09-24";
const LEGACY_START = Date.parse("2026-09-24T00:00:00+08:00");
const LEGACY_UNTIL = Date.parse("2026-10-24T00:00:00+08:00");
export const CURRENT_PRICE_DATE = "2026-11-17";
const CURRENT_START = Date.parse("2026-11-02T00:00:00+08:00");

const holidays2026 = [["01-01", "01-03"], ["02-15", "02-23"], ["04-04", "04-06"], ["05-01", "05-05"], ["06-19", "06-21"], ["09-25", "09-27"], ["10-01", "10-07"]];
const validCount = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;

export interface CustomModelPricing {
  customInputUsdPerMillion?: number;
  customOutputUsdPerMillion?: number;
}

function resolveSnapshotDate(started: number, at: number): string | undefined {
  if (!Number.isFinite(started) || !Number.isFinite(at) || started > at) return undefined;
  if (started >= LEGACY_START && at < LEGACY_UNTIL) return LEGACY_PRICE_DATE;
  if (started >= CURRENT_START) return CURRENT_PRICE_DATE;
  return undefined;
}

export function deepseekPeak(at: number): boolean {
  const utc = new Date(at), china = new Date(at + 8 * 3600000);
  const day = china.toISOString().slice(5, 10);
  const holiday = china.getUTCFullYear() === 2026 && holidays2026.some(([from, to]) => day >= from && day <= to);
  const hour = utc.getUTCHours();
  return !holiday && utc.getUTCDay() >= 1 && utc.getUTCDay() <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

function claudeRates(model: string): [number, number, number, number] | undefined {
  if (/^claude-(?:4[-.]5-sonnet|sonnet-4(?:[-.](?:5|6))?)(?:-\d{8})?$/.test(model)) return [0.3, 3, 3.75, 15];
  if (/^claude-(?:4[-.]5-opus|opus-4[-.](?:5|6))(?:-\d{8})?$/.test(model)) return [0.5, 5, 6.25, 25];
  if (/^claude-opus-4(?:[-.]1)?(?:-\d{8})?$/.test(model)) return [1.5, 15, 18.75, 75];
  if (/^claude-(?:4[-.]5-haiku|haiku-4[-.]5)(?:-\d{8})?$/.test(model)) return [0.1, 1, 1.25, 5];
  return undefined;
}

function openaiRates(model: string): [number, number, number, number] | undefined {
  if (/^gpt-4o-mini(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return [0.075, 0.15, 0.15, 0.6];
  if (/^gpt-4o(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return [1.25, 2.5, 2.5, 10];
  if (/^gpt-4\.1-nano(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return [0.025, 0.1, 0.1, 0.4];
  if (/^gpt-4\.1-mini(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return [0.1, 0.4, 0.4, 1.6];
  if (/^gpt-4\.1(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return [0.5, 2, 2, 8];
  if (/^o[34]-mini(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return [0.275, 1.1, 1.1, 4.4];
  if (/^o3(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return [0.5, 2, 2, 8];
  return undefined;
}

function geminiRates(model: string): [number, number, number, number] | undefined {
  if (/^gemini-2\.5-pro(?:-[\w.-]+)?$/.test(model)) return [0.3125, 1.25, 1.25, 10];
  if (/^gemini-2\.5-flash(?:-[\w.-]+)?$/.test(model)) return [0.075, 0.3, 0.3, 2.5];
  return undefined;
}

export function usageCharge(
  id: string,
  source: TaskCostRecord["source"],
  model: string,
  baseUrl: string,
  started: number,
  at: number,
  usage: any,
  customPricing?: CustomModelPricing
): TaskCostRecord | undefined {
  if (!usage || !validCount(usage.input_tokens) || !validCount(usage.output_tokens)) return;
  const read = usage.cache_read_input_tokens ?? 0, write = usage.cache_creation_input_tokens ?? 0;
  if (!validCount(read) || !validCount(write)) return;
  const record: TaskCostRecord = { id, source, model, at: new Date(at).toISOString(), inputTokens: usage.input_tokens + read + write, outputTokens: usage.output_tokens };
  if (!Number.isFinite(started) || !Number.isFinite(at) || started > at) return record;
  if (customPricing && Number.isFinite(customPricing.customInputUsdPerMillion) && customPricing.customInputUsdPerMillion! >= 0
    && Number.isFinite(customPricing.customOutputUsdPerMillion) && customPricing.customOutputUsdPerMillion! >= 0) {
    const cost = record.inputTokens * customPricing.customInputUsdPerMillion! + record.outputTokens * customPricing.customOutputUsdPerMillion!;
    record.estimate = { currency: "USD", min: cost / 1e6, max: cost / 1e6, basis: "用户自定义费率估算", priceDate: resolveSnapshotDate(started, at) || CURRENT_PRICE_DATE };
    return record;
  }
  const priceDate = resolveSnapshotDate(started, at);
  if (!priceDate) return record;
  let host: string; try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { return record; }
  const cleanModel = model.trim().toLowerCase().replace(/\[1m\]$/, "");
  const quote = (currency: "CNY" | "USD", min: number, max: number, basis: string) => {
    record.estimate = { currency, min: min / 1e6, max: max / 1e6, basis, priceDate };
  };
  if (host === "api.deepseek.com") {
    const peakRates = ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(cleanModel)
      ? [0.003, 0.15, 0.6]
      : cleanModel === "deepseek-v4-pro" ? [0.022, 0.66, 1.98] : undefined;
    if (peakRates) {
      // The SDK doesn't expose the exact server billing timestamp. Bound the whole query window.
      const periods = new Set<boolean>([deepseekPeak(started), deepseekPeak(at)]);
      if (at - started > 7 * 86400000) { periods.add(true); periods.add(false); }
      else for (let t = Math.ceil(started / 3600000) * 3600000; t <= at; t += 3600000) periods.add(deepseekPeak(t));
      const base = read * peakRates[0] + (usage.input_tokens + write) * peakRates[1] + usage.output_tokens * peakRates[2];
      const low = periods.has(false) ? 1 : 2, high = periods.has(true) ? 2 : 1;
      quote("USD", base * low, base * high, low !== high ? "跨峰谷时段，显示费用范围" : high === 2 ? "峰时估算 · UTC 01–04 / 06–10" : "谷时估算 · 含周末及中国节假日");
      return record;
    }
    const flatRates = cleanModel === "deepseek-chat" || cleanModel.startsWith("deepseek-chat-") || cleanModel === "deepseek-v3"
      ? [0.028, 0.28, 0.42]
      : cleanModel === "deepseek-reasoner" || cleanModel.startsWith("deepseek-reasoner-") || cleanModel === "deepseek-r1"
        ? [0.14, 0.55, 2.19] : undefined;
    if (flatRates) {
      const cost = read * flatRates[0] + (usage.input_tokens + write) * flatRates[1] + usage.output_tokens * flatRates[2];
      quote("USD", cost, cost, "DeepSeek 官方公布单价 · 按缓存命中估算");
      return record;
    }
  }
  if (["api.moonshot.cn", "api.kimi.com"].includes(host)) {
    if (cleanModel === "kimi-k3") {
      const creation = usage.cache_creation;
      const known = validCount(creation?.ephemeral_5m_input_tokens) && validCount(creation?.ephemeral_1h_input_tokens) && creation.ephemeral_5m_input_tokens + creation.ephemeral_1h_input_tokens === write;
      const base = usage.input_tokens * 20 + read * 2 + usage.output_tokens * 100;
      const lowWrite = known ? creation.ephemeral_5m_input_tokens * 20 + creation.ephemeral_1h_input_tokens * 40 : write * 20;
      quote("CNY", base + lowWrite, base + (known ? lowWrite : write * 40), !known && write ? "缓存写入 TTL 未返回，按 5min–1h 显示范围" : "Kimi 国内站 · 按缓存类型估算");
    } else {
      const rates: Record<string, number[]> = { "kimi-k2.7-code": [1.3, 6.5, 27], "kimi-k2.7-code-highspeed": [2.6, 13, 54], "kimi-k2.6": [1.1, 6.5, 27], "kimi-k2.5": [1.0, 4.0, 16], "kimi-k2-thinking": [1.0, 4.0, 16] };
      const r = rates[cleanModel]; if (r) { const cost = read * r[0] + (usage.input_tokens + write) * r[1] + usage.output_tokens * r[2]; quote("CNY", cost, cost, "Kimi 国内站 · 按缓存类型估算"); }
    }
    return record;
  }
  if (host === "api.anthropic.com") {
    const r = claudeRates(cleanModel);
    if (r) {
      const cost = read * r[0] + usage.input_tokens * r[1] + write * r[2] + usage.output_tokens * r[3];
      quote("USD", cost, cost, "Anthropic 官方公布单价 · 按缓存命中估算");
    }
    return record;
  }
  if (host === "api.openai.com") {
    const r = openaiRates(cleanModel);
    if (r) {
      const cost = read * r[0] + usage.input_tokens * r[1] + write * r[2] + usage.output_tokens * r[3];
      quote("USD", cost, cost, "OpenAI 官方公布单价 · 按缓存命中估算");
    }
    return record;
  }
  if (["generativelanguage.googleapis.com", "aiplatform.googleapis.com"].includes(host)) {
    const r = geminiRates(cleanModel);
    if (r) {
      const cost = read * r[0] + usage.input_tokens * r[1] + write * r[2] + usage.output_tokens * r[3];
      quote("USD", cost, cost, "Google Gemini 官方公布单价 · 按缓存命中估算");
    }
    return record;
  }
  return record;
}

export function mergeCostRecords(old: TaskCostRecord[], incoming: TaskCostRecord[]): TaskCostRecord[] {
  const records = new Map(old.map(r => [r.id, r]));
  for (const r of incoming) {
    const prior = records.get(r.id);
    // Replayed responses must not be re-priced at a later receive time or new tariff.
    if (prior && prior.inputTokens === r.inputTokens && prior.outputTokens === r.outputTokens) continue;
    if (!prior || (r.inputTokens >= prior.inputTokens && r.outputTokens >= prior.outputTokens)) records.set(r.id, r);
  }
  return [...records.values()];
}

export function costTotals(records: TaskTokenRecord[], source: TokenSource, model?: string) {
  const sums = new Map<string, { currency: string; min: number; max: number }>();
  let coveredTokens = 0, calls = 0;
  for (const r of records) for (const c of r.costRecords || []) {
    if ((source !== "all" && source !== c.source) || (model && c.model !== model) || !c.estimate) continue;
    const q = c.estimate, sum = sums.get(q.currency) || { currency: q.currency, min: 0, max: 0 };
    sum.min += q.min; sum.max += q.max; sums.set(q.currency, sum); coveredTokens += c.inputTokens + c.outputTokens; calls++;
  }
  return { amounts: [...sums.values()], coveredTokens, calls };
}
