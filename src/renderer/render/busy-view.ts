import { store } from "../state";
import type { BusyState } from "../types";
import { escapeHtml } from "../util";

export const TOAST_NAME_START = String.fromCharCode(1);

export const TOAST_NAME_END = String.fromCharCode(2);

export function emphasizeName(name: string): string {
  return `${TOAST_NAME_START}${name}${TOAST_NAME_END}`;
}

export function renderToastBody(message: string): string {
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
