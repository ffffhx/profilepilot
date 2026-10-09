import type { LocalAppView } from "./local-apps";

export function localAppAvailability(app: LocalAppView): { ready: boolean; label: string; note: string } {
  if (app.mode === "service") return { ready: false, label: "不支持界面操作", note: "这是后台服务，没有可供 Agent 操作的应用窗口。" };
  if (["starting", "stopping", "unknown"].includes(app.runtime.status)) return { ready: false, label: "待确认", note: "正在确认应用状态，请稍候或刷新。" };
  if (app.runtime.status === "stopped" || app.runtime.status === "failed") return {
    ready: false, label: app.cdpPort ? "启动后连接" : "待配置",
    note: app.controls.start ? "启动应用后，再确认 Agent 是否可以连接。" : "请先打开应用，再检查连接。"
  };
  // A reachable debug/main port does not prove the protected Agent route works.
  if (app.agent?.connected && app.debug.renderer) return { ready: true, label: "可操作", note: "当前没有 Agent 使用此应用。" };
  return { ready: false, label: "未连接", note: "连接后，Agent 才能查看和操作这个应用。" };
}

export function localAppAgentLabel(app: LocalAppView): string {
  if (!app.agent?.sessionId) return "未被使用";
  if (app.agent.ownership === "user") return "已由你接管";
  if (!localAppAvailability(app).ready || app.agent.connectionActive === false) return "等待重新连接";
  return app.agent.connectionActive ? "正在操作" : "会话进行中";
}
