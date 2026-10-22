import { phoneList, type PhoneListFilter } from "../shared/phone-list";
import type { PhonesSnapshot } from "../shared/phones";
import { taskIcon } from "./task-icons";
const renderedMarkup = new WeakMap<Element, string>();

const esc = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function phoneListShell(): string {
  return `<section class="phone-registry" aria-labelledby="phone-list-title">
    <header class="phone-list-toolbar"><div class="phone-list-title"><h2 id="phone-list-title">我的设备</h2><span class="phone-count" data-phone-count>0</span><span class="phone-online-count"></span></div>
      <div class="phone-list-tools"><button data-action="refresh" aria-label="刷新设备" title="刷新设备">${taskIcon("refresh")}</button><button class="primary" data-action="add-device">${taskIcon("plus")}添加设备</button></div></header>
    <div class="phone-list-filters" role="group" aria-label="按连接状态筛选">${([['all', '全部'], ['online', '在线'], ['offline', '离线']] as const).map(([filter, label]) => `<button data-phone-filter="${filter}" aria-pressed="${filter === 'all'}">${label}<span>0</span></button>`).join("")}</div>
    <div class="phone-table-wrap"><table class="phone-table" aria-label="Android 设备列表"><colgroup><col class="phone-col-name"><col class="phone-col-connection"><col class="phone-col-status"><col class="phone-col-session"></colgroup><thead><tr><th scope="col">设备</th><th scope="col">连接方式</th><th scope="col">状态</th><th scope="col">当前会话</th></tr></thead><tbody></tbody></table></div>
    <footer class="phone-list-footer"><span data-phone-total></span><span>USB 授权后自动连接，已配对的 Wi-Fi 设备自动重连</span></footer>
  </section><p class="phone-list-note">${taskIcon("shield")}控制过程中，你可以随时接管或停止。</p><button class="phone-text-button phone-download-entry" data-action="downloads">下载手机 App（可选）</button><p class="phone-error" data-phone-list-error role="alert" hidden></p>`;
}

export function renderPhoneList(root: HTMLElement, snapshot: PhonesSnapshot, state: { filter: PhoneListFilter; selected: string; loaded: boolean; busy: boolean }) {
  const { all, items, online } = phoneList(snapshot.devices, "", state.filter, state.selected);
  root.querySelectorAll("[data-phone-count]").forEach(node => node.textContent = String(all.length));
  root.querySelector(".phone-online-count")!.textContent = `${online} 台在线`;
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-phone-filter]")) {
    button.setAttribute("aria-pressed", String(button.dataset.phoneFilter === state.filter));
    button.querySelector("span")!.textContent = String(button.dataset.phoneFilter === "all" ? all.length : button.dataset.phoneFilter === "online" ? online : all.length - online);
  }
  root.querySelector("[data-phone-total]")!.textContent = state.filter !== "all" ? `显示 ${items.length} / ${all.length} 台设备` : `共 ${all.length} 台设备`;
  const body = root.querySelector(".phone-table tbody")!;
  const html = items.length ? items.map(item => `<tr data-phone-row="${esc(item.id)}" data-selected="${item.id === state.selected}">
    <td><button class="phone-device-link" data-action="select-device" data-device-id="${esc(item.id)}" aria-current="${item.id === state.selected}"><span class="phone-list-icon">${taskIcon(item.emulator ? "desktop" : "phone")}</span><span class="phone-device-copy"><strong title="${esc(item.name)}">${esc(item.name)}</strong><small>${item.kind}</small></span></button></td>
    <td><span class="phone-transport">${item.connection}</span></td><td><span class="phone-list-status" data-tone="${item.tone}"><i></i>${esc(item.status)}</span></td><td><div class="phone-session-cell"><span class="phone-session" title="${esc(item.session)}">${esc(item.session)}</span>${snapshot.devices.find(device => device.id === item.id)?.transport !== "cloud" ? `<button type="button" class="phone-menu-trigger" data-action="device-menu" data-device-id="${esc(item.id)}" aria-label="更多操作：${esc(item.name)}" title="更多" aria-haspopup="menu" aria-expanded="false" aria-controls="phone-device-menu" ${state.busy ? "disabled" : ""}>⋮</button>` : ""}</div></td>
    </tr>`).join("")
    : `<tr><td colspan="4"><div class="phone-list-empty" role="status">${!state.loaded ? "正在读取设备…" : all.length ? '没有匹配的设备。<button class="phone-text-button" data-action="clear-filter">清除筛选</button>' : `${taskIcon("phone")}<h3>添加你的第一台 Android 设备</h3><p>通过 USB 或 Wi-Fi 连接手机，也可以使用本机模拟器。</p><button class="primary" data-action="add-device">${taskIcon("plus")}添加设备</button>`}</div></td></tr>`;
  // Status events can arrive while a pointer targets a row. Unchanged rows keep
  // their DOM, and every action carries its own explicit device identity.
  if (renderedMarkup.get(body) !== html) {
    const focused = document.activeElement instanceof HTMLButtonElement && body.contains(document.activeElement) ? document.activeElement : undefined;
    const identity = focused && { id: focused.dataset.deviceId, action: focused.dataset.action, label: focused.getAttribute("aria-label") };
    body.innerHTML = html;
    renderedMarkup.set(body, html);
    if (identity) [...body.querySelectorAll<HTMLButtonElement>("button")].find(button => button.dataset.deviceId === identity.id && button.dataset.action === identity.action && button.getAttribute("aria-label") === identity.label)?.focus({ preventScroll: true });
  }
  const error = root.querySelector<HTMLElement>("[data-phone-list-error]")!;
  error.hidden = !snapshot.error; error.textContent = snapshot.error;
  const refresh = root.querySelector<HTMLButtonElement>('[data-action="refresh"]')!;
  refresh.disabled = state.busy;
}
