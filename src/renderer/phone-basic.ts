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
      <div class="phone-mode-actions phone-install-actions"><button class="primary" data-action="install-phone-app" aria-describedby="phone-enhancement-hint" ${disabled}>${app.connected ? "更新手机 App" : app.unresponsive && app.installation === "installed" ? "重新连接手机 App" : app.installation === "installed" ? "连接手机 App" : "安装到当前手机"}</button><button data-action="phone-apk">获取 APK 文件</button></div>
      <p id="phone-enhancement-hint" class="phone-mode-hint">${escape(disabledReason || (app.connected ? "更新时会打开手机 App，请在手机上确认。" : "也可扫码下载，或将 APK 文件传到手机后手动安装。"))}</p>
    </div><figure class="phone-download-qr"><img src="./assets/profilepilot-android-download.svg" width="144" height="144" alt="ProfilePilot 安卓 App 下载二维码"><figcaption>扫码下载安卓 App<small>GitHub 发布版 · Android 11+</small></figcaption><button data-action="phone-download-copy">复制下载链接</button></figure></div>`;
}

/** The image is a periodically refreshed screenshot, never advertised as video. */
export function openBasicPhone(device: PhoneDevice, onInstall: (id: string) => Promise<void>): void {
  if (currentDialog) { currentDialog.focus(); return; }
  const initial = device.basic;
  if (!initial?.sessionId) return;
  const id = device.id, sessionId = initial.sessionId;
  let state = initial, busy = false, refreshing = false, closing = false, frame: { width: number; height: number; generation: number } | undefined;
  let pointer: { x: number; y: number; at: number; pointerId: number } | undefined;
  const dialog = document.createElement("dialog"); currentDialog = dialog;
  dialog.className = "phone-basic-dialog"; dialog.setAttribute("aria-label", "免安装手机控制");
  dialog.innerHTML = `<header><div><h2>${escape(device.name)} · 免安装${state.mode === "view" ? "查看" : "控制"}</h2><p>截图自动刷新；${state.mode === "view" ? "当前仅查看" : "在画面上点击或拖动"}。暂停和结束由电脑端控制。</p></div><button data-basic-close aria-label="结束并关闭">×</button></header>
    <div class="phone-basic-body"><div class="phone-basic-screen"><img alt="手机当前画面" draggable="false" hidden><span data-basic-placeholder>正在获取手机画面…</span></div>
    <aside><div class="phone-basic-status" role="status"></div><div class="phone-basic-nav"><button data-basic-key="back">返回</button><button data-basic-key="home">主页</button><button data-basic-key="recents">最近应用</button></div>
      <button data-basic-refresh>刷新画面</button><label class="phone-basic-auto"><input type="checkbox" checked>每 2 秒自动刷新</label>
      <button data-basic-pause>暂停</button><button data-basic-close>结束控制</button>
      <div class="phone-basic-upgrade"><strong>需要更多功能？</strong><p>App 提供控件识别、中文填写、手机端暂停和状态同步。</p><button data-basic-install>结束控制并安装 App</button></div>
      <p class="phone-basic-error" role="alert"></p>
    </aside></div>`;
  const screenContainer = dialog.querySelector<HTMLElement>(".phone-basic-screen")!;
  let screen = screenContainer.querySelector<HTMLImageElement>("img")!;
  const error = dialog.querySelector<HTMLElement>(".phone-basic-error")!;
  const automatic = dialog.querySelector<HTMLInputElement>('.phone-basic-auto input')!;
  const active = () => ["viewing", "controlling"].includes(state.phase) && !closing;
  const disable = (button: HTMLButtonElement, unavailable: boolean) => {
    button.disabled = unavailable || busy;
    // Keep the controls visually steady during a read, while still preventing
    // input from racing the capture. Pause and stop remain available.
    button.classList.toggle("phone-refresh-lock", !unavailable && refreshing);
  };
  const update = () => {
    const status = dialog.querySelector<HTMLElement>(".phone-basic-status")!;
    const label = state.phase === "paused" ? "已暂停" : state.phase === "disconnected" ? "连接已断开，请关闭后重新连接" : state.phase === "stopped" ? "会话已结束" : busy && !refreshing ? "正在处理…" : state.mode === "view" ? "仅查看" : "可以操作";
    if (status.textContent !== label) status.textContent = label;
    dialog.querySelectorAll<HTMLButtonElement>("[data-basic-key]").forEach(b => disable(b, !active() || state.mode === "view"));
    const pause = dialog.querySelector<HTMLButtonElement>("[data-basic-pause]")!;
    pause.textContent = state.phase === "paused" ? "继续" : "暂停";
    pause.disabled = !["paused", "viewing", "controlling"].includes(state.phase);
    disable(dialog.querySelector<HTMLButtonElement>("[data-basic-refresh]")!, !active());
    disable(dialog.querySelector<HTMLButtonElement>("[data-basic-install]")!, closing || ["disconnected", "stopped"].includes(state.phase));
    screen.dataset.interactive = String(active() && state.mode === "control" && !!frame && (!busy || refreshing));
    screenContainer.setAttribute("aria-busy", String(refreshing));
  };
  const message = (cause: unknown) => { error.textContent = String((cause as Error).message || cause).replace(/^Error invoking remote method '[^']+': Error: /, ""); };
  async function send(action: PhoneAction): Promise<void> {
    if (busy || !active()) return;
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
      error.textContent = "";
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
  dialog.querySelector("[data-basic-pause]")!.addEventListener("click", () => {
    void window.phones.basicControl(id, state.phase === "paused" ? "resume" : "pause").then(device => { state = device.basic!; frame = undefined; update(); if (active()) void send({ kind: "screenshot" }); }).catch(message);
  });
  dialog.querySelector("[data-basic-refresh]")!.addEventListener("click", () => void send({ kind: "screenshot" }));
  dialog.querySelectorAll<HTMLButtonElement>("[data-basic-key]").forEach(b => b.addEventListener("click", () => void send({ kind: "key", key: b.dataset.basicKey as "back" | "home" | "recents" })));
  dialog.querySelector("[data-basic-install]")!.addEventListener("click", () => void finish().then(() => onInstall(id)).catch(message));
  const point = (e: PointerEvent) => { const r = screen.getBoundingClientRect(); return frame ? { x: Math.max(0, Math.min(frame.width - 1, Math.floor((e.clientX-r.left)/r.width*frame.width))), y: Math.max(0, Math.min(frame.height - 1, Math.floor((e.clientY-r.top)/r.height*frame.height))) } : undefined; };
  screenContainer.addEventListener("pointerdown", e => { if (e.target !== screen || e.button !== 0 || busy || !active() || state.mode !== "control" || !frame) return; e.preventDefault(); const p = point(e)!; pointer = { ...p, at: Date.now(), pointerId: e.pointerId }; screenContainer.setPointerCapture(e.pointerId); });
  screenContainer.addEventListener("pointerup", e => {
    const start = pointer; pointer = undefined; if (!start || start.pointerId !== e.pointerId || !frame || frame.generation !== state.generation) return;
    const end = point(e)!; const distance = Math.hypot(end.x-start.x, end.y-start.y);
    void send(distance < 12 ? { kind: "tap", x: start.x, y: start.y } : { kind: "swipe", x: start.x, y: start.y, toX: end.x, toY: end.y, duration: Math.max(100, Math.min(1500, Date.now()-start.at)) });
  });
  screenContainer.addEventListener("pointercancel", () => { pointer = undefined; });
  const timer = window.setInterval(() => { if (automatic.checked && !pointer && !document.hidden && window.workspacePane?.active !== false) void send({ kind: "screenshot" }); }, 2000);
  dialog.addEventListener("close", () => { clearInterval(timer); unsubscribe(); currentDialog = undefined; dialog.remove(); });
  document.body.append(dialog); dialog.showModal(); update(); void send({ kind: "screenshot" });
}
