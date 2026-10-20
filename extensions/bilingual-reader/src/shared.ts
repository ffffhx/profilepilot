export type Provider = "browser" | "custom";
export type Style = "subtle" | "card" | "underline";
export interface Settings {
  provider: Provider;
  sourceLanguage: string;
  targetLanguage: string;
  endpoint: string;
  model: string;
  apiKey: string;
  glossary: string;
  style: Style;
  fontSize: number;
  autoSites: string[];
  excludedSites: string[];
  selectionEnabled: boolean;
  concurrency: number;
}
export type PublicSettings = Omit<Settings, "apiKey">;
export interface Segment { id: string; text: string }
export interface TranslationRequest {
  segments: Segment[];
  context: string;
  sourceLanguage: string;
  targetLanguage: string;
}
export interface TranslationResult { id: string; text: string; cached?: boolean }
export interface PageStatus {
  enabled: boolean;
  translated: number;
  total: number;
  failed: number;
  pending: number;
  cached: number;
  error: string;
  hostname: string;
}
export interface Response<T> { ok: boolean; data?: T; error?: string }
export const LANGUAGES = [
  ["en", "英语"], ["zh", "简体中文"], ["zh-Hant", "繁體中文"],
  ["ja", "日语"], ["ko", "韩语"], ["fr", "法语"], ["de", "德语"],
  ["es", "西班牙语"], ["pt", "葡萄牙语"], ["ru", "俄语"],
  ["it", "意大利语"], ["ar", "阿拉伯语"], ["vi", "越南语"]
] as const;
export const TEST_SENTENCES: Record<string, string> = {
  en: "Reading opens a window to the world.",
  zh: "阅读为我们打开了一扇通往世界的窗。",
  "zh-Hant": "閱讀為我們打開了一扇通往世界的窗。",
  ja: "読書は世界への窓を開きます。",
  ko: "독서는 세상을 향한 창을 열어 줍니다.",
  fr: "La lecture ouvre une fenêtre sur le monde.",
  de: "Lesen öffnet ein Fenster zur Welt.",
  es: "La lectura abre una ventana al mundo.",
  pt: "A leitura abre uma janela para o mundo.",
  ru: "Чтение открывает окно в мир.",
  it: "La lettura apre una finestra sul mondo.",
  ar: "القراءة تفتح نافذة على العالم.",
  vi: "Đọc sách mở ra một cửa sổ nhìn ra thế giới."
};
export const DEFAULT_SETTINGS: Settings = {
  provider: "browser", sourceLanguage: "en", targetLanguage: "zh",
  endpoint: "", model: "", apiKey: "", glossary: "", style: "subtle",
  fontSize: 100, autoSites: [], excludedSites: [], selectionEnabled: true, concurrency: 2
};
export function publicSettings(settings: Settings): PublicSettings {
  const { apiKey: _, ...rest } = settings;
  return rest;
}
export function normalizeEndpoint(value: string): string {
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash) throw new Error("接口地址不能包含账号、密码、查询参数或片段。");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("请使用 HTTPS 地址；本机服务可以使用 http://localhost 或 http://127.0.0.1。");
  }
  let pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/chat/completions")) pathname += pathname.endsWith("/v1") ? "/chat/completions" : "/v1/chat/completions";
  url.pathname = pathname;
  return url.href;
}
export function cleanSites(sites: unknown): string[] {
  if (!Array.isArray(sites)) return [];
  return [...new Set(sites.map(value => String(value).trim().toLowerCase())
    .filter(value => /^(?:localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/.test(value)))].slice(0, 300);
}
export function validateSettings(input: Partial<Settings>): Settings {
  const s = { ...DEFAULT_SETTINGS, ...input };
  if (!["browser", "custom"].includes(s.provider)) throw new Error("未知翻译服务。");
  if (!LANGUAGES.some(([code]) => code === s.sourceLanguage) || !LANGUAGES.some(([code]) => code === s.targetLanguage)) throw new Error("请选择支持的语言。");
  if (s.sourceLanguage === s.targetLanguage) throw new Error("原文语言和目标语言不能相同。");
  if (!["subtle", "card", "underline"].includes(s.style)) s.style = "subtle";
  s.fontSize = Math.max(80, Math.min(140, Number(s.fontSize) || 100));
  s.concurrency = Math.max(1, Math.min(3, Math.floor(Number(s.concurrency) || 2)));
  s.apiKey = String(s.apiKey || "").trim().slice(0, 8192);
  s.model = String(s.model || "").trim().slice(0, 200);
  s.glossary = String(s.glossary || "").trim().slice(0, 10000);
  s.endpoint = s.endpoint ? normalizeEndpoint(s.endpoint) : "";
  for (const key of ["autoSites", "excludedSites"] as const) {
    if (!Array.isArray(s[key]) || s[key].some(value => typeof value !== "string" || value.trim() && !cleanSites([value]).length)) {
      throw new Error("站点规则请填写域名，不包含协议、路径或端口。");
    }
    s[key] = cleanSites(s[key]);
  }
  s.selectionEnabled = Boolean(s.selectionEnabled);
  if (s.provider === "custom" && (!s.endpoint || !s.model)) throw new Error("请填写 API 地址和模型名称。");
  return s;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export async function send<T>(type: string, payload?: unknown): Promise<T> {
  const response: Response<T> = await chrome.runtime.sendMessage({ type, payload });
  if (!response?.ok) throw new Error(response?.error || "扩展连接已断开，请刷新页面。");
  return response.data as T;
}
export async function fingerprint(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(hash), v => v.toString(16).padStart(2, "0")).join("");
}
export function cacheIdentity(s: PublicSettings, text: string, context: string, source: string, target: string) {
  return [3, s.provider, s.endpoint, s.model, source, target, s.glossary, context, text];
}
