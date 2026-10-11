import type { PhoneAction, PhoneDevice, PhonesSnapshot } from "../shared/phones";
import { phoneEnhancementPresentation } from "../shared/phone-presentation";
import { taskIcon } from "./task-icons";

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
let currentDialog: HTMLDialogElement | undefined;
export const PHONE_APP_DOWNLOAD_URL = "https://github.com/ffffhx/profilepilot/releases/latest/download/ProfilePilot-android.apk";

export function phoneModeChoices(device: PhoneDevice | undefined, disabledReason: string): string {
  const disabled = disabledReason ? `disabled title="${escape(disabledReason)}"` : "";
  return `<section class="phone-card phone-control-section phone-basic-section" aria-label="免安装控制">
    <span class="phone-basic-icon">${taskIcon("phone")}</span><div class="phone-basic-copy"><header class="phone-mode-heading"><h3>免安装控制</h3><span>无需手机 App</span></header>
    <p class="phone-mode-description">连接手机即可查看画面、点击和滑动，不用安装 App。</p>
    ${disabledReason ? `<p id="phone-mode-hint" class="phone-mode-hint" role="status">${escape(disabledReason)}</p>` : ""}</div>
    <button class="primary" data-action="basic-control" ${disabledReason ? 'aria-describedby="phone-mode-hint"' : ""} ${disabled}>查看手机</button>
  </section>`;
}

export function phoneEnhancementContent(device: PhoneDevice | undefined, disabledReason: string, permissions: string): string {
  const disabled = disabledReason ? `disabled title="${escape(disabledReason)}"` : "";
  const app = phoneEnhancementPresentation(device);
  return `<header class="phone-mode-heading"><h3>控制增强</h3><span>可选</span></header>
    <p class="phone-mode-description">安装 ProfilePilot 安卓 App，开启控件识别、中文填写、手机端暂停和状态同步。</p>
    <div class="phone-enhancement-body"><div class="phone-enhancement-info">
      <div class="phone-app-status-panel"><header><strong>ProfilePilot 安卓 App</strong><span class="phone-route-badge" data-tone="${app.tone}" data-app-installation="${app.installation}">${app.label}</span><button class="phone-text-button" data-action="inspect-app" ${!device || device.transport === "cloud" ? 'disabled title="请先通过 USB 或 Wi-Fi 连接手机"' : ""}>重新检测</button></header>
      <p class="phone-mode-hint" role="status">${app.note}</p><div class="phone-permissions" aria-label="增强功能权限">${permissions}</div></div>
      <div class="phone-mode-actions phone-install-actions"><button class="primary" data-action="install-phone-app" aria-describedby="phone-enhancement-hint" hidden ${disabled}>${app.connected ? "更新手机 App" : app.unresponsive && app.installation === "installed" ? "重新连接手机 App" : app.installation === "installed" ? "连接手机 App" : "安装到当前手机"}</button><button data-action="phone-apk">获取 APK 文件</button></div>
      <p id="phone-enhancement-hint" class="phone-mode-hint" hidden>${escape(disabledReason || (app.connected ? "更新时会打开手机 App，请在手机上确认。" : "也可扫码下载，或将 APK 文件传到手机后手动安装。"))}</p>
    </div><figure class="phone-download-qr"><img src="./assets/profilepilot-android-download.svg" width="144" height="144" alt="ProfilePilot 安卓 App 下载二维码"><figcaption>扫码下载安卓 App<small>GitHub 发布版 · Android 11+</small></figcaption><button data-action="phone-download-copy">复制下载链接</button></figure></div>`;
}

/** The image is a periodically refreshed screenshot, never advertised as video. */
export function openBasicPhone(device: PhoneDevice, onInstall: (id: string) => Promise<void>): void {
  if (currentDialog) { currentDialog.focus(); return; }
  const initial = device.basic;
  if (!initial?.sessionId) return;
  const id = device.id, sessionId = initial.sessionId;
  let state = initial, busy = false, refreshing = false, switching = false, closing = false, frame: { width: number; height: number; generation: number } | undefined;
  let pointer: { x: number; y: number; at: number; pointerId: number } | undefined;
  const dialog = document.createElement("dialog"); currentDialog = dialog;
  dialog.className = "phone-basic-dialog"; dialog.setAttribute("aria-label", "免安装手机控制");
  dialog.innerHTML = `<header><div><h2>${escape(device.name)} · 手机画面</h2><p class="phone-basic-status" role="status"></p></div><div class="phone-basic-toolbar"><div class="phone-basic-modes" role="group" aria-label="手机交互模式"><button data-basic-mode="view" aria-pressed="false">查看</button><button data-basic-mode="control" aria-pressed="false">操作</button></div><button data-basic-close aria-label="结束并关闭" title="结束并关闭">×</button></div></header>
    <div class="phone-basic-body"><div class="phone-basic-screen"><img alt="手机当前画面" draggable="false" hidden><span data-basic-placeholder>正在获取手机画面…</span></div>
      <p class="phone-basic-error" role="alert" hidden></p>
      <div class="phone-basic-upgrade"><div><strong>需要更多功能？</strong><p>App 提供控件识别、中文填写、手机端暂停和状态同步。</p></div><button data-basic-install>结束会话并安装 App</button></div>
    </div>`;
  const screenContainer = dialog.querySelector<HTMLElement>(".phone-basic-screen")!;
  let screen = screenContainer.querySelector<HTMLImageElement>("img")!;
  const error = dialog.querySelector<HTMLElement>(".phone-basic-error")!;
  const active = () => ["viewing", "controlling"].includes(state.phase) && !closing && !switching;
  const disable = (button: HTMLButtonElement, unavailable: boolean) => {
    button.disabled = unavailable || busy || switching;
    // Keep the controls visually steady during a read, while still preventing
    // input from racing the capture. Mode switching and close remain available.
    button.classList.toggle("phone-refresh-lock", !unavailable && refreshing);
  };
  const update = () => {
    const status = dialog.querySelector<HTMLElement>(".phone-basic-status")!;
    const label = state.phase === "paused" ? "已暂停，选择查看或操作以继续。" : state.phase === "disconnected" ? "连接已断开，请关闭后重新连接。" : state.phase === "stopped" ? "会话已结束。" : switching ? "正在切换模式…" : state.mode === "view" ? "查看态 · 画面每 2 秒自动刷新，切换至操作可点击或拖动。" : "操作态 · 在画面上点击或拖动，画面每 2 秒自动刷新。";
    if (status.textContent !== label) status.textContent = label;
    dialog.querySelectorAll<HTMLButtonElement>("[data-basic-mode]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.basicMode === state.mode));
      button.disabled = closing || switching || !["paused", "viewing", "controlling"].includes(state.phase);
      button.textContent = `${state.phase === "paused" ? "继续" : ""}${button.dataset.basicMode === "view" ? "查看" : "操作"}`;
    });
    disable(dialog.querySelector<HTMLButtonElement>("[data-basic-install]")!, closing || ["disconnected", "stopped"].includes(state.phase));
    screen.dataset.interactive = String(active() && state.mode === "control" && !!frame && (!busy || refreshing));
    screenContainer.setAttribute("aria-busy", String(refreshing));
  };
  const message = (cause: unknown) => { error.hidden = false; error.textContent = String((cause as Error).message || cause).replace(/^Error invoking remote method '[^']+': Error: /, ""); };
  async function send(action: PhoneAction): Promise<void> {
    if (busy || !active() || (action.kind !== "screenshot" && state.mode !== "control")) return;
    const generation = state.generation; busy = true; refreshing = action.kind === "screenshot"; update();
    try {
      const response = await window.phones.basicPerform({ id, sessionId, generation, requestId: crypto.randomUUID(), action });
      if (closing || state.generation !== generation || !active()) return;
      state = response.state;
      if (action.kind === "screenshot") {
        const result = response.result as { mime: string; base64: string; width: number; height: number };
        if (result.mime !== "image/png" || !/^[A-Za-z0-9+/=]+$/.test(result.base64) || !result.width || !result.height) throw new Error("手机画面无效。");
        const src = `data:image/png;base64,${result.base64}`;
        if (src !== screen.src) {
          // Decode off-screen; the current image remains painted even on a
          // slow connection or decode failure. Commit a fully decoded element
          // in one DOM operation, without ever clearing the visible source.
          const next = new Image(); next.alt = screen.alt; next.draggable = false;
          next.src = src;
          await next.decode();
          if (closing || state.generation !== generation || !active() || !dialog.isConnected) return;
          if (next.naturalWidth !== result.width || next.naturalHeight !== result.height) throw new Error("手机画面尺寸无效。");
          screen.replaceWith(next); screen = next;
        }
        frame = { width: result.width, height: result.height, generation };
        dialog.querySelector<HTMLElement>("[data-basic-placeholder]")!.hidden = true;
      } else frame = undefined;
      error.textContent = ""; error.hidden = true;
    } catch (cause) { if (!closing && state.generation === generation && active()) { frame = undefined; message(cause); } }
    finally {
      busy = false; refreshing = false; update();
      if (active() && state.generation !== generation) void send({ kind: "screenshot" });
    }
    if (action.kind !== "screenshot" && active()) await send({ kind: "screenshot" });
  }
  async function finish(): Promise<void> {
    if (closing) return; closing = true; frame = undefined; pointer = undefined; update();
    try {
      const latest = (await window.phones.snapshot()).devices.find(d => d.id === id)?.basic;
      if (latest?.sessionId === sessionId && latest.phase !== "stopped") await window.phones.basicControl(id, "stop");
      dialog.close();
    } catch (cause) { closing = false; message(cause); update(); throw cause; }
  }
  const unsubscribe = window.phones.onChanged((snapshot: PhonesSnapshot) => {
    const next = snapshot.devices.find(d => d.id === id)?.basic;
    if (!next || next.sessionId !== sessionId) { state = { ...state, phase: "stopped" }; frame = undefined; }
    else { if (next.generation !== state.generation) { frame = undefined; pointer = undefined; } state = next; }
    update();
  });
  dialog.querySelectorAll("[data-basic-close]").forEach(b => b.addEventListener("click", () => void finish().catch(() => {})));
  dialog.addEventListener("cancel", e => { e.preventDefault(); void finish().catch(() => {}); });
  dialog.querySelectorAll<HTMLButtonElement>("[data-basic-mode]").forEach(button => button.addEventListener("click", () => {
    const mode = button.dataset.basicMode as "view" | "control";
    if (closing || switching || !["viewing", "controlling", "paused"].includes(state.phase) || (mode === state.mode && state.phase !== "paused")) return;
    switching = true; frame = undefined; pointer = undefined; update();
    void window.phones.basicSetMode({ id, sessionId, generation: state.generation, mode }).then(device => {
      // State events are authoritative if a pause/stop overtakes the reply.
      if (!closing && device.basic?.sessionId === sessionId && device.basic.generation >= state.generation) state = device.basic;
      error.textContent = ""; error.hidden = true;
    }).catch(message).finally(() => {
      switching = false; update(); if (active()) void send({ kind: "screenshot" });
    });
  }));
  dialog.querySelector("[data-basic-install]")!.addEventListener("click", () => void finish().then(() => onInstall(id)).catch(message));
  const point = (e: PointerEvent) => { const r = screen.getBoundingClientRect(); return frame ? { x: Math.max(0, Math.min(frame.width - 1, Math.floor((e.clientX-r.left)/r.width*frame.width))), y: Math.max(0, Math.min(frame.height - 1, Math.floor((e.clientY-r.top)/r.height*frame.height))) } : undefined; };
  screenContainer.addEventListener("pointerdown", e => { if (e.target !== screen || e.button !== 0 || busy || !active() || state.mode !== "control" || !frame) return; e.preventDefault(); const p = point(e)!; pointer = { ...p, at: Date.now(), pointerId: e.pointerId }; screenContainer.setPointerCapture(e.pointerId); });
  screenContainer.addEventListener("pointerup", e => {
    const start = pointer; pointer = undefined; if (!start || start.pointerId !== e.pointerId || !active() || state.mode !== "control" || !frame || frame.generation !== state.generation) return;
    const end = point(e)!; const distance = Math.hypot(end.x-start.x, end.y-start.y);
    void send(distance < 12 ? { kind: "tap", x: start.x, y: start.y } : { kind: "swipe", x: start.x, y: start.y, toX: end.x, toY: end.y, duration: Math.max(100, Math.min(1500, Date.now()-start.at)) });
  });
  screenContainer.addEventListener("pointercancel", () => { pointer = undefined; });
  const timer = window.setInterval(() => { if (!pointer && !document.hidden && window.workspacePane?.active !== false) void send({ kind: "screenshot" }); }, 2000);
  dialog.addEventListener("close", () => { clearInterval(timer); unsubscribe(); currentDialog = undefined; dialog.remove(); });
  document.body.append(dialog); dialog.showModal(); update(); void send({ kind: "screenshot" });
}
