import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export class CaptchaError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode = 1, readonly taskId?: number) { super(message); }
}
export interface CaptchaResult { status: "processing" | "ready"; solution?: Record<string, unknown>; cost?: string; }
export interface CaptchaProvider {
  create(task: Record<string, unknown>): Promise<number>;
  result(taskId: number): Promise<CaptchaResult>;
  balance(): Promise<number>;
}

export function captchaKey(env: NodeJS.ProcessEnv): string {
  let key = env.PROFILEPILOT_CAPTCHA_API_KEY || env.TWOCAPTCHA_API_KEY;
  if (!key && env.PROFILEPILOT_CAPTCHA_API_KEY_FILE) {
    try { key = readFileSync(env.PROFILEPILOT_CAPTCHA_API_KEY_FILE, "utf8").replace(/^\uFEFF/, "").trim(); }
    catch { throw new CaptchaError("CAPTCHA_CONFIG", "无法读取 PROFILEPILOT_CAPTCHA_API_KEY_FILE。", 64); }
  }
  if (!key?.trim()) throw new CaptchaError("CAPTCHA_CONFIG", "请设置 PROFILEPILOT_CAPTCHA_API_KEY 或 PROFILEPILOT_CAPTCHA_API_KEY_FILE（2Captcha 密钥）。", 64);
  return key.trim();
}

// Fixed HTTPS destination, no redirects or automatic createTask retries. Never
// surface remote error descriptions: they can echo the API key or task data.
export function twoCaptcha(key: string, fetcher: typeof fetch = fetch): CaptchaProvider {
  async function post(method: string, body: Record<string, unknown>): Promise<any> {
    let value: any;
    try {
      const response = await fetcher(`https://api.2captcha.com/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: key, ...body }), redirect: "error", signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw new Error("HTTP failure");
      value = await response.json();
    } catch {
      throw new CaptchaError("CAPTCHA_NETWORK_UNCERTAIN", "解题接口连接失败或响应无效；不会自动重提付费任务。", 75);
    }
    if (!value || !Number.isInteger(value.errorId)) throw new CaptchaError("CAPTCHA_RESPONSE_INVALID", "解题接口响应无效；不会自动重提任务。", 75);
    if (value.errorId !== 0) {
      // Numeric ID only, rather than trusting provider-controlled strings.
      throw new CaptchaError("CAPTCHA_PROVIDER_ERROR", `2Captcha 返回错误 ${value.errorId}；请检查余额、任务参数或服务商后台。`);
    }
    return value;
  }
  return {
    async create(task) {
      const value = await post("createTask", { task });
      if (!Number.isSafeInteger(value.taskId) || value.taskId <= 0) throw new CaptchaError("CAPTCHA_RESPONSE_INVALID", "服务商未返回有效任务编号；请检查后台，勿重复提交。", 75);
      return value.taskId;
    },
    async result(taskId) {
      const value = await post("getTaskResult", { taskId });
      if (value.status === "processing") return { status: "processing" };
      if (value.status !== "ready" || !value.solution || typeof value.solution !== "object" || Array.isArray(value.solution)) throw new CaptchaError("CAPTCHA_RESPONSE_INVALID", "解题结果格式无效。", 75, taskId);
      return { status: "ready", solution: value.solution, ...(typeof value.cost === "string" && /^\d+(\.\d+)?$/.test(value.cost) ? { cost: value.cost } : {}) };
    },
    async balance() {
      const value = await post("getBalance", {});
      if (typeof value.balance !== "number" || !Number.isFinite(value.balance) || value.balance < 0) throw new CaptchaError("CAPTCHA_RESPONSE_INVALID", "余额响应格式无效。");
      return value.balance;
    }
  };
}

export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

// A write-once reservation precedes the paid request. If the process dies or
// loses the response, its reservation remains uncertain instead of re-billing.
// Store neither credentials, page URLs, proxy passwords nor solution tokens.
export async function createOnce(root: string, identity: string, task: Record<string, unknown>, provider: CaptchaProvider): Promise<number> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, `${hash(identity)}.json`);
  const digest = hash(JSON.stringify(task));
  try { writeFileSync(file, JSON.stringify({ digest, status: "creating", at: new Date().toISOString() }), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let receipt;
    try { receipt = JSON.parse(readFileSync(file, "utf8")); }
    catch { throw new CaptchaError("CAPTCHA_SUBMISSION_UNCERTAIN", "同一任务正在提交或回执不完整；请检查服务商后台，勿重复付费。", 75); }
    if (receipt.digest !== digest) throw new CaptchaError("CAPTCHA_REQUEST_CONFLICT", "该 request-id 已用于不同的任务参数。", 64);
    if (Number.isSafeInteger(receipt.taskId) && receipt.taskId > 0) return receipt.taskId;
    throw new CaptchaError("CAPTCHA_SUBMISSION_UNCERTAIN", "同一任务已尝试提交，结果尚未确认；请检查服务商后台，勿重复付费。", 75);
  }
  const taskId = await provider.create(task);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ digest, status: "submitted", taskId, at: new Date().toISOString() }), { mode: 0o600 });
    renameSync(temporary, file);
  } catch { throw new CaptchaError("CAPTCHA_RECEIPT_FAILED", "任务已提交，但本地回执保存失败；用 taskId 查询，勿重复提交。", 75, taskId); }
  return taskId;
}
