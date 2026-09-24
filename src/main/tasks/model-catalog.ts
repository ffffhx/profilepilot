import type { TaskSettings } from "../../shared/tasks";
import { providerEnvironment } from "./provider";

export async function listServiceModels(settings: TaskSettings, key: string): Promise<string[]> {
  if (!key) throw new Error("请先在模型服务设置中保存 API 密钥，也可以直接输入模型 ID。");
  const url = new URL(settings.baseUrl);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("模型服务地址无效，请检查设置。");
  let prefix = url.pathname.replace(/\/$/, "").replace(/\/(?:messages|chat\/completions)$/, "");
  if (["api.moonshot.cn", "api.moonshot.ai", "api.deepseek.com"].includes(url.hostname) && /^\/anthropic(?:\/v1)?$/.test(prefix)) prefix = "";
  url.pathname = `${prefix}${/\/v\d+(?:beta)?$/.test(prefix) ? "" : "/v1"}/models`;
  const env = providerEnvironment(settings, key, "");
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01", ...(env.ANTHROPIC_AUTH_TOKEN ? { Authorization: `Bearer ${key}` } : { "x-api-key": key }) };
  // The DeepSeek catalog is OpenAI-compatible even when Messages uses x-api-key.
  if (url.hostname === "api.deepseek.com") { delete headers["x-api-key"]; headers.Authorization = `Bearer ${key}`; }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(12000), redirect: "error" });
  if (!response.ok) throw new Error(`无法读取模型列表（HTTP ${response.status}）。可直接输入模型 ID，或检查模型服务设置。`);
  const payload = await response.json() as { data?: Array<{ id?: unknown }> };
  const ids = [...new Set((Array.isArray(payload.data) ? payload.data : []).map(item => item.id).filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200))];
  if (!ids.length) throw new Error("当前服务未返回模型列表，请直接输入模型 ID。");
  return ids.slice(0, 1000).sort((a, b) => a.localeCompare(b));
}
