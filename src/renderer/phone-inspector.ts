import type { PhoneDevice } from "../shared/phones";
import { phonePresentation } from "../shared/phone-presentation";
import { taskIcon } from "./task-icons";
import { workspaceHidden } from "./workspace-lifecycle";

const esc = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function createPhoneInspector(container: HTMLElement) {
  container.innerHTML = `<header class="phone-inspector-heading"></header>
    <section class="phone-inspector-preview"><div class="phone-inspector-preview-head"><h3>手机画面</h3><button data-action="refresh-phone-screen" title="刷新手机画面" aria-label="刷新手机画面">${taskIcon("refresh")}</button></div>
      <button class="phone-inspector-screen" data-action="enlarge-phone-screen" aria-label="放大手机画面" disabled><img alt="手机当前画面" draggable="false" hidden><span class="phone-inspector-placeholder">${taskIcon("phone")}<span role="status"></span></span></button>
      <p class="phone-inspector-caption"></p></section><section class="phone-inspector-agent"></section><div class="phone-inspector-actions"></div>`;
  const find = <T extends HTMLElement>(selector: string) => container.querySelector<T>(selector)!;
  const placeholder = find<HTMLElement>(".phone-inspector-placeholder");
  const screen = find<HTMLButtonElement>(".phone-inspector-screen");
  const refreshButton = find<HTMLButtonElement>('[data-action="refresh-phone-screen"]');
  let image = find<HTMLImageElement>("img"), device: PhoneDevice | undefined, busy = false;
  let key = "", generation = 0, pending = false, capturedAt = 0, attemptedAt = 0, failure = "";
  let enlarged: { dialog: HTMLDialogElement; image: HTMLImageElement; caption: HTMLParagraphElement; deviceId: string } | undefined;
  let liveTimer: number | undefined;
  const live = () => !!enlarged?.dialog.open;
  const markupCache = new Map<string, string>();
  const html = (selector: string, markup: string) => { if (markupCache.get(selector) !== markup) { find<HTMLElement>(selector).innerHTML = markup; markupCache.set(selector, markup); } };
  const session = () => [device?.basic, device?.state].find(state => state && !["idle", "stopped"].includes(state.phase));
  const ready = () => !!device && device.connection === "device" && !device.pending && !device.visualFollowActive && !device.taskCaptureActive && !["paused", "disconnected"].includes(session()?.phase || "");
  const hint = () => !device ? "选择设备后显示手机画面" : device.connection === "unauthorized" ? "请在手机上确认调试授权"
    : device.connection !== "device" ? device.transport === "emulator" ? "启动模拟器后自动显示画面" : "连接手机后自动显示画面"
    : session()?.phase === "paused" ? "会话已暂停，恢复后更新画面" : session()?.phase === "disconnected" ? "请先结束已断开的会话"
    : device.visualFollowActive ? "视觉跟随期间暂停预览，请在视觉跟随窗口查看画面" : device.taskCaptureActive ? "手机任务期间暂停预览，结束后自动恢复" : device.pending || failure || "正在获取手机画面…";
  const updateScreen = () => {
    placeholder.hidden = !!capturedAt; placeholder.querySelector("[role=status]")!.textContent = hint();
    image.hidden = !capturedAt; screen.disabled = !capturedAt;
    refreshButton.disabled = !ready() || busy || pending;
    const status = workspaceHidden() ? "画面更新已暂停" : !ready() ? hint() : busy ? "正在处理手机操作，稍后继续更新画面" : failure ? `画面更新失败，正在重试：${failure}`
      : capturedAt ? `更新于 ${new Date(capturedAt).toLocaleTimeString()} · ${live() ? "实时更新" : "每 2 秒刷新"}` : "正在获取手机画面…";
    find<HTMLElement>(".phone-inspector-caption").textContent = status;
    if (enlarged) {
      enlarged.caption.textContent = status;
      enlarged.image.hidden = !capturedAt;
      if (!capturedAt) enlarged.image.removeAttribute("src");
      else if (enlarged.image.src !== image.src) enlarged.image.src = image.src;
    }
    // Both views share one capture request. Only an open, visible preview needs
    // the faster cadence; the normal sidebar keeps its existing refresh loop.
    if (live() && !workspaceHidden() && ready() && !busy) {
      liveTimer ??= window.setInterval(() => { void refresh(); }, 500);
    } else if (liveTimer !== undefined) {
      window.clearInterval(liveTimer); liveTimer = undefined;
    }
  };
  async function refresh(force = false) {
    const interval = live() && !failure ? 500 : 2000;
    if (workspaceHidden() || !ready() || busy || pending || document.querySelector('.phone-basic-dialog[open]') || !force && Date.now() - attemptedAt < interval) return;
    const bounds = container.getBoundingClientRect();
    if (!force && !live() && (bounds.top > innerHeight || bounds.bottom < 0)) return;
    const id = device!.id, version = generation; pending = true; attemptedAt = Date.now(); updateScreen();
    try {
      const frame = await window.phones.screen(id);
      if (version !== generation || workspaceHidden()) return;
      if (frame.mime !== "image/png" || !/^[A-Za-z0-9+/=]+$/.test(frame.base64) || !frame.width || !frame.height) throw new Error("手机画面无效，请重试。");
      const src = `data:image/png;base64,${frame.base64}`;
      if (image.src !== src) {
        const next = new Image(); next.alt = image.alt; next.draggable = false; next.src = src; await next.decode();
        if (version !== generation || workspaceHidden()) return;
        if (next.naturalWidth !== frame.width || next.naturalHeight !== frame.height) throw new Error("手机画面尺寸无效，请重试。");
        image.replaceWith(next); image = next;
      }
      capturedAt = frame.capturedAt; failure = "";
    } catch (error) {
      if (version === generation && !workspaceHidden()) failure = (error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, "");
    } finally { pending = false; attemptedAt = Date.now(); updateScreen(); }
  }
  return {
    refresh,
    update(next: PhoneDevice | undefined, working: boolean) {
      if (enlarged && enlarged.deviceId !== next?.id) enlarged.dialog.close();
      device = next; busy = working;
      const state = session();
      const nextKey = JSON.stringify([device?.id, device?.connection, device?.pending, device?.visualFollowActive, device?.taskCaptureActive, state?.instanceId, state?.sessionId, state?.generation, state?.phase, workspaceHidden()]);
      if (nextKey !== key) { key = nextKey; generation++; capturedAt = 0; attemptedAt = 0; failure = ""; image.removeAttribute("src"); }
      container.dataset.deviceId = device?.id || "";
      const name = device ? phonePresentation(device).displayName : "尚未选择设备";
      html(".phone-inspector-heading", `<span class="phone-inspector-avatar">${taskIcon(device?.transport === "emulator" ? "desktop" : "phone")}</span><div><h2>${esc(name)}</h2><p>${device?.transport === "emulator" ? "本机模拟器" : "Android 设备"}</p></div>${device ? `<button data-action="details" data-device-id="${esc(device.id)}" title="设备设置" aria-label="设备设置">${taskIcon("settings")}</button>` : ""}`);
      const label = state ? state.phase === "paused" ? "已暂停" : state.phase === "disconnected" ? "连接已断开" : state.mode === "control" ? "正在操作" : "正在查看" : ready() ? "可供 Agent 操作" : "等待设备连接";
      const isBasic = state === device?.basic;
      const controls = state && device ? `<div class="phone-inspector-session-actions">${state.phase !== "disconnected" ? `<button ${isBasic ? `data-phone-basic-command="${state.phase === "paused" ? "resume" : "pause"}"` : `data-action="${state.phase === "paused" ? "resume" : "pause"}"`} ${busy ? "disabled" : ""}>${state.phase === "paused" ? "继续" : "暂停"}</button>` : ""}<button ${isBasic ? 'data-phone-basic-command="stop"' : 'data-action="stop"'} ${busy ? "disabled" : ""}>结束会话</button></div>` : "";
      html(".phone-inspector-agent", `<h3>当前 Agent</h3>${state ? `<strong>${esc(state.controller || "本机用户")}</strong>` : ""}<p class="phone-inspector-session" data-connected="${ready()}"><i></i>${label}</p>${state?.task ? `<p>${esc(state.task)}</p>` : ""}${controls}`);
      html(".phone-inspector-actions", !device ? "" : device.connection !== "device" ? `<button data-action="${device.transport === "emulator" ? "emulator" : "details"}" data-device-id="${esc(device.id)}">${device.transport === "emulator" ? "启动模拟器" : "连接设置"}</button>`
        : state && !isBasic ? "" : `<button data-action="${state && state.phase !== "disconnected" ? "basic-open" : "phone-operate"}" ${busy || state?.phase === "disconnected" ? "disabled" : ""}>${state ? "打开操作窗口" : "操作手机"}</button>`);
      if (device?.connection === "device") {
        const actions = find<HTMLElement>(".phone-inspector-actions");
        let camera = actions.querySelector<HTMLButtonElement>('[data-action="screen-camera"]');
        if (!camera) { camera = document.createElement("button"); camera.dataset.action = "screen-camera"; actions.append(camera); }
        camera.textContent = device.screenCamera?.active ? "屏幕摄像头运行中" : "屏幕摄像头"; camera.disabled = busy;
      }
      updateScreen(); void refresh();
    },
    enlarge() {
      if (!capturedAt || !device || live()) return;
      const dialog = document.createElement("dialog"); dialog.className = "phone-image-dialog"; dialog.setAttribute("aria-label", "手机画面");
      const button = document.createElement("button"); button.textContent = "×"; button.setAttribute("aria-label", "关闭大图"); button.onclick = () => dialog.close();
      const preview = new Image(); preview.src = image.src; preview.alt = image.alt; preview.draggable = false;
      const caption = document.createElement("p");
      enlarged = { dialog, image: preview, caption, deviceId: device.id };
      dialog.append(button, preview, caption);
      dialog.addEventListener("close", () => {
        if (enlarged?.dialog === dialog) { enlarged = undefined; updateScreen(); }
        dialog.remove();
      });
      document.body.append(dialog); dialog.showModal(); updateScreen(); void refresh(true);
    }
  };
}
