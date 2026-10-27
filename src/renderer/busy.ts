import { emphasizeName, isBusyAction } from "./render/busy-view";
export { emphasizeName, renderToastBody, isBusyAction, profileBusyKind, profileBusyStatusLabel, TOAST_NAME_START, TOAST_NAME_END } from "./render/busy-view";
export type { ProfileBusyKind } from "./render/busy-view";
import { profileApi } from "./api";
import { invalidateView as render } from "./view-events";
import { loadState } from "./state-actions";
import { appRoot, store } from "./state";
import type { PublicProfile } from "../shared/types";
import type { BusyProgressStep, BusyState, ToastKind } from "./types";
import { formatErrorMessage } from "./util";

export function setToast(message: string, kind: ToastKind = "normal"): void {
  store.toast = message;
  store.toastKind = kind;
  render();

  window.clearTimeout(store.toastTimer);
  store.toastTimer = undefined;
  // Keep errors available while the user reads or copies diagnostics.
  if (kind === "error") return;
  store.toastTimer = window.setTimeout(() => {
    store.toast = null;
    render();
  }, 3200);
}

export function handleToastAction(event: Event): void {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("[data-toast-dismiss]")) {
    window.clearTimeout(store.toastTimer);
    store.toast = null;
    render();
  }
  const copy = target?.closest<HTMLButtonElement>("[data-toast-copy]");
  if (copy && store.toast) {
    const message = store.toast;
    void Promise.resolve().then(() => navigator.clipboard.writeText(message)).then(() => {
      copy.textContent = "已复制";
    }).catch(() => { copy.textContent = "复制失败，请展开后手动选择文本"; });
  }
}

export function activateBusyStep(steps: BusyProgressStep[], activeLabel: string): BusyProgressStep[] {
  const existingIndex = steps.findIndex((step) => step.label === activeLabel);
  const nextSteps = existingIndex >= 0 ? [...steps] : [...steps, { label: activeLabel, status: "pending" as const }];
  const activeIndex = existingIndex >= 0 ? existingIndex : nextSteps.length - 1;

  return nextSteps.map((step, index) => ({
    ...step,
    status: index < activeIndex ? "done" : index === activeIndex ? "active" : "pending"
  }));
}

export function pendingBusySteps(labels: string[]): BusyProgressStep[] {
  return labels.map((label, index) => ({ label, status: index === 0 ? "active" : "pending" }));
}

export function doneBusySteps(labels: string[]): BusyProgressStep[] {
  return labels.map((label) => ({ label, status: "done" }));
}

export function accountSyncProgressSteps(): string[] {
  return ["检查 Profile", "确认覆盖", "复制账号数据", "合并偏好", "写入浏览器状态", "完成"];
}

export function accountSyncProgressStepsForTarget(targetProfile: PublicProfile | null): string[] {
  const steps = accountSyncProgressSteps();
  return targetProfile?.running ? [steps[0], "关闭目标", ...steps.slice(1)] : steps;
}

export function extensionSyncProgressSteps(): string[] {
  return ["检查 Profile", "扫描插件", "确认覆盖", "同步插件", "写入配置", "完成"];
}

export function extensionSyncProgressStepsForProfiles(
  sourceProfile: PublicProfile | null,
  targetProfile: PublicProfile | null,
  includeData: boolean
): string[] {
  const steps = extensionSyncProgressSteps();
  const closeSteps = [
    ...(targetProfile?.running ? ["关闭目标"] : []),
    ...(includeData && sourceProfile?.running ? ["关闭源"] : [])
  ];
  return closeSteps.length ? [steps[0], ...closeSteps, ...steps.slice(1)] : steps;
}

export function updateBusyState(patch: Partial<BusyState>): void {
  if (!store.busyState) {
    return;
  }

  store.busyState = {
    ...store.busyState,
    ...patch
  };
  render();
}

export async function withBusy(
  work: () => Promise<unknown>,
  successMessage?: string,
  nextBusyState?: BusyState,
  // 可选的失败拦截：返回 true 表示调用方已自行处理（比如弹出后续确认框），不再走默认的错误 toast。
  handleError?: (message: string, error: unknown) => boolean
): Promise<void> {
  if (store.busy) {
    return;
  }

  store.busy = true;
  store.busyState = nextBusyState || {
    key: "generic",
    message: "正在处理…"
  };
  render();

  try {
    await work();
    if (successMessage) {
      if (store.busyState?.steps?.length) {
        store.busyState = {
          ...store.busyState,
          message: successMessage,
          steps: doneBusySteps(store.busyState.steps.map((step) => step.label))
        };
        render();
      }
      setToast(successMessage);
    }
  } catch (error) {
    // 用户主动终止（OPERATION_CANCELLED）不是错误，用中性提示而非红色报错。
    const message = formatErrorMessage(error);
    if (handleError?.(message, error)) {
      return;
    }
    const cancelled = message.startsWith("已终止同步") || message.startsWith("已取消");
    setToast(message, cancelled ? "normal" : "error");
  } finally {
    store.busy = false;
    store.busyState = null;
    await loadState().catch((error: unknown) => setToast(formatErrorMessage(error), "error"));
  }
}

export async function focusProfileFromUi(profile: PublicProfile): Promise<void> {
  if (store.busy) {
    return;
  }

  store.busy = true;
  store.busyState = {
    key: "focus-profile",
    message: `正在显示 ${profile.name}…`,
    profileId: profile.id
  };
  render();

  try {
    await profileApi().focusProfile(profile.id);
    setToast(`已将 ${emphasizeName(profile.name)} 显示到当前屏幕`);
  } catch (error) {
    setToast(formatErrorMessage(error), "error");
  } finally {
    store.busy = false;
    store.busyState = null;
    render();
    void loadState().catch((error: unknown) => setToast(formatErrorMessage(error), "error"));
  }
}

export function busyStepsKey(steps: BusyProgressStep[] | undefined): string {
  return steps?.map((step) => `${step.label}:${step.status}`).join("|") || "";
}

export function updateBusyProgressDom(): boolean {
  if (!store.busyState) {
    return false;
  }

  const messageNodes = appRoot.querySelectorAll<HTMLElement>("[data-busy-message]");
  if (!messageNodes.length) {
    return false;
  }

  messageNodes.forEach((node) => {
    node.textContent = store.busyState?.message || "";
  });

  const countText = store.busyState.stepIndex && store.busyState.stepCount ? `${store.busyState.stepIndex}/${store.busyState.stepCount}` : "";
  appRoot.querySelectorAll<HTMLElement>("[data-busy-count]").forEach((node) => {
    node.textContent = countText;
  });

  return true;
}
