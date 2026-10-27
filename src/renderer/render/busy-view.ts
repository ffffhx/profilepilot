import { store } from "../state";
import type { BusyState } from "../types";
import { escapeHtml } from "../util";

export const TOAST_NAME_START = String.fromCharCode(1);

export const TOAST_NAME_END = String.fromCharCode(2);

export function emphasizeName(name: string): string {
  return `${TOAST_NAME_START}${name}${TOAST_NAME_END}`;
}

export function renderToastBody(message: string, kind: "normal" | "error" = "normal"): string {
  if (kind === "error") {
    const firstLine = message.split(/\r?\n/, 1)[0];
    const summary = /^Command failed:/.test(firstLine) ? "命令执行失败，请展开诊断信息查看原因。"
      : firstLine.length > 180 ? `${firstLine.slice(0, 180)}…` : firstLine;
    const details = summary !== message;
    return `<div class="toast-summary"><span>${escapeHtml(summary)}</span><button type="button" data-toast-dismiss aria-label="关闭错误提示">×</button></div>
      ${details ? `<details class="toast-diagnostics"><summary>查看完整诊断</summary><pre>${escapeHtml(message)}</pre></details>` : ""}
      <button type="button" class="toast-copy" data-toast-copy>复制${details ? "诊断信息" : "错误信息"}</button>`;
  }
  return escapeHtml(message)
    .split(TOAST_NAME_START)
    .join('<span class="toast-name font-mono font-semibold text-accent-bright">')
    .split(TOAST_NAME_END)
    .join("</span>");
}

export function isBusyAction(key: string, match: Partial<Omit<BusyState, "key" | "message">> = {}): boolean {
  const activeBusyState = store.busyState;
  if (!activeBusyState || activeBusyState.key !== key) {
    return false;
  }

  return Object.entries(match).every(([field, value]) => activeBusyState[field as keyof BusyState] === value);
}

export type ProfileBusyKind = "launch" | "close";

export function profileBusyKind(profileId: string): ProfileBusyKind | null {
  if (isBusyAction("launch-profile", { profileId }) || isBusyAction("launch-cdp", { profileId })) {
    return "launch";
  }
  if (isBusyAction("close-profile", { profileId })) {
    return "close";
  }
  return null;
}

export function profileBusyStatusLabel(kind: ProfileBusyKind): string {
  return kind === "launch" ? "启动中" : "关闭中";
}
