import type { SitePlan, SiteResult } from "./catalog";

/** Visible-page fallback; never decodes hidden salary fonts or gated JD text. */
export function readBossDom(plan: SitePlan): SiteResult {
  const p = plan.params;
  const result: SiteResult = { version: 1, operation: plan.operation, status: "ok", source: { url: location.href, method: "dom", checkedAt: new Date().toISOString() },
    effective: p, items: [], pagination: { hasMore: null, next: null }, completeness: { scope: "visible-page-content", complete: true, reasons: [] } };
  const error = (code: string, message: string): SiteResult => ({ ...result, status: code === "ACCESS_BLOCKED" ? "blocked" : "error", error: { code, message }, completeness: { ...result.completeness, complete: false, reasons: [code] } });
  const partial = (message: string) => { result.status = "partial"; result.completeness.complete = false; result.completeness.reasons.push(message); };
  const text = (root: ParentNode, selector: string) => root.querySelector<HTMLElement>(selector)?.innerText?.trim() || null;
  if (location.hostname !== "www.zhipin.com" || location.protocol !== "https:") return error("ORIGIN_MISMATCH", "当前页面不属于 BOSS。");
  if (plan.access?.blockedOrigins?.includes(location.origin) || plan.access?.allowedOrigins?.length && !plan.access.allowedOrigins.includes(location.origin)) return error("ACCESS_BLOCKED", "此来源被任务的网站访问设置限制。");
  const current = new URL(location.href);
  if (plan.operation === "boss.search") {
    if (current.searchParams.get("query") !== p.query || current.searchParams.get("city") !== p.city || p.page !== 1) return error("RESULT_MISMATCH", "页面可见列表无法核实所请求的搜索词、城市或页码。");
    const cards = [...document.querySelectorAll(".job-card-box, .job-card-wrapper")];
    if (!cards.length) return error("NOT_READY", "尚未找到岗位卡片；请检查登录、验证或加载状态。");
    result.items = cards.slice(p.itemOffset, p.itemOffset + p.limit).map(c => {
      const a = c.querySelector<HTMLAnchorElement>('a.job-name, a[href*="/job_detail/"]'), url = a?.href;
      const tags = [...c.querySelectorAll<HTMLElement>(".tag-list li")].map(n => n.innerText.trim());
      return { id: url?.match(/\/job_detail\/([^/?]+)\.html/)?.[1], title: a?.innerText.trim(), salary: text(c, ".job-salary, .salary"),
        company: text(c, ".boss-name, .company-name"), location: text(c, ".company-location, .job-area"),
        experience: tags[0] || null, degree: tags[1] || null, url };
    });
    if (result.items.some(i => !i.id || !i.title)) return error("SCHEMA_CHANGED", "岗位卡片缺少标题或链接。");
    if (result.items.some(i => !i.salary)) partial("当前页面未显示部分岗位薪资，不能用于薪资条件核验。");
    const more = p.itemOffset + p.limit < cards.length;
    result.pagination = { hasMore: more ? true : null, next: more ? { ...p, itemOffset: p.itemOffset + p.limit } : null };
    if (document.body.innerText.includes("登录账号，查看更多")) partial("未登录页面只显示有限岗位；完整列表需登录。");
  } else {
    if (!current.pathname.includes(p.id)) return error("RESULT_MISMATCH", "当前详情链接与岗位 ID 不一致。");
    const description = text(document, ".job-sec-text, .job-detail-body .job-sec .text, .job-detail .job-sec-text");
    const title = text(document, ".job-banner h1, .job-detail-header h1, .job-detail-info h1, .job-name");
    if (!description || !title) return error("NOT_READY", "尚未取得可见 JD；请检查登录或页面加载。");
    result.items = [{ id: p.id, title, description, salary: text(document, ".job-banner .salary, .job-detail-header .salary"),
      company: text(document, ".company-info a, .job-company .name"), url: location.href }];
    if (/登录查看完整|登录后查看|立即登录/.test(document.body.innerText)) partial("页面存在登录限制，当前 JD 可能不完整。");
  }
  return result;
}
