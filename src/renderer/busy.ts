import { profileApi } from "./api";
import { render } from "./render/render-root";
import { loadState } from "./state-actions";
import { appRoot, store } from "./state";
import { BusyProgressStep, BusyState, PublicProfile, ToastKind } from "./types";
import { escapeHtml, formatErrorMessage } from "./util";

// Toast 文案里需要高亮的名字（如 Profile 名）用这对私有控制符包起来，
// 渲染时整体转义后再把控制符替换成带样式的 <span>，避免 HTML 注入。
export const TOAST_NAME_START = String.fromCharCode(1);
export const TOAST_NAME_END = String.fromCharCode(2);

export function emphasizeName(name: string): string {
  return `${TOAST_NAME_START}${name}${TOAST_NAME_END}`;
}

export function renderToastBody(message: string): string {
  return escapeHtml(message)
    .split(TOAST_NAME_START)
    .join('<span class="toast-name">')
    .split(TOAST_NAME_END)
    .join("</span>");
}

export function setToast(message: string, kind: ToastKind = "normal"): void {
  store.toast = message;
  store.toastKind = kind;
  render();

  window.clearTimeout(store.toastTimer);
  store.toastTimer = window.setTimeout(() => {
    store.toast = null;
    render();
  }, 3200);
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

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function withBusy(work: () => Promise<unknown>, successMessage?: string, nextBusyState?: BusyState): Promise<void> {
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
    await wait(700);
    const isFrontmost = await profileApi().isProfileFrontmost(profile.id);
    if (!isFrontmost) {
      setToast(
        `${emphasizeName(profile.name)} 已请求显示，但 macOS 没有把它放到最前面。请检查辅助功能权限，或先关闭其它 Chrome 实例后重试。`,
        "error"
      );
    }
  } catch (error) {
    setToast(formatErrorMessage(error), "error");
  } finally {
    store.busy = false;
    store.busyState = null;
    await loadState().catch((error: unknown) => setToast(formatErrorMessage(error), "error"));
  }
}

export function isBusyAction(key: string, match: Partial<Omit<BusyState, "key" | "message">> = {}): boolean {
  const activeBusyState = store.busyState;
  if (!activeBusyState || activeBusyState.key !== key) {
    return false;
  }

  return Object.entries(match).every(([field, value]) => activeBusyState[field as keyof BusyState] === value);
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
