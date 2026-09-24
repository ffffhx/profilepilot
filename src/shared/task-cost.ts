import type { TaskCostRecord, TaskTokenRecord } from "./tasks";
import type { TokenSource } from "./task-token-usage";

// Official price snapshots, checked 2026-09-24. Freeze quotes on receipt; never reprice history.
// https://api-docs.deepseek.com/quick_start/pricing/
// https://platform.kimi.com/docs/pricing/chat
// https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
const PRICE_DATE = "2026-09-24";
const VALID_UNTIL = Date.parse("2026-10-24T00:00:00+08:00");
const holidays2026 = [["01-01", "01-03"], ["02-15", "02-23"], ["04-04", "04-06"], ["05-01", "05-05"], ["06-19", "06-21"], ["09-25", "09-27"], ["10-01", "10-07"]];
const validCount = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;

export function deepseekPeak(at: number): boolean {
  const utc = new Date(at), china = new Date(at + 8 * 3600000);
  const day = china.toISOString().slice(5, 10);
  const holiday = china.getUTCFullYear() === 2026 && holidays2026.some(([from, to]) => day >= from && day <= to);
  const hour = utc.getUTCHours();
  return !holiday && utc.getUTCDay() >= 1 && utc.getUTCDay() <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

export function usageCharge(id: string, source: TaskCostRecord["source"], model: string, baseUrl: string, started: number, at: number, usage: any): TaskCostRecord | undefined {
  if (!usage || !validCount(usage.input_tokens) || !validCount(usage.output_tokens)) return;
  const read = usage.cache_read_input_tokens ?? 0, write = usage.cache_creation_input_tokens ?? 0;
  if (!validCount(read) || !validCount(write)) return;
  const record: TaskCostRecord = { id, source, model, at: new Date(at).toISOString(), inputTokens: usage.input_tokens + read + write, outputTokens: usage.output_tokens };
  if (!Number.isFinite(started) || started > at || started < Date.parse(`${PRICE_DATE}T00:00:00+08:00`) || at >= VALID_UNTIL) return record;
  let host: string; try { host = new URL(baseUrl).hostname; } catch { return record; }
  const quote = (currency: "CNY" | "USD", min: number, max: number, basis: string) => {
    record.estimate = { currency, min: min / 1e6, max: max / 1e6, basis, priceDate: PRICE_DATE };
  };
  if (host === "api.deepseek.com") {
    const rates = ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(model) ? [0.003, 0.15, 0.6] : model === "deepseek-v4-pro" ? [0.022, 0.66, 1.98] : undefined;
    if (!rates) return record;
    // The SDK doesn't expose the exact server billing timestamp. Bound the whole query window.
    const periods = new Set<boolean>([deepseekPeak(started), deepseekPeak(at)]);
    if (at - started > 7 * 86400000) { periods.add(true); periods.add(false); }
    else for (let t = Math.ceil(started / 3600000) * 3600000; t <= at; t += 3600000) periods.add(deepseekPeak(t));
    const base = read * rates[0] + (usage.input_tokens + write) * rates[1] + usage.output_tokens * rates[2];
    const low = periods.has(false) ? 1 : 2, high = periods.has(true) ? 2 : 1;
    quote("USD", base * low, base * high, low !== high ? "跨峰谷时段，显示费用范围" : high === 2 ? "峰时估算 · UTC 01–04 / 06–10" : "谷时估算 · 含周末及中国节假日");
  }
  if (["api.moonshot.cn", "api.kimi.com"].includes(host)) {
    if (model === "kimi-k3") {
      const creation = usage.cache_creation;
      const known = validCount(creation?.ephemeral_5m_input_tokens) && validCount(creation?.ephemeral_1h_input_tokens) && creation.ephemeral_5m_input_tokens + creation.ephemeral_1h_input_tokens === write;
      const base = usage.input_tokens * 20 + read * 2 + usage.output_tokens * 100;
      const lowWrite = known ? creation.ephemeral_5m_input_tokens * 20 + creation.ephemeral_1h_input_tokens * 40 : write * 20;
      quote("CNY", base + lowWrite, base + (known ? lowWrite : write * 40), !known && write ? "缓存写入 TTL 未返回，按 5min–1h 显示范围" : "Kimi 国内站 · 按缓存类型估算");
    } else {
      const rates: Record<string, number[]> = { "kimi-k2.7-code": [1.3, 6.5, 27], "kimi-k2.7-code-highspeed": [2.6, 13, 54], "kimi-k2.6": [1.1, 6.5, 27] };
      const r = rates[model]; if (r) { const cost = read * r[0] + (usage.input_tokens + write) * r[1] + usage.output_tokens * r[2]; quote("CNY", cost, cost, "Kimi 国内站 · 按缓存类型估算"); }
    }
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
