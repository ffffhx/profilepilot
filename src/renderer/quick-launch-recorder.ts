import { formatQuickLaunchShortcut, shortcutFromKeyEvent } from "../shared/quick-launch-shortcut";
import { profileApi } from "./api";
import { emphasizeName, setToast, withBusy } from "./busy";
import { appRoot, store } from "./state";

export function installQuickLaunchRecorder(): void {
  let active: HTMLInputElement | null = null;
  let ready = false;

  function stop(): void {
    active = null;
    ready = false;
    void profileApi().setQuickLaunchRecording(false).catch(() => {});
  }

  function save(id: string | undefined, shortcut: string | null): void {
    const profile = store.state?.profiles.find((item) => item.id === id);
    if (!profile || store.busy) return;
    active?.blur();
    stop();
    if ((profile.quickLaunchShortcut ?? null) === shortcut) return;
    store.openProfileMenuId = null;
    const label = formatQuickLaunchShortcut(shortcut, store.state?.platform || "win32");
    void withBusy(async () => {
      store.state = await profileApi().setQuickLaunchShortcut(profile.id, shortcut);
    }, shortcut ? `已把 ${label} 绑定到 ${emphasizeName(profile.name)}` : `已清除 ${emphasizeName(profile.name)} 的全局快捷键`, {
      key: "quick-launch-shortcut", message: "正在保存快捷键…", profileId: profile.id
    });
  }

  appRoot.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest("[data-quick-launch-editor]")) return;
    event.stopPropagation();
    const clear = target.closest<HTMLElement>("[data-clear-quick-launch]");
    if (clear) save(clear.dataset.id, null);
  }, true);

  appRoot.addEventListener("focusin", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches("[data-quick-launch-input]")) return;
    active = input;
    ready = false;
    input.placeholder = "请按下组合键";
    void profileApi().setQuickLaunchRecording(true).then(() => {
      if (active === input) ready = true;
    }).catch(() => { input.blur(); setToast("无法开始录入快捷键，请重试", "error"); });
  });
  appRoot.addEventListener("focusout", (event) => {
    if (active && event.target === active) {
      active.placeholder = "点击后按下组合键";
      stop();
    }
  });
  window.addEventListener("blur", () => { active?.blur(); if (active) stop(); });
  window.addEventListener("pagehide", stop);

  appRoot.addEventListener("keydown", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches("[data-quick-launch-input]")) return;
    event.stopImmediatePropagation();
    const modified = event.ctrlKey || event.altKey || event.metaKey || event.shiftKey;
    if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) return;
    event.preventDefault();
    if (event.key === "Escape" && !modified) { input.blur(); return; }
    if (event.repeat || event.isComposing || store.busy || !ready) return;
    if (["Backspace", "Delete"].includes(event.key) && !modified) { save(input.dataset.id, null); return; }
    if (["Control", "Alt", "Shift", "Meta", "AltGraph", "Dead", "Process", "Unidentified"].includes(event.key)) return;
    const shortcut = shortcutFromKeyEvent(event, store.state?.platform || "win32");
    if (!shortcut) {
      const example = store.state?.platform === "darwin" ? "⌘ + ⌥ + K" : "Ctrl + Alt + K";
      setToast(`请按下组合键（如 ${example}）或 F1–F24 功能键`, "error");
      return;
    }
    save(input.dataset.id, shortcut);
  }, true);
}
