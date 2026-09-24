import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import type { TaskSettings } from "../../shared/tasks";

export const DEEPSEEK_PRICE_VERSION = "deepseek-2026-09-24";
export const HOST_PRICING_ENV = { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1" };
// USD / million tokens. Verified: https://api-docs.deepseek.com/quick_start/pricing/
// Refresh this table when the provider changes rates. These are estimates, not invoices.
const rates = {
  flash: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0.15 },
  pro: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0.66 }
};
// 2026 official holiday calendar (China, UTC+8):
// https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html
const holidays2026 = [["01-01", "01-03"], ["02-15", "02-23"], ["04-04", "04-06"], ["05-01", "05-05"], ["06-19", "06-21"], ["09-25", "09-27"], ["10-01", "10-07"]];
export function deepseekPeak(at: Date): boolean {
  const chinaDate = new Date(at.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  if (chinaDate.startsWith("2026-") && holidays2026.some(([start, end]) => chinaDate.slice(5) >= start && chinaDate.slice(5) <= end)) return false;
  const weekday = at.getUTCDay(), hour = at.getUTCHours();
  return weekday >= 1 && weekday <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}
export function deepseekModel(model: string): "flash" | "pro" | undefined {
  if (["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(model.toLowerCase())) return "flash";
  if (model.toLowerCase() === "deepseek-v4-pro") return "pro";
}
export function isDirectDeepseek(baseUrl: string): boolean {
  try { const url = new URL(baseUrl); return url.protocol === "https:" && url.hostname === "api.deepseek.com" && !url.port && !url.username && !url.password; } catch { return false; }
}
export function deepseekRates(model: string, at = new Date()): typeof rates.flash | undefined {
  const kind = deepseekModel(model); if (!kind) return;
  const multiplier = deepseekPeak(at) ? 2 : 1;
  return Object.fromEntries(Object.entries(rates[kind]).map(([key, value]) => [key, value * multiplier])) as typeof rates.flash;
}
export function providerPricing(settings: Pick<TaskSettings, "baseUrl" | "model">, at = new Date()): Settings | undefined {
  if (!isDirectDeepseek(settings.baseUrl)) return;
  const rate = deepseekRates(settings.model, at); if (!rate) return;
  // Pair with CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST in the worker environment.
  // Without that host declaration the SDK silently drops this price table.
  // These rates are fixed for this query; final provider bills can differ when
  // a query spans peak/off-peak pricing. No permission settings change.
  return { modelPricing: { overrides: { [settings.model]: rate } } };
}
export interface PriceTokens { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; }
export function priceDeepseek(model: string, tokens: PriceTokens, at: Date): number | undefined {
  const rate = deepseekRates(model, at); if (!rate) return;
  if (Object.values(tokens).some(value => !Number.isSafeInteger(value) || value < 0)) return;
  return (tokens.inputTokens * rate.input + tokens.outputTokens * rate.output + tokens.cacheReadInputTokens * rate.cacheRead + tokens.cacheCreationInputTokens * rate.cacheWrite) / 1e6;
}
