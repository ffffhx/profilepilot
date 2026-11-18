import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import type { TaskSettings } from "../../shared/tasks";

export const DEEPSEEK_PRICE_VERSION = "deepseek-2026-09-24";
export const KIMI_PRICE_VERSION = "kimi-2026-11-17";
export const CUSTOM_PRICE_VERSION = "custom-2026-11-17";
export const HOST_PRICING_ENV = { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1" };

// USD / million tokens. Verified: https://api-docs.deepseek.com/quick_start/pricing/
// Refresh this table when the provider changes rates. These are estimates, not invoices.
const rates = {
  flash: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0.15 },
  pro: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0.66 },
  chat: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0.28 },
  reasoner: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 }
};

// CNY / million tokens converted to USD budget-guard rates at 7.2 CNY/USD so
// maxBudgetUsd enforcement protects Kimi runs accurately.
const CNY_PER_USD = 7.2;
const kimiDomesticCnyRates: Record<string, typeof rates.flash> = {
  "kimi-k3": { input: 20, output: 100, cacheRead: 2, cacheWrite: 30 },
  "kimi-k2.7-code": { input: 6.5, output: 27, cacheRead: 1.3, cacheWrite: 6.5 },
  "kimi-k2.7-code-highspeed": { input: 13, output: 54, cacheRead: 2.6, cacheWrite: 13 },
  "kimi-k2.6": { input: 6.5, output: 27, cacheRead: 1.1, cacheWrite: 6.5 },
  "kimi-k2.5": { input: 4, output: 16, cacheRead: 1, cacheWrite: 4 },
  "kimi-k2-thinking": { input: 4, output: 16, cacheRead: 1, cacheWrite: 4 }
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

export function deepseekModel(model: string): "flash" | "pro" | "chat" | "reasoner" | undefined {
  const clean = model.trim().toLowerCase();
  if (["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(clean)) return "flash";
  if (clean === "deepseek-v4-pro") return "pro";
  if (clean === "deepseek-chat" || clean.startsWith("deepseek-chat-") || clean === "deepseek-v3") return "chat";
  if (clean === "deepseek-reasoner" || clean.startsWith("deepseek-reasoner-") || clean === "deepseek-r1") return "reasoner";
}

export function isDirectDeepseek(baseUrl: string): boolean {
  try { const url = new URL(baseUrl); return url.protocol === "https:" && url.hostname === "api.deepseek.com" && !url.port && !url.username && !url.password; } catch { return false; }
}

export function isDirectKimi(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && ["api.moonshot.cn", "api.kimi.com"].includes(url.hostname) && !url.port && !url.username && !url.password;
  } catch { return false; }
}

export function deepseekRates(model: string, at = new Date()): typeof rates.flash | undefined {
  const kind = deepseekModel(model); if (!kind) return;
  const multiplier = (kind === "flash" || kind === "pro") && deepseekPeak(at) ? 2 : 1;
  return Object.fromEntries(Object.entries(rates[kind]).map(([key, value]) => [key, Number((value * multiplier).toFixed(6))])) as typeof rates.flash;
}

export function kimiUsdRates(model: string): typeof rates.flash | undefined {
  const clean = model.trim().toLowerCase().replace(/\[1m\]$/, "");
  const cny = kimiDomesticCnyRates[clean];
  if (!cny) return undefined;
  return Object.fromEntries(Object.entries(cny).map(([key, value]) => [key, Number((value / CNY_PER_USD).toFixed(6))])) as typeof rates.flash;
}

type PricedSettings = Pick<TaskSettings, "baseUrl" | "model"> & Partial<Pick<TaskSettings, "customInputUsdPerMillion" | "customOutputUsdPerMillion">>;

function hasCustomRates(settings: PricedSettings): boolean {
  return Number.isFinite(settings.customInputUsdPerMillion) && settings.customInputUsdPerMillion! >= 0
    && Number.isFinite(settings.customOutputUsdPerMillion) && settings.customOutputUsdPerMillion! >= 0;
}

export function managedPriceVersion(settings: PricedSettings): string | undefined {
  if (hasCustomRates(settings)) return CUSTOM_PRICE_VERSION;
  if (isDirectDeepseek(settings.baseUrl) && deepseekModel(settings.model)) return DEEPSEEK_PRICE_VERSION;
  if (isDirectKimi(settings.baseUrl) && kimiUsdRates(settings.model)) return KIMI_PRICE_VERSION;
  return undefined;
}

export function providerPricing(settings: PricedSettings, at = new Date()): Settings | undefined {
  try { new URL(settings.baseUrl); } catch { return undefined; }
  if (hasCustomRates(settings)) {
    const input = settings.customInputUsdPerMillion!, output = settings.customOutputUsdPerMillion!;
    return { modelPricing: { overrides: { [settings.model]: { input, output, cacheRead: input, cacheWrite: input } } } };
  }
  if (isDirectDeepseek(settings.baseUrl)) {
    const rate = deepseekRates(settings.model, at);
    if (!rate) return;
    // Pair with CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST in the worker environment.
    // Without that host declaration the SDK silently drops this price table.
    return { modelPricing: { overrides: { [settings.model]: rate } } };
  }
  if (isDirectKimi(settings.baseUrl)) {
    const rate = kimiUsdRates(settings.model);
    if (!rate) return;
    return { modelPricing: { overrides: { [settings.model]: rate } } };
  }
}

export interface PriceTokens { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; }
export function priceDeepseek(model: string, tokens: PriceTokens, at: Date): number | undefined {
  const rate = deepseekRates(model, at); if (!rate) return;
  if (Object.values(tokens).some(value => !Number.isSafeInteger(value) || value < 0)) return;
  return (tokens.inputTokens * rate.input + tokens.outputTokens * rate.output + tokens.cacheReadInputTokens * rate.cacheRead + tokens.cacheCreationInputTokens * rate.cacheWrite) / 1e6;
}
