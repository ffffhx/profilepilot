import { type PhoneDevice, type PhoneSetting, type PhonesSnapshot } from "../shared/phones";
import { groupPhoneDevices } from "../shared/phone-devices";
import { phoneConnectionPresentation, phoneEnhancementPresentation, phonePresentation, type PhoneRoutePresentation, type PhoneSettingRow } from "../shared/phone-presentation";
import { workspaceIdentityBar, workspaceSwitcher, refreshWorkspaceSwitcher } from "./workspace-switcher";
import { pcControlTabs } from "./pc-control";
import { phoneListShell, renderPhoneList } from "./phone-list";
import { phoneListItem, type PhoneListFilter } from "../shared/phone-list";
import { taskIcon } from "./task-icons";
import { createMobileConnections } from "./mobile-connections";
import { openPhoneWireless } from "./phone-wireless";
import { PhoneWirelessDiscoveryMonitor, wirelessDiscoveryPresentation } from "./phone-wireless-discovery";
import { openPhoneCloud } from "./phone-cloud";
import { openPhoneEmulator } from "./phone-emulator";
import { openBasicPhone, phoneModeChoices, phoneAppDownload, phoneDownloadFigure } from "./phone-basic";
import { createPhoneInspector } from "./phone-inspector";
import { openScreenCamera } from "./screen-camera";

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
let previewSource = "", previewVersion = 0, previewAttempted = false, previewLoading = false, previewError = "";
let noticeTimer: number;
let filter: PhoneListFilter = "all", detailIdentity = "";
let drawerReturnId = "";
const wirelessDiscovery = new PhoneWirelessDiscoveryMonitor(id => window.phones.discoverWireless(id), render);

root.innerHTML = `${workspaceSwitcher("phones")}${workspaceIdentityBar()}<main class="phone-shell phone-console"><header class="pc-control-header"><div class="pc-control-brand"><h1>控制台</h1><p>管理浏览器、桌面应用与 Android 设备</p></div></header>${pcControlTabs("phones")}<div class="phone-console-layout"><div class="phone-registry-column">${phoneListShell()}</div><aside class="phone-inspector" aria-label="手机画面与会话"></aside></div><button class="phone-text-button phone-mobile-entry-link" data-action="mobile" hidden>用手机管理电脑任务 →</button></main>
  <dialog class="phone-details" aria-labelledby="phone-details-title"><header class="phone-details-top"><span>设备详情</span><button data-action="close-details" aria-label="关闭设备详情">${taskIcon("close")}</button></header><div class="phone-details-scroll"><div class="phone-details-identity"></div><div class="phone-content" aria-busy="true"></div></div></dialog>`;
const drawer = root.querySelector<HTMLDialogElement>(".phone-details")!;
const inspector = createPhoneInspector(root.querySelector<HTMLElement>(".phone-inspector")!);
drawer.addEventListener("close", () => {
  key = ""; render();
  const button = [...root.querySelectorAll<HTMLButtonElement>('.phone-device-link')].find(button => button.dataset.deviceId === drawerReturnId);
  (button || root.querySelector<HTMLButtonElement>('[data-action="add-device"]'))?.focus({ preventScroll: true });
});
drawer.addEventListener("click", event => { if (event.target === drawer) { const box = drawer.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) drawer.close(); } });
refreshWorkspaceSwitcher();

const openMobileConnections = createMobileConnections();
root.querySelector<HTMLButtonElement>('.phone-mobile-entry-link')!.hidden = !openMobileConnections;
function showDetails(id: string): void {
  const group = groupPhoneDevices(snapshot.devices, id).find(group => group.routes.some(route => route.id === id));
  if (!group) { notice("这台设备已不在列表中，请刷新后重试。", true); return; }
  selected = group.device.id; drawerReturnId = selected;
  if (!drawer.open) drawer.showModal();
  key = ""; render();
}
function addDevice(): void {
  const dialog = document.createElement("dialog"); dialog.className = "phone-connect-dialog"; dialog.setAttribute("aria-label", "添加 Android 设备");
  dialog.innerHTML = `<header><h2>添加 Android 设备</h2><button data-close aria-label="关闭添加设备窗口">×</button></header><p>连接手机或创建一台新的虚拟设备。</p><div class="phone-connect-choices"><button data-connect="usb">${icon("usbDebugging")}<span><strong>通过 USB 连接</strong><small>插入数据线，并在手机上允许调试连接</small></span>${taskIcon("chevron")}</button><button data-connect="wifi">${icon("wifi")}<span><strong>通过 Wi-Fi 连接</strong><small>连接同一网络，使用无线调试配对</small></span>${taskIcon("chevron")}</button><button data-connect="emulator">${taskIcon("desktop")}<span><strong>创建虚拟设备</strong><small>安装 Android 环境、下载镜像并创建新设备</small></span>${taskIcon("chevron")}</button></div>`;
  dialog.addEventListener("click", event => { const button = (event.target as Element).closest<HTMLButtonElement>("button"); if (!button) return; dialog.close(); dialog.remove(); if (button.dataset.connect === "usb") usb(); else if (button.dataset.connect === "wifi") wireless(true); else if (button.dataset.connect === "emulator") emulator("create"); });
  dialog.addEventListener("close", () => dialog.remove()); document.body.append(dialog); dialog.showModal();
}
function downloads(): void {
  const dialog = document.createElement("dialog"); dialog.className = "phone-connect-dialog"; dialog.setAttribute("aria-label", "下载手机 App");
  dialog.innerHTML = `<header><h2>下载手机 App</h2><button data-close aria-label="关闭下载窗口">×</button></header><p>App 为可选安装。通过 USB 或 Wi-Fi 连接后，无需安装即可查看和操作手机。</p>${phoneDownloadFigure(snapshot.companionApp?.variant)}<button data-action="phone-apk">获取 APK 文件</button>`;
  dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove()); root.append(dialog); dialog.showModal();
}
function usb(): void {
  const dialog = document.createElement("dialog");
  dialog.className = "phone-connect-dialog phone-usb-dialog";
  dialog.setAttribute("aria-label", "通过 USB 连接");
  dialog.innerHTML = `<header><h2>通过 USB 连接</h2><button data-close aria-label="关闭 USB 连接窗口">×</button></header><p>用支持数据传输的 USB 线连接手机与电脑。</p><div data-usb-help><ol><li>在手机上开启开发者选项和 USB 调试。</li><li>连接数据线，解锁手机并允许 USB 调试。</li><li>识别后，手机会自动出现在设备列表中；选择手机，可直接使用免安装控制，也可安装手机 App 获取增强功能。</li></ol><p>Windows 无法识别时，请检查手机厂商的 USB 驱动；macOS 通常无需额外驱动。</p></div><footer><button class="primary" data-close>查看设备</button></footer>`;
  dialog.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => dialog.close()));
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog); dialog.showModal();
}
function cloud(): void {
  openPhoneCloud(id => { void run(async () => { snapshot = await window.phones.snapshot(); selected = id; }); });
}
function emulator(mode: "connect" | "create" = "connect"): void {
  openPhoneEmulator(device => {
    void run(async () => { snapshot = await window.phones.snapshot(); selected = device.id; });
  }, mode);
}
function wireless(otherDevice = false): void {
  openPhoneWireless((device, prepare) => {
    void run(async () => { if (prepare) await window.phones.prepare(device.id); snapshot = await window.phones.snapshot(); selected = device.id; });
  }, otherDevice || current()?.transport === "emulator" ? undefined : current()?.id);
}
function current(): PhoneDevice | undefined { return snapshot.devices.find(device => device.id === selected); }
function notice(text: string, error = false): void {
  const element = document.getElementById("phone-message")!;
  const topDialog = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1);
  (topDialog || document.body).append(element);
  if (topDialog) topDialog.addEventListener('close', () => document.body.append(element), { once: true });
  element.textContent = text; element.hidden = false; element.dataset.error = String(error);
  element.setAttribute("role", error ? "alert" : "status"); clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => element.hidden = true, error ? 12000 : 4500);
}
function settingsRows(rows: PhoneSettingRow[], canSetup: boolean, subject = "手机"): string {
  return rows.map(row => `<div class="phone-setting" data-setting="${row.key}"><div class="phone-setting-info"><span class="phone-setting-icon">${icon(row.key)}</span><div><span class="phone-setting-name">${row.label}</span>${row.description ? `<p>${row.description}</p>` : ""}</div></div><div class="phone-setting-result"><span class="phone-setting-status" data-status="${row.status}" ${row.status === "unknown" ? `title="${esc(row.description || `${subject}尚未返回此开关的当前状态`)}"` : ""}>${row.status === "enabled" ? taskIcon("check") : ""}${row.value}</span>${row.status === "disabled" ? `<button class="phone-text-button" data-setting-open="${row.key}" ${canSetup && !busy ? "" : `disabled title="请先建立控制连接并结束当前任务，再打开${subject}设置"`}>去开启</button>` : ""}</div></div>`).join("");
}
function routeCard(transport: "usb" | "wifi", route?: PhoneRoutePresentation, occupied = false): string {
  const connected = !!route?.detected, unauthorized = route?.unauthorized;
  const name = transport === "usb" ? "USB" : "Wi-Fi";
  const discovery = transport === "wifi" ? wirelessDiscoveryPresentation(wirelessDiscovery.state, route?.setting.status === "enabled") : undefined;
  const label = connected ? "已连接" : unauthorized ? "等待授权" : discovery?.label || "未连接";
  const note = connected ? `${phonePresentation(route!.device!).displayName} · ${transport === "usb" ? "数据线已连接" : "无线调试已连接"}`
    : unauthorized ? "请在手机上允许这台电脑进行调试。" : discovery?.note || "用数据线连接手机，开启 USB 调试。";
  return `<section class="phone-route" data-route="${transport}" data-debug-connected="${connected}"><span class="phone-route-icon">${icon(transport === "usb" ? "usbDebugging" : "wifi")}</span><div class="phone-route-copy"><header><h3>${name}</h3><span class="phone-route-badge" data-tone="${connected ? "ready" : unauthorized ? "warning" : "neutral"}">${label}</span></header><p class="phone-route-note">${esc(note)}</p></div><button data-action="${transport}" ${transport === "wifi" && (busy || occupied) ? "disabled" : ""}>${transport === "usb" ? "连接说明" : connected ? "连接设置" : "连接 Wi-Fi"}</button></section>`;
}
function connectionSection(status?: ReturnType<typeof phoneConnectionPresentation>): string {
  const emulator = status?.view.emulator;
  return `<section class="phone-card phone-connection-section" aria-label="连接手机"><header class="phone-section-heading"><div><h2>${emulator ? "连接模拟器" : "连接手机"}</h2><p>${emulator ? "启动本机模拟器，即可使用下方控制功能。" : "USB 或 Wi-Fi，任选一种即可"}</p></div></header>
    ${emulator ? `<div class="phone-emulator-connection"><span class="phone-route-badge" data-tone="${current()?.connection === "device" ? "ready" : "neutral"}">${current()?.connection === "device" ? "模拟器已连接" : "模拟器未连接"}</span><button data-action="emulator">启动 / 连接模拟器</button></div>` : `<div class="phone-route-grid">${(["usb", "wifi"] as const).map(transport => routeCard(transport, status?.routes.find(route => route.transport === transport), status?.occupied)).join("")}</div>`}
    ${!status ? `<p class="phone-mode-hint phone-empty">${loaded ? "连接后会自动识别手机，无需安装 App。" : "正在查找手机…"}</p>` : ""}
    ${snapshot.error ? `<p class="phone-error" role="alert">${esc(snapshot.error)}</p>` : ""}</section>`;
}
function enhancement(device?: PhoneDevice, disabledReason = "请先在上方连接手机，再直接安装 App。"): string {
  const app = phoneEnhancementPresentation(device);
  const appName = snapshot.companionApp?.name || "ProfilePilot 安卓 App";
  return `<header class="phone-mode-heading"><h3>控制增强</h3><span>可选</span></header><p class="phone-mode-description">安装 App，开启控件识别、中文填写与手机端暂停。</p>
    ${snapshot.companionApp?.variant === "debug" ? '<p class="phone-mode-hint">当前使用开发版，可在手机内检查更新，也可继续通过电脑调试。</p>' : ""}
    <div class="phone-app-status-panel"><header><strong>${esc(appName)}</strong><span class="phone-route-badge" data-app-installation="${app.installation}" data-tone="${app.tone}">${app.label}</span></header><p class="phone-mode-hint">${app.installation === "missing" ? "不影响免安装控制" : app.note}</p>
    <div class="phone-install-actions"><button data-action="install-phone-app" ${disabledReason ? `disabled title="${esc(disabledReason)}"` : ""}>${app.connected ? "更新手机 App" : app.installation === "installed" ? "连接手机 App" : "安装到手机"}</button><button class="phone-text-button" data-action="inspect-app" ${!device || device.transport === "cloud" || busy ? "disabled" : ""}>重新检测</button></div></div>
    <div class="phone-permissions" aria-label="增强功能权限">${settingsRows(app.permissions, app.canSetup && (!device?.basic || device.basic.phase === "stopped"))}</div>
    <details class="phone-downloads" data-phone-downloads><summary>其他下载方式</summary>${phoneDownloadFigure(snapshot.companionApp?.variant)}<button data-action="phone-apk">获取 APK 文件</button></details>`;
}
function options(device?: PhoneDevice): string {
  return `<details class="phone-options" data-phone-options><summary>${taskIcon("settings")}更多设置</summary><div>
    ${device && device.transport !== "cloud" ? '<button class="phone-text-button" data-action="rename">修改设备名称</button>' : ""}
    <button class="phone-text-button" data-action="cloud-link">未连接电脑时也同步手机状态</button>
    ${device?.cloud?.channelId ? '<button class="phone-text-button" data-action="cloud-forget">移除此状态同步</button>' : ""}
    <button class="phone-text-button" data-action="add-device">添加其他设备</button>
    <button class="phone-text-button" data-action="emulator">使用本机模拟器</button>
    ${openMobileConnections ? '<button class="phone-text-button" data-action="mobile">用手机管理电脑任务</button>' : ""}
  </div></details>`;
}
function render(): void {
  const groups = groupPhoneDevices(snapshot.devices, selected);
  const previous = selected;
  const group = groups.find(item => item.routes.some(route => route.id === selected)) || (!drawer.open ? groups.find(item => item.device.connection === "device") || groups[0] : undefined);
  selected = group?.device.id || "";
  if (drawer.open && previous && !group) { drawer.close(); notice("这台设备已从列表移除。"); }
  if (selected) sessionStorage.setItem("phone-selected", selected);
  drawer.dataset.deviceId = selected;
  renderPhoneList(root, snapshot, { filter, selected, loaded, busy });
  const device = current(), status = group && phoneConnectionPresentation(group), view = status?.view;
  inspector.update(device, busy);
  const needsDiscovery = !!device && !view?.emulator && !status?.routes.some(route => route.transport === "wifi" && route.detected);
  wirelessDiscovery.update(needsDiscovery ? device.id : "", drawer.open && loaded && snapshot.adbAvailable && !busy && !document.hidden
    && window.workspacePane?.active !== false && !document.querySelector(".phone-wireless-dialog"));
  const basicOccupied = !!device?.basic && device.basic.phase !== "stopped";
  const source = drawer.open && !basicOccupied && device && status?.connected && view?.directKnown ? JSON.stringify([device.id, device.state?.instanceId]) : "";
  if (source !== previewSource) {
    previewSource = source; previewVersion++; previewAttempted = false; previewError = ""; image = null;
  }
  // Capture once per connection/selection, then retain the JPEG without polling
  // the phone. Defer until this pane is visible and the phone can accept a read.
  if (source && root.querySelector<HTMLDetailsElement>('[data-phone-app-setup]')?.open && view?.canPreview && !image && !previewAttempted && !previewLoading && !busy && !document.hidden && window.workspacePane?.active !== false) {
    const version = previewVersion;
    queueMicrotask(() => { if (version === previewVersion) void capture(true); });
  }
  if (!drawer.open) return;
  const nextKey = JSON.stringify([snapshot.devices.map(({ confirmedAt, ...rest }) => rest), snapshot.error, snapshot.adbAvailable, selected, busy, image?.at, previewLoading, previewError, view?.directKnown, view?.known, status?.condition, status?.routes.map(route => route.connected), loaded, wirelessDiscovery.state]);
  if (nextKey === key) return; key = nextKey;
  const activeElement = document.activeElement;
  const focusedAction = activeElement instanceof HTMLButtonElement && drawer.contains(activeElement) ? activeElement.dataset.action : undefined;
  const optionsOpen = root.querySelector<HTMLDetailsElement>("[data-phone-options]")?.open;
  const errorDetailsOpen = root.querySelector<HTMLDetailsElement>(".phone-error-details")?.open;
  const appSetupOpen = root.querySelector<HTMLDetailsElement>("[data-phone-app-setup]")?.open;
  const downloadsOpen = root.querySelector<HTMLDetailsElement>("[data-phone-downloads]")?.open;
  const sameDevice = detailIdentity === selected;
  detailIdentity = selected;
  const row = group && phoneListItem(group);
  const identity = root.querySelector<HTMLElement>(".phone-details-identity")!;
  const heading = device && view && row ? `<span class="phone-list-icon">${taskIcon(view.emulator ? "desktop" : "phone")}</span><div><div class="phone-details-name"><h2 id="phone-details-title">${esc(view.displayName)}</h2><button data-action="rename" aria-label="修改设备名称" ${device.transport === "cloud" ? "hidden" : ""}>${taskIcon("rename")}</button></div><p>${row.kind}<span class="phone-list-status" data-tone="${row.tone}"><i></i>${esc(row.status)}</span></p></div>` : '<h2 id="phone-details-title">设备不可用</h2>';
  if (identity.dataset.markup !== heading) { identity.innerHTML = heading; identity.dataset.markup = heading; }
  const content = root.querySelector<HTMLElement>(".phone-content")!;
  content.setAttribute("aria-busy", String(busy || !loaded));
  if (!device || !view || !status) {
    content.innerHTML = `${connectionSection()}${phoneModeChoices(undefined, "请先在上方通过 USB 或 Wi-Fi 连接手机。")}<section class="phone-card phone-control-section phone-enhanced-section" aria-label="控制增强">${enhancement()}</section>${options()}`;
  } else if (basicOccupied) {
    const phase = device.basic!.phase;
    content.innerHTML = `${connectionSection(status)}<section class="phone-card phone-control-section phone-basic-section phone-basic-session"><span class="phone-basic-icon">${taskIcon("phone")}</span><div class="phone-basic-copy"><header class="phone-mode-heading"><h3>免安装控制</h3><span>无需手机 App</span></header><p class="phone-mode-description">${phase === "paused" ? "控制已暂停" : phase === "disconnected" ? "连接已断开，请结束此会话后重新开始。" : "正在通过调试连接查看和操作手机。"}</p></div><div class="phone-mode-actions"><button class="primary" data-action="basic-open">查看手机</button><button data-action="basic-stop">结束会话</button></div></section><section class="phone-card phone-control-section phone-enhanced-section" aria-label="控制增强">${enhancement(device, "请先结束免安装控制，再直接安装手机 App。")}</section>${options(device)}`;
  } else {
    const state = device.state;
    const disabled = busy || !!device.pending ? "disabled" : "";
    const modeDisabledReason = busy ? "正在处理操作，请稍候。" : device.pending || (status.occupied ? "请先结束当前手机 App 会话，再选择控制方式。"
      : device.connection === "unauthorized" ? "请先在手机上允许这台电脑进行调试。"
      : device.connection !== "device" ? "请先在上方通过 USB 或 Wi-Fi 连接手机，连接后即可使用。" : "");
    const hasTask = view.active || view.paused;
    const taskLabel = view.paused ? "任务已暂停" : `${state?.controller || "Agent"}${state?.mode === "view" ? " 正在查看屏幕" : " 正在操作"}`;
    const fallbackError = !status.issue && device.error && !["手机连接已断开。", "ADB 连接离线。"].includes(device.error) ? device.error : "";
    const previewNote = status.issue ? "手机 App 恢复响应后自动显示画面" : !status.connected ? "连接后自动显示手机画面" : view.paused ? "任务已暂停，继续后可查看画面" : view.locked ? "请先解锁手机，再查看画面" : !view.permissionsReady ? "控制权限就绪后自动显示画面" : previewLoading ? "正在获取手机画面…" : previewError ? "画面获取失败，可点击重试" : "连接后自动显示 · 可手动刷新";
    content.innerHTML = `${connectionSection(status)}${phoneModeChoices(device, modeDisabledReason)}
      <section class="phone-card phone-control-section phone-enhanced-section" data-connected="${status.connected}" aria-label="控制增强">
      ${enhancement(device, modeDisabledReason)}
      <details class="phone-app-setup" data-phone-app-setup ${hasTask || status.issue ? "open" : ""}><summary>App 会话与连接诊断</summary>
      <p class="phone-updated"></p>
      <div class="phone-summary">
        <section class="phone-summary-item"><h3>手机 App 是否已连接</h3><div class="phone-connection" data-ready="${status.connected}" role="status"><span class="phone-summary-symbol">${status.connected ? taskIcon("check") : '<span class="phone-dot"></span>'}</span><strong>${status.connectionLabel}</strong></div><p class="phone-connection-note">${esc(status.connectionNote)}</p></section>
        <section class="phone-summary-item"><h3>权限与调试准备</h3><div class="phone-readiness" data-condition="${status.condition}" role="status"><span class="phone-summary-symbol">${status.condition === "ready" ? taskIcon("check") : '<span class="phone-dot"></span>'}</span><strong>${status.label}</strong></div><p>${esc(status.note)}</p></section>
      </div>
      ${hasTask ? `<div class="phone-task-strip" data-paused="${view.paused}"><div class="phone-task-heading"><span class="phone-dot"></span><strong>${esc(taskLabel)}</strong><span data-elapsed></span></div><p>${esc(state?.task || "手机会话")}</p><div class="phone-task-actions">${view.paused ? `<button data-action="resume" ${disabled}>继续任务</button>` : `<button data-action="pause" ${disabled}>${icon("pause")}暂停</button>`}<button data-action="stop" ${disabled}>结束任务</button></div></div>` : ""}
      ${status.issue ? `<section class="phone-connection-help" role="status" aria-label="手机连接恢复提示"><strong>${esc(status.issue.title)}</strong><p>${esc(status.issue.description)}</p>${status.issue.lastState ? `<p>${esc(status.issue.lastState)}</p>` : ""}<ol>${status.issue.steps.map(step => `<li>${esc(step)}</li>`).join("")}</ol>${status.issue.detail ? `<details class="phone-error-details"><summary>技术详情</summary><p>${esc(status.issue.detail)}</p></details>` : ""}</section>` : ""}
      ${(device.transport !== "cloud" && snapshot.error) || fallbackError ? `<p class="phone-error" role="alert">${esc((device.transport !== "cloud" && snapshot.error) || fallbackError)}</p>` : ""}
      <div class="phone-debug-settings">${settingsRows(view.settings, view.canSetup)}</div>
      <footer class="phone-screen-bar"><span title="${esc(previewError)}">${taskIcon("phone")}${previewNote}</span><button class="phone-text-button" data-action="screenshot" ${disabled} ${view.canPreview && !previewLoading ? "" : "disabled"}>${icon("refresh")}${previewLoading ? "获取中…" : previewError ? "重试" : image ? "刷新画面" : "查看手机画面"}</button></footer>
      ${image ? `<section class="phone-preview"><button class="phone-screen-image" data-action="enlarge" aria-label="放大${view.subject}画面"><img src="${image.src}" alt="${esc(device.name)}最近一次的画面" draggable="false"></button><p>采集于 ${new Date(image.at).toLocaleTimeString()} · 非实时画面</p></section>` : ""}
      ${!view.known ? `<p class="phone-status-note">${status.issue ? "“暂时无法读取”不代表权限已关闭，收到手机回复后会自动更新。" : device.cloud ? "手机状态已过期，等待重新上报后确认权限。" : "尚未收到手机状态。连接手机 App，或在设备设置中开启状态同步。"}</p>` : ""}
      </details>
      </section>${options(device)}`;
  }
  const basic = content.querySelector('.phone-basic-section'); if (basic) content.prepend(basic);
  const connectionHeading = content.querySelector('.phone-section-heading h2'); if (connectionHeading && !view?.emulator) connectionHeading.textContent = "连接方式";
  if (sameDevice && appSetupOpen !== undefined) { const details = root.querySelector<HTMLDetailsElement>("[data-phone-app-setup]"); if (details) details.open = appSetupOpen || Boolean(view?.active || view?.paused || status?.issue); }
  if (sameDevice && optionsOpen) { const details = root.querySelector<HTMLDetailsElement>("[data-phone-options]"); if (details) details.open = true; }
  if (sameDevice && downloadsOpen) { const details = root.querySelector<HTMLDetailsElement>("[data-phone-downloads]"); if (details) details.open = true; }
  if (sameDevice && errorDetailsOpen) { const details = root.querySelector<HTMLDetailsElement>(".phone-error-details"); if (details) details.open = true; }
  if (busy) content.querySelectorAll<HTMLButtonElement>('button:not([data-action="phone-download-copy"]):not([data-action="phone-apk"])').forEach(button => button.disabled = true);
  if (focusedAction) drawer.querySelector<HTMLButtonElement>(`[data-action="${focusedAction}"]`)?.focus({ preventScroll: true });
  updateElapsed();
}
function updateElapsed(): void {
  const device = current(), view = device && phonePresentation(device), updated = root.querySelector(".phone-updated");
  if (updated && device && view) {
    const at = view.directKnown ? device.confirmedAt : view.cloudSource ? device.cloud?.reportedAt : Math.max(device.confirmedAt || 0, device.cloud?.reportedAt || 0);
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
async function capture(automatic = false): Promise<void> {
  const device = current();
  if (!device || !previewSource || busy || previewLoading || !phonePresentation(device).canPreview) return;
  if (automatic && (image || previewAttempted || document.hidden || window.workspacePane?.active === false)) return;
  const version = previewVersion;
  previewAttempted = true; previewLoading = true; previewError = ""; render();
  try {
    const response = await window.phones.preview(device.id);
    const result = response.result as { mime?: string; base64?: string; width?: number; height?: number };
    if (result?.mime !== "image/jpeg" || typeof result.base64 !== "string" || !/^[A-Za-z0-9+/=\r\n]+$/.test(result.base64) || !result.width || !result.height || result.width < 0 || result.height < 0) throw new Error("手机画面无效，请重新查看连接状态。");
    if (version === previewVersion && response.state.instanceId === current()?.state?.instanceId) image = { id: device.id, instanceId: response.state.instanceId, src: `data:image/jpeg;base64,${result.base64}`, at: Date.now() };
  } catch (error) {
    if (version === previewVersion) {
      previewError = (error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, "");
      if (!automatic) notice(previewError, true);
    }
  } finally { previewLoading = false; render(); }
}
root.addEventListener("toggle", event => { if ((event.target as HTMLElement).matches('[data-phone-app-setup]')) render(); }, true);
root.addEventListener("click", event => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button");
  if (!button) { const row = (event.target as Element).closest<HTMLElement>("[data-phone-row]"); if (row && !busy) { selected = row.dataset.phoneRow!; render(); } return; }
  if (button.disabled) return;
  const action = button.dataset.action;
  if (action === "close-details") { drawer.close(); return; }
  if (action === "downloads") { downloads(); return; }
  if (button.dataset.phoneFilter) { filter = button.dataset.phoneFilter as PhoneListFilter; render(); return; }
  if (action === "clear-filter") { filter = "all"; render(); return; }
  if (action === "phone-apk") {
    void window.mobile.openApkFolder().then(() => notice("已打开 APK 文件所在位置，可将文件传到手机安装。")).catch(error => notice(error.message, true)); return;
  }
  if (action === "phone-download-copy") {
    void navigator.clipboard.writeText(phoneAppDownload(snapshot.companionApp?.variant).url).then(() => notice("下载链接已复制，可在手机浏览器中打开。")).catch(() => notice("复制失败，请使用右侧二维码下载。", true)); return;
  }
  if (busy) return;
  if (action === "add-device") { addDevice(); return; }
  if (action === "refresh") { void run(async () => { snapshot = await window.phones.snapshot(); loaded = true; }); return; }
  if (action === "refresh-phone-screen") { void inspector.refresh(true); return; }
  if (action === "enlarge-phone-screen") { inspector.enlarge(); return; }
  if (button.dataset.deviceId) {
    const group = groupPhoneDevices(snapshot.devices, button.dataset.deviceId).find(group => group.routes.some(route => route.id === button.dataset.deviceId));
    if (!group) { notice("这台设备已不在列表中，请刷新后重试。", true); return; }
    selected = group.device.id;
    if (action === "select-device") { render(); return; }
    if (action === "details") { showDetails(selected); return; }
  }
  if (action === "cloud-link") { cloud(); return; }
  if (action === "usb") { usb(); return; }
  if (action === "wifi") { wireless(); return; }
  if (action === "emulator") { emulator(); return; }
  if (action === "mobile") { void openMobileConnections?.(); return; }
  const device = current(); if (!device) return;
  if (action === "screen-camera") { void openScreenCamera(device); return; }
  if (button.dataset.phoneBasicCommand) { void run(() => window.phones.basicControl(device.id, button.dataset.phoneBasicCommand as "pause" | "resume" | "stop")); return; }
  if (action === "inspect-app") { void run(() => window.phones.inspect(device.id)); return; }
  if (action === "basic-control" || action === "phone-operate") {
    const group = groupPhoneDevices(snapshot.devices, selected).find(group => group.routes.some(route => route.id === selected));
    if (!group || device.connection !== "device" || device.pending || phoneConnectionPresentation(group).occupied) { showDetails(device.id); return; }
    void run(async () => { const started = await window.phones.basicStart(device.id, action === "phone-operate" ? "control" : "view", "本机用户", "免安装手机控制"); openBasicPhone(started, installPhoneApp); }); return;
  }
  if (action === "basic-open") { openBasicPhone(device, installPhoneApp); return; }
  if (action === "basic-stop") { void run(() => window.phones.basicControl(device.id, "stop")); return; }
  if (action === "install-phone-app") { void installPhoneApp(device.id); return; }
  if (button.dataset.connectRoute) {
    const group = groupPhoneDevices(snapshot.devices, selected).find(item => item.routes.some(route => route.id === selected));
    const route = group?.routes.find(route => route.id === button.dataset.connectRoute);
    if (!group || !route || route.connection !== "device" || phoneConnectionPresentation(group).occupied) return;
    void run(async () => { await window.phones.prepare(route.id); selected = route.id; notice(`App 已打开，正在自动连接；如需控制，请在${route.transport === "emulator" ? "模拟器里的" : "手机"} App 中完成权限准备。`); });
  }
  if (button.dataset.settingOpen) {
    const setting = button.dataset.settingOpen as PhoneSetting;
    void run(async () => { await window.phones.openSettings(device.id, setting); notice(["developerOptions", "usbDebugging", "wirelessDebugging"].includes(setting) && device.state?.readiness?.developerOptions === "disabled" ? "已打开手机设置。请连续点击版本号，再按系统提示开启开发者选项。" : `已在${device.transport === "emulator" ? "模拟器" : "手机"}打开设置，请在${device.transport === "emulator" ? "模拟器窗口内" : "手机上"}开启并确认系统提示。`); });
  }
  if (action === "cloud-forget") void run(() => window.phones.cloudForget(`cloud-${device.cloud?.channelId}`));
  if (action === "pause" || action === "resume" || action === "stop") void run(() => window.phones.control(device.id, action));
  if (action === "screenshot") void capture();
  if (action === "rename") rename(device);
  if (action === "enlarge" && image) {
    const dialog = document.createElement("dialog"); dialog.className = "phone-image-dialog"; dialog.setAttribute("aria-label", "手机画面");
    dialog.innerHTML = `<button aria-label="关闭大图">×</button><img src="${image.src}" alt="${esc(device.name)}最近一次的画面"><p>采集于 ${new Date(image.at).toLocaleTimeString()} · 非实时画面</p>`;
    dialog.querySelector("button")!.onclick = () => dialog.close(); dialog.addEventListener("close", () => dialog.remove()); document.body.append(dialog); dialog.showModal();
  }
});
async function installPhoneApp(id: string): Promise<void> {
  await run(async () => { await window.phones.prepare(id); notice("App 已安装并打开，请在手机上确认配对和所需权限。"); });
}
function rename(device: PhoneDevice): void {
  const dialog = document.createElement("dialog"); dialog.className = "phone-name-dialog"; dialog.setAttribute("aria-label", "修改手机名称");
  dialog.innerHTML = `<form><h3>修改手机名称</h3><label>名称<input name="name" maxlength="80" required value="${esc(device.name)}"></label><footer><button type="button" data-cancel>取消</button><button type="submit" class="primary">保存</button></footer></form>`;
  document.body.append(dialog); dialog.querySelector("[data-cancel]")!.addEventListener("click", () => dialog.close()); dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("submit", event => { event.preventDefault(); const name = dialog.querySelector("input")!.value; dialog.close(); void run(() => window.phones.rename(device.id, name)); }); dialog.showModal();
}
window.phones.onChanged(value => { snapshot = value; loaded = true; render(); });
document.addEventListener("visibilitychange", render);
document.addEventListener("workspace-visibilitychange", render);
void window.phones.snapshot().then(value => { snapshot = value; loaded = true; render(); }).catch(error => { loaded = true; render(); notice(error.message, true); });
window.setInterval(() => { if (!document.hidden && window.workspacePane?.active !== false) { render(); updateElapsed(); } }, 1000);
