import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { z } from "zod";

const httpKeepAlive = new http.Agent({ keepAlive: true, maxSockets: 4, keepAliveMsecs: 5000 });
const httpsKeepAlive = new https.Agent({ keepAlive: true, maxSockets: 4, keepAliveMsecs: 5000 });

function isAllowedWdaIpv4(host: string): boolean {
  if (isIP(host) !== 4) return false;
  const [first, second] = host.split(".").map(Number);
  return first === 127
    || first === 10
    || first === 192 && second === 168
    || first === 172 && second >= 16 && second <= 31
    || first === 169 && second === 254
    || first === 100 && second >= 64 && second <= 127;
}

/** WDA has no authentication. Limit direct connections to an explicitly selected local/Tailscale endpoint. */
export function iphoneEndpoint(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("请输入有效的 iPhone 控制地址，例如 http://127.0.0.1:8100。"); }
  const host = url.hostname;
  const local = host === "localhost" || host === "[::1]" || isAllowedWdaIpv4(host);
  if (!local || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("iPhone 控制地址必须是本机、局域网或 Tailscale IP 的 HTTP(S) 根地址，不能包含账号、密码或其他路径。");
  return url.origin;
}

export interface WdaResponse { value: any; sessionId?: string | null; }
export type WdaRequest = (endpoint: string, route: string, method?: "GET" | "POST" | "DELETE", body?: unknown, signal?: AbortSignal) => Promise<WdaResponse>;

/** Bounded requests over keep-alive sockets, no redirects, no retry of an uncertain input. */
export const requestWda: WdaRequest = (endpoint, route, method = "GET", body, signal) => new Promise((resolve, reject) => {
  const url = new URL(iphoneEndpoint(endpoint) + route);
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? https : http;
  const agent = isHttps ? httpsKeepAlive : httpKeepAlive;
  const request = transport.request(url, {
    method,
    signal,
    agent,
    headers: data
      ? { "Content-Type": "application/json", "Content-Length": data.length, Connection: "keep-alive" }
      : { Connection: "keep-alive" }
  }, response => {
    let length = 0; const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 34 * 1024 * 1024) { response.destroy(); request.destroy(new Error("iPhone 返回内容过大。")); return; }
      chunks.push(chunk);
    });
    response.on("error", reject);
    response.on("end", () => {
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (response.statusCode! < 200 || response.statusCode! >= 300 || result.value?.error || typeof result.status === "number" && result.status !== 0)
          throw new Error(`iPhone 控制请求失败（${String(result.value?.error || response.statusCode).slice(0, 100)}）。请先检查手机和当前会话，不要重放操作。`);
        if (!result || typeof result !== "object" || !("value" in result)) throw new Error("iPhone 控制组件响应格式无效。");
        resolve(result);
      } catch (error) { reject(error instanceof SyntaxError ? new Error("该地址未返回有效的 WebDriverAgent 响应。") : error); }
    });
  });
  const timer = setTimeout(() => request.destroy(new Error("iPhone 控制请求超时，结果未确认；请检查手机状态。")), 15000);
  timer.unref(); request.once("close", () => clearTimeout(timer));
  request.on("error", error => reject(error));
  request.end(data);
});

export const iphoneAddSchema = z.object({
  endpoint: z.string().max(300).transform(iphoneEndpoint),
  name: z.string().trim().min(1).max(80).default("iPhone"),
}).strict();
export const iphoneSessionInput = z.object({
  id: z.string(), mode: z.enum(["view", "control"]).default("control"),
  controller: z.string().trim().min(1).max(120).default("本机用户"), task: z.string().trim().max(500).default(""),
  keepScreenOn: z.boolean().optional()
}).strict();
export function wdaSessionId(response: WdaResponse): string | undefined {
  const id = response.sessionId || response.value?.sessionId;
  if (!id) return undefined;
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(id)) throw new Error("iPhone 控制会话标识无效。");
  return id;
}
