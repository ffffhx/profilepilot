import { z } from "zod";

const query = z.string().trim().min(1).max(200);
const page = z.number().int().min(1).max(100).default(1);
const limit = z.number().int().min(1).max(50).default(20);
const id = z.string().regex(/^[\w-]{1,100}$/);
const cursor = z.string().max(300).optional();
const itemOffset = z.number().int().min(0).max(5000).default(0);
const url = z.string().url().max(2000);
const definitions = {
  "boss.search": { batch: 1, title: "BOSS 岗位搜索", schema: z.object({ query, city: z.string().regex(/^\d{9}$/), page, limit: limit.transform(n => Math.min(n, 30)), itemOffset }) },
  "boss.detail": { batch: 1, title: "BOSS 岗位 JD", schema: z.object({ id, securityId: z.string().min(1).max(1000).optional() }) },
  "bilibili.search": { batch: 1, title: "Bilibili 视频搜索", schema: z.object({ query, page, limit, sort: z.enum(["totalrank", "click", "pubdate", "dm", "stow"]).default("totalrank") }) },
  "bilibili.detail": { batch: 1, title: "Bilibili 视频详情", schema: z.object({ id: z.string().regex(/^BV[\w]{10}$/) }) },
  "bilibili.comments": { batch: 1, title: "Bilibili 视频评论", schema: z.object({ id: z.string().regex(/^BV[\w]{10}$/), page, limit: limit.transform(n => Math.min(n, 20)), sort: z.enum(["new", "hot"]).default("hot") }) },
  "zhihu.search": { batch: 1, title: "知乎搜索", schema: z.object({ query, offset: z.number().int().min(0).max(5000).default(0), limit }) },
  "zhihu.hot": { batch: 1, title: "知乎热榜", schema: z.object({ limit, itemOffset }) },
  "smzdm.search": { batch: 2, title: "什么值得买优惠搜索", schema: z.object({ query, page, limit, itemOffset }) },
  "reddit.search": { batch: 2, title: "Reddit 帖子搜索", schema: z.object({ query, subreddit: z.string().regex(/^[\w]{1,50}$/).optional(), sort: z.enum(["relevance", "hot", "top", "new", "comments"]).default("relevance"), time: z.enum(["all", "year", "month", "week", "day", "hour"]).default("all"), cursor, limit }) },
  "reddit.thread": { batch: 2, title: "Reddit 帖子与评论树", schema: z.object({ id: z.string().regex(/^[a-z0-9]{3,20}$/), limit, depth: z.number().int().min(1).max(8).default(4) }) },
  "xiaohongshu.search": { batch: 2, title: "小红书笔记搜索", schema: z.object({ query, limit, itemOffset, sort: z.enum(["general", "latest", "likes", "comments", "collects"]).default("general") }) },
  "xiaohongshu.detail": { batch: 2, title: "小红书笔记详情", schema: z.object({ url }) },
  "xiaohongshu.comments": { batch: 2, title: "小红书已加载评论", schema: z.object({ url, limit, itemOffset }) },
  "wechat.search": { batch: 3, title: "搜狗微信公众号文章搜索", schema: z.object({ query, page, limit, itemOffset }) },
  "wechat.article": { batch: 3, title: "微信公众号文章正文（支持搜狗跳转链接）", schema: z.object({ url, offset: z.number().int().min(0).max(1000000).default(0), textLimit: z.number().int().min(100).max(30000).default(12000) }) },
  "youtube.search": { batch: 3, title: "YouTube 视频搜索", schema: z.object({ query, limit, itemOffset }) },
  "youtube.detail": { batch: 3, title: "YouTube 视频详情", schema: z.object({ id: z.string().regex(/^[\w-]{11}$/) }) },
  "youtube.transcript": { batch: 3, title: "YouTube 已有字幕", schema: z.object({ id: z.string().regex(/^[\w-]{11}$/), language: z.string().regex(/^[\w-]{2,20}$/).optional(), offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(500).default(100) }) }
} as const;

export type SiteOperation = keyof typeof definitions;
export interface SiteInput { operation: string; params?: Record<string, unknown>; }
export interface SitePlan { operation: SiteOperation; params: Record<string, any>; url: string; hosts: string[]; reuseOrigin: boolean;
  access?: { allowedOrigins?: string[]; blockedOrigins?: string[] }; }
export interface SiteResult {
  version: 1; operation: SiteOperation; status: "ok" | "empty" | "partial" | "blocked" | "error";
  source: { url: string; method: "browser-fetch" | "page-state" | "dom"; checkedAt: string };
  effective: Record<string, unknown>; items: Record<string, any>[];
  pagination: { next: Record<string, unknown> | null; hasMore: boolean | null };
  completeness: { scope: string; complete: boolean; reasons: string[] };
  error?: { code: string; message: string };
  metrics?: { durationMs: number; browserCalls: number; outputBytes: number };
}
export function listSiteAdapters(site?: string) {
  if (site !== undefined && !Object.keys(definitions).some(operation => operation === site || operation.startsWith(site + "."))) throw new Error("未知网站；使用 sites 查看全部操作。");
  return Object.entries(definitions).filter(([operation]) => !site || operation === site || operation.startsWith(site + ".")).map(([operation, d]) => ({ operation, title: d.title, batch: d.batch,
    readOnly: true, input: z.toJSONSchema(d.schema, { io: "input" }),
    validation: "experimental; consult live verification report for tested availability" }));
}
export function planSiteAdapter(input: SiteInput): SitePlan {
  if (!Object.hasOwn(definitions, input?.operation)) throw new Error("未知网站操作；先用 sites 列出适配能力。");
  const operation = input.operation as SiteOperation;
  const params = definitions[operation].schema.strict().parse(input.params ?? {}) as Record<string, any>;
  const site = operation.split(".")[0], q = encodeURIComponent(params.query || "");
  let target = "", reuseOrigin = true;
  const hosts: Record<string, string[]> = {
    boss: ["www.zhipin.com"], bilibili: ["www.bilibili.com", "search.bilibili.com"], zhihu: ["www.zhihu.com"],
    smzdm: ["search.smzdm.com"], reddit: ["www.reddit.com"], xiaohongshu: ["www.xiaohongshu.com"],
    wechat: ["weixin.sogou.com", "mp.weixin.qq.com"], youtube: ["www.youtube.com"]
  };
  if (site === "boss") { target = operation === "boss.detail" ? `https://www.zhipin.com/job_detail/${params.id}.html` : `https://www.zhipin.com/web/geek/jobs?query=${q}&city=${params.city}&page=${params.page}`; reuseOrigin = operation === "boss.detail" && Boolean(params.securityId); }
  if (site === "bilibili") target = "https://www.bilibili.com/";
  if (site === "zhihu") target = "https://www.zhihu.com/hot";
  if (site === "smzdm") target = `https://search.smzdm.com/?c=youhui&s=${q}`;
  if (site === "reddit") target = "https://www.reddit.com/";
  if (site === "xiaohongshu") { target = params.url || `https://www.xiaohongshu.com/search_result?keyword=${q}&source=web_search_result_notes`; reuseOrigin = false; }
  if (site === "wechat") { target = params.url || `https://weixin.sogou.com/weixin?type=2&query=${q}&page=${params.page}`; reuseOrigin = operation === "wechat.search"; }
  if (site === "youtube") { target = params.id ? `https://www.youtube.com/watch?v=${params.id}` : `https://www.youtube.com/results?search_query=${q}`; reuseOrigin = false; }
  const parsed = new URL(target);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || !hosts[site].includes(parsed.hostname)) throw new Error("链接不属于该适配器允许的网站。");
  if (site === "xiaohongshu" && params.url && !/^\/(explore|discovery\/item)\/[a-f0-9]{24}\/?$/.test(parsed.pathname)) throw new Error("需要小红书笔记的完整链接，保留原链接的 xsec_token。");
  if (operation === "wechat.article" && !((parsed.hostname === "mp.weixin.qq.com" && /^\/s(?:\/|$)/.test(parsed.pathname)) || (parsed.hostname === "weixin.sogou.com" && parsed.pathname === "/link"))) throw new Error("需要搜狗文章跳转链接或微信公众号文章链接。");
  return { operation, params, url: target, hosts: hosts[site], reuseOrigin };
}
