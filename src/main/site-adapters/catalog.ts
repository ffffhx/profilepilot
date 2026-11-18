import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { xianyuSearchSchema, xianyuDetailSchema, xianyuRegionsSchema } from "./xianyu-schema";

const query = z.string().trim().min(1).max(200);
const page = z.number().int().min(1).max(100).default(1);
const limit = z.number().int().min(1).max(50).default(20);
const id = z.string().regex(/^[\w-]{1,100}$/);
const cursor = z.string().max(300).optional();
const itemOffset = z.number().int().min(0).max(5000).default(0);
const url = z.string().url().max(2000);
const definitions = {
  "xianyu.search": { batch: 4, title: "闲鱼商品搜索", schema: xianyuSearchSchema },
  "xianyu.detail": { batch: 4, title: "闲鱼商品详情", schema: xianyuDetailSchema },
  "xianyu.regions": { batch: 4, title: "闲鱼地区选项", schema: xianyuRegionsSchema },
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

export type BuiltinSiteOperation = keyof typeof definitions;
export type SiteOperation = BuiltinSiteOperation | (string & {});

export interface SiteCatalogOptions {
  homeDir?: string;
  adaptersDir?: string;
}

export interface ExternalSiteFieldSpec {
  selector?: string;
  attr?: string;
  mode?: "text" | "html" | "href" | "number";
  path?: string;
}

export type ExternalSiteExtractor =
  | {
      kind: "dom";
      itemsSelector?: string;
      emptySelector?: string;
      blockedPattern?: string;
      nextPageSelector?: string;
      fields: Record<string, string | ExternalSiteFieldSpec>;
    }
  | {
      kind: "browser-fetch";
      endpoint: string;
      itemsPath?: string;
      hasMorePath?: string;
      fields?: Record<string, string>;
    };

interface ExternalParameterDef {
  type: "string" | "integer" | "number" | "boolean" | "url" | "enum";
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  maxLength?: number;
  pattern?: string;
  values?: string[];
}

interface LoadedExternalOperation {
  operation: string;
  title: string;
  batch: number;
  hosts: string[];
  urlTemplate: string;
  reuseOrigin: boolean;
  schema: z.ZodTypeAny;
  presets: Record<string, Record<string, unknown>>;
  extractor: ExternalSiteExtractor;
  sourceFile: string;
}

export interface LoadedExternalSiteAdapters {
  operations: Map<string, LoadedExternalOperation>;
  presetsByOperation: Map<string, Record<string, Record<string, unknown>>>;
  warnings: Array<{ file: string; message: string }>;
}

export interface SiteInput {
  operation: string;
  preset?: string;
  params?: Record<string, unknown>;
}

export interface SitePlan {
  operation: SiteOperation;
  params: Record<string, any>;
  url: string;
  hosts: string[];
  reuseOrigin: boolean;
  access?: { allowedOrigins?: string[]; blockedOrigins?: string[] };
  externalExtractor?: ExternalSiteExtractor;
}

export interface SiteResult {
  version: 1; operation: SiteOperation; status: "ok" | "empty" | "partial" | "blocked" | "error";
  source: { url: string; method: "browser-fetch" | "page-state" | "dom"; checkedAt: string };
  effective: Record<string, unknown>; items: Record<string, any>[];
  pagination: { next: Record<string, unknown> | null; hasMore: boolean | null };
  completeness: { scope: string; complete: boolean; reasons: string[] };
  error?: { code: string; message: string };
  metrics?: { durationMs: number; browserCalls: number; outputBytes: number };
}

const SAFE_OPERATION_RE = /^[a-z0-9][a-z0-9_-]{0,39}\.[a-z0-9][a-z0-9_-]{0,39}$/;
const SAFE_HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function siteAdaptersDirectory(options?: SiteCatalogOptions): string {
  if (options?.adaptersDir) {
    return path.resolve(options.adaptersDir);
  }
  const envDir = process.env.PROFILEPILOT_SITE_ADAPTERS_DIR?.trim();
  if (envDir) {
    return path.resolve(envDir);
  }
  const baseHome = options?.homeDir || process.env.PROFILEPILOT_GATEWAY_HOME || os.homedir();
  return path.join(baseHome, ".profilepilot", "site-adapters");
}

function buildExternalParamSchema(spec: Record<string, ExternalParameterDef> | undefined): z.ZodObject<any> {
  const shape: Record<string, z.ZodTypeAny> = {};
  if (!spec || typeof spec !== "object") {
    return z.object({ limit, itemOffset }).strict();
  }
  for (const [key, def] of Object.entries(spec)) {
    if (!def || typeof def !== "object" || key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    let field: z.ZodTypeAny;
    if (def.type === "url") {
      field = z.string().url().max(def.maxLength ?? 2000);
    } else if (def.type === "enum") {
      const vals = Array.isArray(def.values) && def.values.length > 0
        ? def.values.filter((v): v is string => typeof v === "string" && v.length > 0)
        : [];
      if (!vals.length) throw new Error(`参数 ${key} 的 enum values 不能为空`);
      field = z.enum(vals as [string, ...string[]]);
    } else if (def.type === "integer") {
      let num = z.number().int();
      if (typeof def.min === "number") num = num.min(def.min);
      if (typeof def.max === "number") num = num.max(def.max);
      field = num;
    } else if (def.type === "number") {
      let num = z.number();
      if (typeof def.min === "number") num = num.min(def.min);
      if (typeof def.max === "number") num = num.max(def.max);
      field = num;
    } else if (def.type === "boolean") {
      field = z.boolean();
    } else {
      let str = z.string().trim();
      if (def.required !== false && def.default === undefined) str = str.min(1);
      str = str.max(def.maxLength ?? 500);
      if (typeof def.pattern === "string" && def.pattern.length <= 200) {
        str = str.regex(new RegExp(def.pattern));
      }
      field = str;
    }
    if (def.default !== undefined) {
      field = field.default(def.default);
    } else if (def.required === false) {
      field = field.optional();
    }
    shape[key] = field;
  }
  return z.object(shape).strict();
}

function normalizePresetsMap(raw: unknown): Record<string, Record<string, unknown>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, Record<string, unknown>> = {};
  for (const [name, values] of Object.entries(raw as Record<string, unknown>)) {
    if (
      !name ||
      name === "__proto__" ||
      !values ||
      typeof values !== "object" ||
      Array.isArray(values)
    ) {
      continue;
    }
    result[name] = { ...(values as Record<string, unknown>) };
  }
  return result;
}

function parseExternalExtractor(raw: unknown): ExternalSiteExtractor {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("缺少有效的 extractor 配置");
  }
  const record = raw as Record<string, unknown>;
  if (record.kind === "dom") {
    if (!record.fields || typeof record.fields !== "object" || Array.isArray(record.fields)) {
      throw new Error("dom extractor 需要 fields 映射");
    }
    const fields: Record<string, string | ExternalSiteFieldSpec> = {};
    for (const [k, v] of Object.entries(record.fields as Record<string, unknown>)) {
      if (typeof v === "string") {
        fields[k] = v;
      } else if (v && typeof v === "object" && !Array.isArray(v)) {
        const spec = v as Record<string, unknown>;
        fields[k] = {
          ...(typeof spec.selector === "string" ? { selector: spec.selector } : {}),
          ...(typeof spec.attr === "string" ? { attr: spec.attr } : {}),
          ...(spec.mode === "text" || spec.mode === "html" || spec.mode === "href" || spec.mode === "number"
            ? { mode: spec.mode }
            : {})
        };
      }
    }
    return {
      kind: "dom",
      ...(typeof record.itemsSelector === "string" ? { itemsSelector: record.itemsSelector } : {}),
      ...(typeof record.emptySelector === "string" ? { emptySelector: record.emptySelector } : {}),
      ...(typeof record.blockedPattern === "string" ? { blockedPattern: record.blockedPattern } : {}),
      ...(typeof record.nextPageSelector === "string" ? { nextPageSelector: record.nextPageSelector } : {}),
      fields
    };
  }
  if (record.kind === "browser-fetch") {
    if (typeof record.endpoint !== "string" || !record.endpoint.trim()) {
      throw new Error("browser-fetch extractor 需要 endpoint");
    }
    const fields: Record<string, string> = {};
    if (record.fields && typeof record.fields === "object" && !Array.isArray(record.fields)) {
      for (const [k, v] of Object.entries(record.fields as Record<string, unknown>)) {
        if (typeof v === "string" && v.trim()) fields[k] = v.trim();
      }
    }
    return {
      kind: "browser-fetch",
      endpoint: record.endpoint.trim(),
      ...(typeof record.itemsPath === "string" ? { itemsPath: record.itemsPath.trim() } : {}),
      ...(typeof record.hasMorePath === "string" ? { hasMorePath: record.hasMorePath.trim() } : {}),
      ...(Object.keys(fields).length > 0 ? { fields } : {})
    };
  }
  throw new Error("extractor.kind 仅支持 dom 或 browser-fetch");
}

export function loadExternalSiteAdapterConfigs(options?: SiteCatalogOptions): LoadedExternalSiteAdapters {
  const dir = siteAdaptersDirectory(options);
  const operations = new Map<string, LoadedExternalOperation>();
  const presetsByOperation = new Map<string, Record<string, Record<string, unknown>>>();
  const warnings: Array<{ file: string; message: string }> = [];

  let entries: string[] = [];
  try {
    entries = readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(".json"))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return { operations, presetsByOperation, warnings };
  }

  for (const fileName of entries) {
    const filePath = path.join(dir, fileName);
    try {
      const rawText = readFileSync(filePath, "utf8");
      if (Buffer.byteLength(rawText, "utf8") > 512 * 1024) {
        throw new Error("配置文件超过 512 KiB");
      }
      const parsed = JSON.parse(rawText.replace(/^\uFEFF/, "")) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("根节点必须是 JSON 对象");
      }
      const defaultSite = typeof parsed.site === "string" ? parsed.site.trim().toLowerCase() : "";
      const defaultHosts = Array.isArray(parsed.hosts)
        ? parsed.hosts.filter((h): h is string => typeof h === "string" && SAFE_HOSTNAME_RE.test(h.trim())).map((h) => h.trim().toLowerCase())
        : [];

      if (parsed.presets && typeof parsed.presets === "object" && !Array.isArray(parsed.presets)) {
        for (const [opKey, presetGroup] of Object.entries(parsed.presets as Record<string, unknown>)) {
          const fullOp = opKey.includes(".") || !defaultSite ? opKey : `${defaultSite}.${opKey}`;
          if (!SAFE_OPERATION_RE.test(fullOp)) continue;
          const normalized = normalizePresetsMap(presetGroup);
          if (Object.keys(normalized).length > 0) {
            presetsByOperation.set(fullOp, {
              ...(presetsByOperation.get(fullOp) || {}),
              ...normalized
            });
          }
        }
      }

      const rawOps = parsed.operations;
      const opEntries: Array<[string, Record<string, unknown>]> = [];
      if (Array.isArray(rawOps)) {
        for (const item of rawOps) {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            const rec = item as Record<string, unknown>;
            const name = typeof rec.operation === "string" ? rec.operation : typeof rec.name === "string" ? rec.name : "";
            if (name) opEntries.push([name, rec]);
          }
        }
      } else if (rawOps && typeof rawOps === "object") {
        for (const [name, item] of Object.entries(rawOps as Record<string, unknown>)) {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            opEntries.push([name, item as Record<string, unknown>]);
          }
        }
      }

      for (const [rawName, opRec] of opEntries) {
        const operation = rawName.includes(".")
          ? rawName.trim()
          : defaultSite
            ? `${defaultSite}.${rawName.trim()}`
            : "";
        if (!SAFE_OPERATION_RE.test(operation)) {
          throw new Error(`无效操作名称：${rawName}`);
        }
        const hosts = Array.isArray(opRec.hosts)
          ? opRec.hosts.filter((h): h is string => typeof h === "string" && SAFE_HOSTNAME_RE.test(h.trim())).map((h) => h.trim().toLowerCase())
          : defaultHosts;
        if (!hosts.length) {
          throw new Error(`操作 ${operation} 缺少有效的 HTTPS hosts 白名单`);
        }
        const urlTemplate = typeof opRec.url === "string" ? opRec.url.trim() : "";
        if (!urlTemplate.startsWith("https://")) {
          throw new Error(`操作 ${operation} 的 url 必须以 https:// 开头`);
        }
        const title = typeof opRec.title === "string" && opRec.title.trim() ? opRec.title.trim() : operation;
        const batch = typeof opRec.batch === "number" && Number.isInteger(opRec.batch) ? opRec.batch : 5;
        const reuseOrigin = opRec.reuseOrigin === true;
        const schema = opRec.parameters === undefined && Object.hasOwn(definitions, operation)
          ? definitions[operation as BuiltinSiteOperation].schema
          : buildExternalParamSchema(opRec.parameters as Record<string, ExternalParameterDef> | undefined);
        const opPresets = normalizePresetsMap(opRec.presets);
        if (Object.keys(opPresets).length > 0) {
          presetsByOperation.set(operation, {
            ...(presetsByOperation.get(operation) || {}),
            ...opPresets
          });
        }
        const extractor = parseExternalExtractor(opRec.extractor);
        operations.set(operation, {
          operation,
          title,
          batch,
          hosts,
          urlTemplate,
          reuseOrigin,
          schema,
          presets: presetsByOperation.get(operation) || {},
          extractor,
          sourceFile: filePath
        });
      }
    } catch (error) {
      warnings.push({
        file: filePath,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { operations, presetsByOperation, warnings };
}

function interpolateUrlTemplate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const val = params[key];
    if (val === undefined || val === null) return "";
    if (key === "url" && typeof val === "string" && val.startsWith("https://")) {
      return val;
    }
    return encodeURIComponent(String(val));
  });
}

function resolveInputWithPreset(
  operation: string,
  input: SiteInput,
  presetsByOperation: Map<string, Record<string, Record<string, unknown>>>
): Record<string, unknown> {
  const rawParams = input.params && typeof input.params === "object" && !Array.isArray(input.params)
    ? { ...input.params }
    : {};
  const presetFromParams = typeof rawParams.preset === "string" ? rawParams.preset.trim() : "";
  if ("preset" in rawParams) {
    delete rawParams.preset;
  }
  const presetName = (typeof input.preset === "string" ? input.preset.trim() : "") || presetFromParams;
  if (!presetName) {
    return rawParams;
  }
  const opPresets = presetsByOperation.get(operation);
  if (!opPresets || !Object.hasOwn(opPresets, presetName)) {
    throw new Error(`未知网站预设：${presetName}`);
  }
  return {
    ...opPresets[presetName],
    ...rawParams
  };
}

export function listSiteAdapters(site?: string, options?: SiteCatalogOptions) {
  const external = loadExternalSiteAdapterConfigs(options);
  const merged = new Map<string, {
    operation: string;
    title: string;
    batch: number;
    schema: z.ZodTypeAny;
    source?: "builtin" | "external";
    presets?: string[];
  }>();

  for (const [operation, d] of Object.entries(definitions)) {
    const presets = Object.keys(external.presetsByOperation.get(operation) || {});
    merged.set(operation, {
      operation,
      title: d.title,
      batch: d.batch,
      schema: d.schema,
      ...(presets.length > 0 ? { presets } : {})
    });
  }
  for (const [operation, ext] of external.operations.entries()) {
    const presets = Object.keys(external.presetsByOperation.get(operation) || ext.presets || {});
    merged.set(operation, {
      operation,
      title: ext.title,
      batch: ext.batch,
      schema: ext.schema,
      source: "external",
      ...(presets.length > 0 ? { presets } : {})
    });
  }

  const keys = [...merged.keys()];
  if (site !== undefined && !keys.some(operation => operation === site || operation.startsWith(site + "."))) {
    throw new Error("未知网站；使用 sites 查看全部操作。");
  }
  return [...merged.values()]
    .filter((entry) => !site || entry.operation === site || entry.operation.startsWith(site + "."))
    .map((entry) => ({
      operation: entry.operation,
      title: entry.title,
      batch: entry.batch,
      readOnly: true,
      input: z.toJSONSchema(entry.schema, { io: "input" }),
      ...(entry.source ? { source: entry.source } : {}),
      ...(entry.presets && entry.presets.length > 0 ? { presets: entry.presets } : {}),
      validation: "experimental; consult live verification report for tested availability"
    }));
}

export function planSiteAdapter(input: SiteInput, options?: SiteCatalogOptions): SitePlan {
  const requestedOp = typeof input?.operation === "string" ? input.operation : "";
  const external = loadExternalSiteAdapterConfigs(options);
  const externalOp = external.operations.get(requestedOp);

  if (externalOp) {
    const mergedInput = resolveInputWithPreset(requestedOp, input, external.presetsByOperation);
    const params = externalOp.schema.parse(mergedInput) as Record<string, any>;
    const target = interpolateUrlTemplate(externalOp.urlTemplate, params);
    const parsed = new URL(target);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !externalOp.hosts.includes(parsed.hostname.toLowerCase())
    ) {
      throw new Error("链接不属于该适配器允许的网站。");
    }
    return {
      operation: externalOp.operation,
      params,
      url: target,
      hosts: externalOp.hosts,
      reuseOrigin: externalOp.reuseOrigin,
      externalExtractor: externalOp.extractor
    };
  }

  if (!Object.hasOwn(definitions, requestedOp)) throw new Error("未知网站操作；先用 sites 列出适配能力。");
  const operation = requestedOp as BuiltinSiteOperation;
  const mergedInput = resolveInputWithPreset(operation, input, external.presetsByOperation);
  const params = definitions[operation].schema.strict().parse(mergedInput) as Record<string, any>;
  if (operation === "xianyu.search" && params.minPrice !== undefined && params.maxPrice !== undefined && params.minPrice > params.maxPrice) throw new Error("最低价格不能高于最高价格。");
  if (operation === "xianyu.search" && params.region?.area && !params.region.city) throw new Error("指定区县时需要同时提供城市。");
  const site = operation.split(".")[0], q = encodeURIComponent(params.query || "");
  let target = "", reuseOrigin = true;
  const hosts: Record<string, string[]> = {
    xianyu: ["www.goofish.com"],
    boss: ["www.zhipin.com"], bilibili: ["www.bilibili.com", "search.bilibili.com"], zhihu: ["www.zhihu.com"],
    smzdm: ["search.smzdm.com"], reddit: ["www.reddit.com"], xiaohongshu: ["www.xiaohongshu.com"],
    wechat: ["weixin.sogou.com", "mp.weixin.qq.com"], youtube: ["www.youtube.com"]
  };
  if (site === "xianyu") target = operation === "xianyu.detail" ? `https://www.goofish.com/item?id=${params.id}` : operation === "xianyu.search" ? `https://www.goofish.com/search?q=${q}` : "https://www.goofish.com/";
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
