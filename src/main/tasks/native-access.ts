import type { NativeAccessPolicy } from "../../shared/tasks";
export type { NativeAccessPolicy } from "../../shared/tasks";

/** Empty lists allow every site. Restrictions belong to the paired Chrome Profile. */
export function normalizeNativeAccess(input: NativeAccessPolicy = {}): Required<NativeAccessPolicy> {
  const origins = (values: string[] | undefined): string[] => {
    if (values === undefined) return [];
    if (!Array.isArray(values) || values.length > 200) throw new Error("网站列表最多支持 200 项。");
    return [...new Set(values.map(value => {
      const url = new URL(value.trim());
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new Error("请填写网站来源，例如 https://example.com，不包含路径、查询参数或账号。");
      }
      return url.origin;
    }))];
  };
  if (input.confirmActions !== undefined && typeof input.confirmActions !== "boolean") throw new Error("逐次确认设置无效。");
  return { allowedOrigins: origins(input.allowedOrigins), blockedOrigins: origins(input.blockedOrigins), confirmActions: input.confirmActions === true };
}

/** Browser approval only: never grants terminal access or resumes stopped tasks. */
export function nativeBrowserAccess(
  task: { profileId: string; browserConnection?: string; mode?: string; nativeAccess?: NativeAccessPolicy },
  action: { effect: string },
  url?: string
): { fullAccess: boolean; requiresConfirmation: boolean; allowed: boolean; reason?: string } {
  const native = task.browserConnection === "extension" || task.profileId.startsWith("native:");
  if (!native) return { fullAccess: false, requiresConfirmation: false, allowed: true };
  const policy = normalizeNativeAccess(task.nativeAccess);
  let origin: string | undefined;
  if (url) { try { origin = new URL(url).origin; } catch { /* Executor validates unsupported URLs. */ } }
  if (origin && (policy.blockedOrigins.includes(origin) || policy.allowedOrigins.length > 0 && !policy.allowedOrigins.includes(origin))) {
    return { fullAccess: false, requiresConfirmation: false, allowed: false, reason: `此网站已被可选访问设置限制：${origin}。可在 Chrome 侧边栏的网站设置中修改。` };
  }
  const fullAccess = task.mode !== "manual" && task.mode !== "plan" && !policy.confirmActions;
  return { fullAccess, requiresConfirmation: !fullAccess && action.effect !== "read", allowed: true };
}
