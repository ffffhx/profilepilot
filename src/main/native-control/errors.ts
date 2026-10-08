export class NativeControlError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "NativeControlError"; }
}
const legacyVisualTimeouts = new Set([
  "截图无响应，已停止等待。",
  "实时画面无响应，已停止等待。",
  "滚动已执行，但绘制尚未确认：截图无响应，已停止等待。 请先核查控制状态并读取结果，勿直接重放滚动。",
  "滚动已执行，但绘制尚未确认：实时画面无响应，已停止等待。 请先核查控制状态并读取结果，勿直接重放滚动。"
]);
export function nativeControlError(error: unknown): { code: string; message: string; exitCode: number } {
  const message = error instanceof Error ? error.message : String(error);
  const explicit = (error as { code?: unknown })?.code;
  const code = typeof explicit === "string" && explicit.startsWith("NATIVE_") ? explicit
    // These bounded visual reads do not revoke ownership in the extension.
    // Match the complete legacy messages so real stop/takeover errors still win.
    : legacyVisualTimeouts.has(message) ? "NATIVE_RENDER_UNAVAILABLE"
    : /未知参数|未知浏览器方法|未知直接操作|需要.*参数|params 必须|JSON 语法/.test(message) ? "NATIVE_INVALID_REQUEST"
    : /(?:最新|最近|观察|携带).*version|version.*(?:过期|失效|不匹配)|重新观察|引用.*失效|页面.*变化/.test(message) ? "NATIVE_OBSERVATION_STALE"
    : /另一个任务|Profile.*占用|会话.*匹配|会话.*不存在|会话.*存在/.test(message) ? "NATIVE_SESSION_CONFLICT"
    : /接管|用户正在|已停止|交还/.test(message) ? "NATIVE_USER_IN_CONTROL"
    : /未运行|连接失败|未连接|断线|连接中断/.test(message) ? "NATIVE_DISCONNECTED"
    : /超时/.test(message) ? "NATIVE_TIMEOUT_UNCERTAIN"
    : /requestId/.test(message) ? "NATIVE_REQUEST_CONFLICT"
    : /无效|需要.*参数|未知参数|params|JSON|唯一 requestId/.test(message) ? "NATIVE_INVALID_REQUEST"
    : "NATIVE_BROWSER_ERROR";
  return { code, message, exitCode: ["NATIVE_USER_IN_CONTROL", "NATIVE_SESSION_CONFLICT", "NATIVE_OBSERVATION_STALE", "NATIVE_TIMEOUT_UNCERTAIN"].includes(code) ? 75 : code === "NATIVE_DISCONNECTED" ? 69 : code === "NATIVE_INVALID_REQUEST" ? 64 : 1 };
}
