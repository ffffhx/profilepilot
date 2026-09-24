import type { BrowserTask, NativeBrowserState } from "../shared/tasks";
import { hasTaskBrowser } from "../shared/tasks";
import type { PublicProfile } from "./types";

export interface TaskProfileAvailability {
  available: boolean;
  label: string;
}

export function taskProfileAvailability(profile: PublicProfile, tasks: BrowserTask[], nativeStates: NativeBrowserState[] = []): TaskProfileAvailability {
  const occupied = (label: string): TaskProfileAvailability => ({ available: false, label });
  if (profile.source === "native") {
    const state = nativeStates.find(state => state.profileId === profile.id);
    if (!state?.connected) return occupied(state ? "待连接 · 扩展已离线" : "待连接 · 尚未配对扩展");
    if (!state.taskTabs) return occupied("请更新或重新加载 ProfilePilot 扩展");
    if (state.ownerSessionId) return occupied(state.ownership === "user" ? "占用中 · 用户接管" : "占用中 · Agent 使用中");
    if (state.pausedByBrowser) return occupied("待连接 · 请在扩展中恢复连接");
  }
  const control = profile.gatewayControl;
  // A disconnected driver still owns its active session, including during user takeover.
  if (control?.sessionStatus === "active" && control.ownerSessionId) {
    return occupied(control.ownership === "user" ? "占用中 · 用户接管" : "占用中 · Agent 使用中");
  }
  if (profile.agentBrowserOccupancy) {
    return occupied(profile.agentBrowserOccupancy.ownership === "user" ? "占用中 · 用户接管" : "占用中 · 会话已预留");
  }
  // Gateway state is authoritative; legacy client scans must not revive a stopped session.
  if (control ? control.connectionActive : profile.cdpClients.length > 0) {
    return occupied("占用中 · 已有连接");
  }
  const profileTasks = tasks.filter(task => task.profileId === profile.id);
  if (profileTasks.some(task => task.status === "running")) return occupied("占用中 · 任务执行中");
  if (profileTasks.some(task => hasTaskBrowser(task) && ["waiting_user", "paused"].includes(task.status))) {
    return occupied("占用中 · 任务保留中");
  }
  if (profileTasks.some(task => task.status === "queued")) return occupied("占用中 · 有任务排队");
  return { available: true, label: profile.source === "native" ? "空闲 · 任务自动新开标签页" : profile.running ? "空闲" : "空闲 · 未启动" };
}
