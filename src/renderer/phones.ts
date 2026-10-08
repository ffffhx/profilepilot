import { type PhoneDevice, type PhoneSetting, type PhonesSnapshot } from "../shared/phones";
import { groupPhoneDevices } from "../shared/phone-devices";
import { phoneConnectionPresentation, phonePresentation, type PhoneRoutePresentation, type PhoneSettingRow } from "../shared/phone-presentation";
import { workspaceIdentityBar, workspaceSwitcher, refreshWorkspaceSwitcher } from "./workspace-switcher";
import { taskIcon } from "./task-icons";
import { createMobileConnections } from "./mobile-connections";
import { openPhoneWireless } from "./phone-wireless";
import { openPhoneCloud } from "./phone-cloud";
import { openPhoneEmulator } from "./phone-emulator";

const root = document.getElementById("phones")!;
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const shapes = {
  wifi: '<path d="M3 8a15 15 0 0 1 18 0M6 12a10 10 0 0 1 12 0M9 16a5 5 0 0 1 6 0M12 20h.01"/>',
  accessibility: '<circle cx="12" cy="4" r="2"/><path d="m4 8 8 2 8-2M12 10v5m0 0-5 7m5-7 5 7M8 9v5M16 9v5"/>',
  overlay: '<rect x="8" y="3" width="13" height="13" rx="2"/><path d="M16 19v2H3V8h2"/>',
  notifications: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  developerOptions: '<path d="m7 6-5 6 5 6m10-12 5 6-5 6M14 3l-4 18"/>',
  usbDebugging: '<path d="M12 21V3m-3 3 3-3 3 3M12 16l6-4V8M12 13 6 9V6"/><circle cx="6" cy="4" r="2"/><path d="M16 5h4v3h-4z"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M19.5 11a7.5 7.5 0 0 0-13-5M4.5 13a7.5 7.5 0 0 0 13 5"/>',
  pause: '<path d="M8 5v14M16 5v14"/>'
};
const icon = (name: keyof typeof shapes | "wirelessDebugging") => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name === "wirelessDebugging" ? "wifi" : name]}</svg>`;
let snapshot: PhonesSnapshot = { devices: [], adbAvailable: false, error: "", computer: "" };
let selected = sessionStorage.getItem("phone-selected") || "", busy = false, key = "", loaded = false;
let image: { id: string; instanceId: string; src: string; at: number } | null = null;
let noticeTimer: number;
let pickerOptions = "";

root.innerHTML = `${workspaceSwitcher("phones")}${workspaceIdentityBar()}<main class="phone-shell"><header class="phone-topbar"><div><h1>手机</h1><p>查看手机与这台电脑的连接状态</p></div><label class="phone-picker" hidden><span class="sr-only">选择手机</span>${taskIcon("phone")}<select name="phoneDevice" aria-label="选择手机"></select></label></header><div class="phone-content" aria-busy="true"></div></main>`;
refreshWorkspaceSwitcher();

const openMobileConnections = createMobileConnections();
function usb(): void {
  const dialog = document.createElement("dialog");
  dialog.className = "phone-connect-dialog phone-usb-dialog";
  dialog.setAttribute("aria-label", "通过 USB 连接");
  dialog.innerHTML = `<header><h2>通过 USB 连接</h2><button data-close aria-label="关闭 USB 连接窗口">×</button></header><p>用支持数据传输的 USB 线连接手机与电脑。</p><div data-usb-help><ol><li>在手机上开启开发者选项和 USB 调试。</li><li>连接数据线，解锁手机并允许 USB 调试。</li><li>识别后，手机会自动出现在设备列表中；选择手机，按提示连接手机 App。</li></ol><p>Windows 无法识别时，请检查手机厂商的 USB 驱动；macOS 通常无需额外驱动。</p></div><footer><button class="primary" data-close>查看设备</button></footer>`;
  dialog.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => dialog.close()));
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog); dialog.showModal();
}
function cloud(): void {
  openPhoneCloud(id => { selected = id; image = null; void run(async () => {}); });
}
function emulator(): void {
  openPhoneEmulator(device => {
    selected = device.id; sessionStorage.setItem("phone-selected", selected); image = null;
    void run(async () => {});
  });
}
function wireless(): void {
  openPhoneWireless((device, prepare) => {
    selected = device.id; sessionStorage.setItem("phone-selected", selected); image = null;
    void run(async () => { if (prepare) await window.phones.prepare(device.id); });
  }, current()?.transport === "emulator" ? undefined : current()?.id);
}
function current(): PhoneDevice | undefined { return snapshot.devices.find(device => device.id === selected); }
function notice(text: string, error = false): void {
  const element = document.getElementById("phone-message")!;
  element.textContent = text; element.hidden = false; element.dataset.error = String(error);
  element.setAttribute("role", error ? "alert" : "status"); clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => element.hidden = true, error ? 12000 : 4500);
}
function settingsRows(rows: PhoneSettingRow[], canSetup: boolean, subject = "手机"): string {
  return rows.map(row => `<div class="phone-setting" data-setting="${row.key}"><div class="phone-setting-info"><span class="phone-setting-icon">${icon(row.key)}</span><div><span class="phone-setting-name">${row.label}</span>${row.description ? `<p>${row.description}</p>` : ""}</div></div><div class="phone-setting-result"><span class="phone-setting-status" data-status="${row.status}" ${row.status === "unknown" ? `title="${esc(row.description || `${subject}尚未返回此开关的当前状态`)}"` : ""}>${row.status === "enabled" ? taskIcon("check") : ""}${row.value}</span>${row.status === "disabled" ? `<button class="phone-text-button" data-setting-open="${row.key}" ${canSetup && !busy ? "" : `disabled title="请先建立控制连接并结束当前任务，再打开${subject}设置"`}>去开启</button>` : ""}</div></div>`).join("");
}
function routeCard(route: PhoneRoutePresentation, canSetup: boolean, occupied: boolean): string {
  const name = route.transport === "usb" ? "USB" : "Wi-Fi";
  const unavailable = busy || occupied || !!route.device?.pending;
  const tone = route.connected || route.detected ? "ready" : route.condition === "blocked" || route.unauthorized ? "warning" : "neutral";
  const action = route.connected ? `<span class="phone-route-done">${taskIcon("check")}已连接这台电脑</span>`
    : route.detected ? `<button class="primary" data-connect-route="${esc(route.device!.id)}" ${unavailable ? "disabled" : ""}>通过 ${name} 连接手机 App</button>`
    : `<button class="${route.transport === "wifi" ? "primary" : "phone-text-button"}" data-action="${route.transport}" ${unavailable && route.transport === "wifi" ? "disabled" : ""}>${route.transport === "wifi" ? "通过 Wi-Fi 连接" : "查看 USB 连接步骤"}</button>`;
  return `<section class="phone-route" data-route="${route.transport}"><header>${icon(route.transport === "usb" ? "usbDebugging" : "wifi")}<h3>${name}</h3><span class="phone-route-badge" data-tone="${tone}">${route.label}</span></header>${settingsRows([{ ...route.setting, description: "" }], canSetup)}<p class="phone-route-note">${esc(route.setting.status === "unknown" && route.setting.description ? route.setting.description : route.note)}</p><footer>${action}</footer></section>`;
}
function options(device?: PhoneDevice): string {
  return `<details class="phone-options" data-phone-options><summary>设备设置</summary><div>
    ${device && device.transport !== "cloud" ? '<button class="phone-text-button" data-action="rename">修改设备名称</button>' : ""}
    <button class="phone-text-button" data-action="cloud-link">未连接电脑时也同步手机状态</button>
    ${device?.cloud?.channelId ? '<button class="phone-text-button" data-action="cloud-forget">移除此状态同步</button>' : ""}
    <button class="phone-text-button" data-action="wifi">连接其他手机</button>
    <button class="phone-text-button" data-action="emulator">使用本机模拟器</button>
    ${openMobileConnections ? '<button class="phone-text-button" data-action="mobile">用手机管理电脑任务</button>' : ""}
  </div></details>`;
}
function render(): void {
  const groups = groupPhoneDevices(snapshot.devices, selected);
  const group = groups.find(item => item.routes.some(route => route.id === selected)) || groups[0];
  selected = group?.device.id || "";
  if (selected) sessionStorage.setItem("phone-selected", selected);
  const device = current(), status = group && phoneConnectionPresentation(group), view = status?.view;
  if (image && (!device || !status?.connected || !view?.directKnown || image.id !== device.id || image.instanceId !== device.state?.instanceId)) image = null;
  const nextKey = JSON.stringify([snapshot.devices.map(({ confirmedAt, ...rest }) => rest), snapshot.error, snapshot.adbAvailable, selected, busy, image?.at, view?.directKnown, view?.known, status?.condition, status?.routes.map(route => route.connected), loaded]);
  if (nextKey === key) return; key = nextKey;
  const activeElement = document.activeElement;
  const focusedAction = activeElement instanceof HTMLButtonElement && root.contains(activeElement) ? activeElement.dataset.action : undefined;
  const optionsOpen = root.querySelector<HTMLDetailsElement>("[data-phone-options]")?.open;
  const picker = root.querySelector<HTMLSelectElement>('[name="phoneDevice"]')!;
  picker.parentElement!.hidden = !groups.length;
  const items = groups.map(item => `<option value="${esc(item.device.id)}">${esc(phonePresentation(item.device).displayName)}</option>`).join("");
  if (items !== pickerOptions) { picker.innerHTML = items; pickerOptions = items; }
  picker.value = selected; picker.disabled = busy;
  const content = root.querySelector<HTMLElement>(".phone-content")!;
  content.setAttribute("aria-busy", String(busy || !loaded));
  if (!device || !view || !status) {
    content.innerHTML = `<section class="phone-empty phone-card">${taskIcon("phone")}<h2>${loaded ? "添加你的第一台手机" : "正在查找手机…"}</h2><p>${loaded ? "用 USB 数据线或 Wi-Fi 连接。添加后，同一台手机的连接与权限会显示在一起。" : "正在读取设备连接状态"}</p>${loaded ? '<div class="phone-empty-actions"><button data-action="usb">通过 USB 连接</button><button class="primary" data-action="wifi">通过 Wi-Fi 连接</button></div><button class="phone-text-button" data-action="cloud-link">手机不在身边？先同步手机状态</button>' : ""}${snapshot.error ? `<p class="phone-error" role="alert">${esc(snapshot.error)}</p>` : ""}</section>${loaded ? options() : ""}`;
  } else {
    const state = device.state;
    const disabled = busy || !!device.pending ? "disabled" : "";
    const hasTask = view.active || view.paused;
    const taskLabel = view.paused ? "任务已暂停" : `${state?.controller || "Agent"}${state?.mode === "view" ? " 正在查看屏幕" : " 正在操作"}`;
    const summary = view.permissionsReady ? "全部已开启" : view.missing ? `${view.missing} 项未就绪` : "等待确认";
    const fallbackError = device.error && !["手机连接已断开。", "ADB 连接离线。"].includes(device.error) ? device.error : "";
    const previewNote = !status.connected ? "连接后，可查看手机画面" : view.paused ? "任务已暂停，继续后可查看画面" : view.locked ? "请先解锁手机，再查看画面" : !view.permissionsReady ? "控制权限就绪后，可查看画面" : "画面按需获取";
    content.innerHTML = `<section class="phone-card phone-device-card" data-connected="${status.connected}" aria-label="手机连接状态">
      <header class="phone-device-header"><div class="phone-heading"><span class="phone-device-icon">${taskIcon("phone")}</span><div><h2>${esc(view.displayName)}</h2><p>${view.emulator ? "本机虚拟设备" : "Android 手机"}</p></div></div><span class="phone-updated"></span></header>
      <div class="phone-summary">
        <section class="phone-summary-item"><h3>是否已连接电脑</h3><div class="phone-connection" data-ready="${status.connected}" role="status"><span class="phone-summary-symbol">${status.connected ? taskIcon("check") : '<span class="phone-dot"></span>'}</span><strong>${status.connected ? "已连接" : "未连接"}</strong></div><p class="phone-connection-note">${esc(status.connectionNote)}</p></section>
        <section class="phone-summary-item"><h3>权限与调试准备</h3><div class="phone-readiness" data-condition="${status.condition}" role="status"><span class="phone-summary-symbol">${status.condition === "ready" ? taskIcon("check") : '<span class="phone-dot"></span>'}</span><strong>${status.label}</strong></div><p>${esc(status.note)}</p></section>
      </div>
      ${hasTask ? `<div class="phone-task-strip" data-paused="${view.paused}"><div class="phone-task-heading"><span class="phone-dot"></span><strong>${esc(taskLabel)}</strong><span data-elapsed></span></div><p>${esc(state?.task || "手机会话")}</p><div class="phone-task-actions">${view.paused ? `<button data-action="resume" ${disabled}>继续任务</button>` : `<button data-action="pause" ${disabled}>${icon("pause")}暂停</button>`}<button data-action="stop" ${disabled}>结束任务</button></div></div>` : ""}
      ${(device.transport !== "cloud" && snapshot.error) || fallbackError ? `<p class="phone-error" role="alert">${esc((device.transport !== "cloud" && snapshot.error) || fallbackError)}</p>` : ""}
      ${view.emulator ? `<section class="phone-emulator-connection"><p>${esc(view.note)}</p>${!status.connected ? `<button class="primary" ${device.connection === "device" ? `data-connect-route="${esc(device.id)}"` : 'data-action="emulator"'} ${disabled}>${device.connection === "device" ? "连接模拟器 App" : "启动 / 连接模拟器"}</button>` : ""}</section>`
        : `<section class="phone-methods" aria-label="连接方式"><header><h3>连接方式</h3><p>USB 或 Wi-Fi，任意一种就绪即可连接</p></header><div class="phone-route-grid">${status.routes.map(route => routeCard(route, view.canSetup, status.occupied)).join("")}</div><div class="phone-developer-setting">${settingsRows(view.settings.filter(row => row.key === "developerOptions"), view.canSetup)}</div></section>`}
      <section class="phone-permission-group" aria-label="控制所需权限"><header><h3>控制所需权限</h3><span data-ready="${view.permissionsReady}" data-missing="${!!view.missing}">${summary}</span></header>${view.emulator && !view.known ? '<p class="phone-unavailable-note">连接模拟器及其中的 ProfilePilot App 后，再检测控制权限。</p>' : `<div class="phone-permissions">${settingsRows(view.permissions, view.canSetup, view.subject)}</div>`}</section>
      <footer class="phone-screen-bar"><span>${taskIcon("phone")}${previewNote}</span><button class="phone-text-button" data-action="screenshot" ${disabled} ${view.canPreview ? "" : "disabled"}>${icon("refresh")}${image ? "刷新画面" : "查看手机画面"}</button></footer>
      ${image ? `<section class="phone-preview"><button class="phone-screen-image" data-action="enlarge" aria-label="放大${view.subject}画面"><img src="${image.src}" alt="${esc(device.name)}最近一次的画面" draggable="false"></button><p>采集于 ${new Date(image.at).toLocaleTimeString()} · 非实时画面</p></section>` : ""}
      ${!view.known ? `<p class="phone-status-note">${device.cloud ? "手机状态已过期，等待重新上报后确认权限。" : "尚未收到手机状态。连接手机 App，或在设备设置中开启状态同步。"}</p>` : ""}
    </section>${options(device)}`;
  }
  if (optionsOpen) { const details = root.querySelector<HTMLDetailsElement>("[data-phone-options]"); if (details) details.open = true; }
  if (busy) content.querySelectorAll<HTMLButtonElement>("button").forEach(button => button.disabled = true);
  if (focusedAction) root.querySelector<HTMLButtonElement>(`[data-action="${focusedAction}"]`)?.focus({ preventScroll: true });
  updateElapsed();
}
function updateElapsed(): void {
  const device = current(), view = device && phonePresentation(device), updated = root.querySelector(".phone-updated");
  if (updated && device && view) {
    const at = view.directKnown ? device.confirmedAt : device.cloud?.reportedAt;
    const seconds = at ? Math.max(0, Math.floor((Date.now() - at) / 1000)) : 0;
    updated.textContent = !view.known ? at ? `最后上报 ${new Date(at).toLocaleTimeString()}` : "等待手机更新" : `手机状态 · ${seconds < 15 ? "刚刚更新" : `${seconds} 秒前更新`}`;
  }
  const element = root.querySelector("[data-elapsed]"), start = current()?.state?.startedAt;
  if (element && start) { const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000)); element.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
}
async function run(work: () => Promise<unknown>): Promise<void> {
  if (busy) return; busy = true; render();
  try { await work(); }
  catch (error) { notice((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ""), true); }
  finally { try { snapshot = await window.phones.snapshot(); } catch { /* retain the latest event snapshot */ } busy = false; render(); }
}
async function capture(device: PhoneDevice): Promise<void> {
  const response = await window.phones.preview(device.id);
  const result = response.result as { mime?: string; base64?: string; width?: number; height?: number };
  if (result?.mime !== "image/jpeg" || typeof result.base64 !== "string" || !/^[A-Za-z0-9+/=\r\n]+$/.test(result.base64) || !result.width || !result.height || result.width < 0 || result.height < 0) throw new Error("手机画面无效，请重新查看连接状态。");
  if (selected === device.id) image = { id: device.id, instanceId: response.state.instanceId, src: `data:image/jpeg;base64,${result.base64}`, at: Date.now() };
}
root.addEventListener("change", event => {
  const input = event.target;
  if (!(input instanceof HTMLSelectElement) || input.name !== "phoneDevice" || busy || !snapshot.devices.some(device => device.id === input.value)) return;
  selected = input.value; image = null; render();
});
root.addEventListener("click", event => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button"); if (!button || button.disabled || busy) return;
  const action = button.dataset.action;
  if (action === "cloud-link") { cloud(); return; }
  if (action === "usb") { usb(); return; }
  if (action === "wifi") { wireless(); return; }
  if (action === "emulator") { emulator(); return; }
  if (action === "mobile") { void openMobileConnections?.(); return; }
  const device = current(); if (!device) return;
  if (button.dataset.connectRoute) {
    const group = groupPhoneDevices(snapshot.devices, selected).find(item => item.routes.some(route => route.id === selected));
    const route = group?.routes.find(route => route.id === button.dataset.connectRoute);
    if (!group || !route || route.connection !== "device" || phoneConnectionPresentation(group).occupied) return;
    void run(async () => { await window.phones.prepare(route.id); selected = route.id; image = null; notice(`请在${route.transport === "emulator" ? "模拟器里的" : "手机"} App 中确认连接与权限。`); });
  }
  if (button.dataset.settingOpen) {
    const setting = button.dataset.settingOpen as PhoneSetting;
    void run(async () => { await window.phones.openSettings(device.id, setting); notice(["developerOptions", "usbDebugging", "wirelessDebugging"].includes(setting) && device.state?.readiness?.developerOptions === "disabled" ? "已打开手机设置。请连续点击版本号，再按系统提示开启开发者选项。" : `已在${device.transport === "emulator" ? "模拟器" : "手机"}打开设置，请在${device.transport === "emulator" ? "模拟器窗口内" : "手机上"}开启并确认系统提示。`); });
  }
  if (action === "cloud-forget") void run(() => window.phones.cloudForget(`cloud-${device.cloud?.channelId}`));
  if (action === "pause" || action === "resume" || action === "stop") void run(() => window.phones.control(device.id, action));
  if (action === "screenshot") void run(() => capture(device));
  if (action === "rename") rename(device);
  if (action === "enlarge" && image) {
    const dialog = document.createElement("dialog"); dialog.className = "phone-image-dialog"; dialog.setAttribute("aria-label", "手机画面");
    dialog.innerHTML = `<button aria-label="关闭大图">×</button><img src="${image.src}" alt="${esc(device.name)}最近一次的画面"><p>采集于 ${new Date(image.at).toLocaleTimeString()} · 非实时画面</p>`;
    dialog.querySelector("button")!.onclick = () => dialog.close(); dialog.addEventListener("close", () => dialog.remove()); document.body.append(dialog); dialog.showModal();
  }
});
function rename(device: PhoneDevice): void {
  const dialog = document.createElement("dialog"); dialog.className = "phone-name-dialog"; dialog.setAttribute("aria-label", "修改手机名称");
  dialog.innerHTML = `<form><h3>修改手机名称</h3><label>名称<input name="name" maxlength="80" required value="${esc(device.name)}"></label><footer><button type="button" data-cancel>取消</button><button type="submit" class="primary">保存</button></footer></form>`;
  document.body.append(dialog); dialog.querySelector("[data-cancel]")!.addEventListener("click", () => dialog.close()); dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("submit", event => { event.preventDefault(); const name = dialog.querySelector("input")!.value; dialog.close(); void run(() => window.phones.rename(device.id, name)); }); dialog.showModal();
}
window.phones.onChanged(value => { snapshot = value; loaded = true; render(); });
void window.phones.snapshot().then(value => { snapshot = value; loaded = true; render(); }).catch(error => { loaded = true; render(); notice(error.message, true); });
window.setInterval(() => { if (!document.hidden && window.workspacePane?.active !== false) { render(); updateElapsed(); } }, 1000);
