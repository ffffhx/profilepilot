import { planSiteAdapter, type SiteInput, type SiteResult } from "./catalog";
import { readSitePage } from "./page";
import { prepareSitePage } from "./prepare-page";
import { readBossDom } from "./boss-dom";
import { prepareXiaohongshuSearch } from "./xiaohongshu-page";

export interface SiteTransport {
  evaluate(expression: string): Promise<any>;
  open(url: string): Promise<unknown>;
  /** Called before every transport step, including after navigation. */
  check?(url: string): void;
  access?: SitePlanAccess;
}
type SitePlanAccess = { allowedOrigins?: string[]; blockedOrigins?: string[] };
export async function runSiteAdapter(input: SiteInput, transport: SiteTransport): Promise<SiteResult> {
  const plan = planSiteAdapter(input), start = Date.now(); let calls = 0;
  plan.access = transport.access;
  const evaluate = async (expression: string) => { transport.check?.(plan.url); calls++; return transport.evaluate(expression); };
  transport.check?.(plan.url);
  if (plan.operation.startsWith("bilibili.")) transport.check?.("https://api.bilibili.com/");
  const current = await evaluate("({url:location.href,ready:document.readyState})");
  let same = false;
  try { same = plan.reuseOrigin ? new URL(current.url).origin === new URL(plan.url).origin : current.url === plan.url; } catch { /* navigate once */ }
  try {
    const currentUrl = new URL(current.url), targetUrl = new URL(plan.url);
    if (currentUrl.origin === targetUrl.origin && currentUrl.pathname === targetUrl.pathname) {
      if (plan.operation.startsWith("youtube.") && plan.params.id) same = currentUrl.searchParams.get("v") === plan.params.id;
      if (plan.operation.startsWith("xiaohongshu.") && plan.params.url) same = currentUrl.searchParams.get("xsec_token") === targetUrl.searchParams.get("xsec_token");
      if (plan.operation === "xiaohongshu.search") same = currentUrl.searchParams.get("keyword") === plan.params.query;
    }
  } catch { /* navigate once */ }
  if (!same && plan.operation === "xiaohongshu.search" && URL.canParse(current.url) && new URL(current.url).origin === "https://www.xiaohongshu.com") {
    const prepared = await evaluate(`(${prepareXiaohongshuSearch.toString()})(${JSON.stringify(plan)},"route")`);
    same = prepared.state === "performed" || prepared.state === "ready";
  }
  if (!same) { transport.check?.(plan.url); calls++; await transport.open(plan.url); }
  const deadline = Date.now() + (plan.operation === "youtube.transcript" ? 30000 : 12000);
  let ready = false;
  while (Date.now() < deadline) {
    const state = await evaluate("({url:location.href,ready:document.readyState})");
    if (state.url !== "about:blank" && state.ready !== "loading") { transport.check?.(state.url); ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error("网站导航尚未完成，请检查当前页面；不会重复导航。");
  if (plan.operation === "xiaohongshu.search") {
    let waiting = false;
    do {
      const prepared = await evaluate(`(${prepareXiaohongshuSearch.toString()})(${JSON.stringify(plan)},"sort")`);
      waiting = prepared.state === "waiting";
      if (prepared.state !== "waiting") break;
      await new Promise(resolve => setTimeout(resolve, 150));
    } while (Date.now() < deadline);
    if (waiting) throw new Error("小红书搜索或筛选尚未完成，未返回旧的候选列表。请检查当前页面。");
  }
  if (plan.operation === "youtube.transcript") {
    for (const stage of ["expand", "transcript"] as const) {
      const controlDeadline = Math.min(deadline, Date.now() + 4000);
      do {
        const prepared = await evaluate(`(${prepareSitePage.toString()})(${JSON.stringify(plan)},${JSON.stringify(stage)})`);
        if (prepared.performed || prepared.reason !== "control-unavailable") break;
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < controlDeadline);
    }
  }
  // Repeated evaluation is limited to a not-yet-loaded page state. Fetch errors,
  // permission failures and unknown transport outcomes are never auto-replayed.
  let bossFallback = plan.operation === "boss.detail" && !plan.params.securityId;
  let expression = `(${(bossFallback ? readBossDom : readSitePage).toString()})(${JSON.stringify(plan)})`;
  let result: SiteResult;
  do {
    result = await evaluate(expression);
    if (!result || result.version !== 1 || result.operation !== plan.operation || !Array.isArray(result.items)) throw new Error("网站适配器没有返回有效结果。");
    if (!bossFallback && plan.operation.startsWith("boss.") && ["ACCESS_BLOCKED", "SCHEMA_CHANGED"].includes(result.error?.code || "")) {
      bossFallback = true;
      expression = `(${readBossDom.toString()})(${JSON.stringify(plan)})`;
      continue;
    }
    if (result.error?.code !== "NOT_READY" || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (true);
  transport.check?.(plan.url);
  result.metrics = { durationMs: Date.now() - start, browserCalls: calls, outputBytes: Buffer.byteLength(JSON.stringify(result)) };
  return result;
}

export function siteEvaluationValue(response: any): any {
  if (response?.exceptionDetails) throw new Error(`网站脚本执行失败：${response.exceptionDetails.exception?.description || response.exceptionDetails.text || "unknown"}`);
  return response?.result?.value;
}
