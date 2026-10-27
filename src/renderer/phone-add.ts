import type { PhoneDevice, PhoneNearbyApp } from "../shared/phones";
import { phoneDownloadFigure } from "./phone-basic";

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function openPhoneAdd(onAdded: (device: PhoneDevice, configure: boolean) => void, variant?: "debug" | "release"): void {
  const dialog = document.createElement("dialog");
  dialog.className = "phone-connect-dialog phone-add-dialog"; dialog.setAttribute("aria-label", "添加真实设备");
  let tab: "nearby" | "code" = "nearby", busy = false, version = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let apps: PhoneNearbyApp[] = [], added: PhoneDevice | undefined;
  const stop = () => { version++; clearTimeout(timer); };
  const close = () => { stop(); dialog.close(); dialog.remove(); };
  function render(): void {
    stop();
    dialog.innerHTML = `<header><h2>${added ? "设备已添加" : "添加真实设备"}</h2><button data-close aria-label="关闭添加真实设备">×</button></header>${added ? `
      <div class="phone-add-success"><span>✓</span><h3>${escape(added.name)}</h3><p>已保存到设备列表。现在可以关闭窗口，需要查看或操作手机时再配置连接。</p></div>
      <footer><button data-done>完成</button><button class="primary" data-configure>配置控制连接</button></footer>` : `
      <p>先添加手机或平板，稍后再配置控制连接。</p>
      <div class="phone-add-tabs" role="tablist" aria-label="添加方式"><button role="tab" data-tab="nearby" aria-selected="${tab === "nearby"}">同一网络扫描</button><button role="tab" data-tab="code" aria-selected="${tab === "code"}">设备码添加</button></div>
      ${tab === "nearby" ? `<section role="tabpanel" aria-label="同一网络扫描"><h3>发现附近的设备</h3><p>手机打开 ProfilePilot → 添加到电脑 → 开启「允许局域网发现」。手机和电脑需连接同一局域网，电脑也可以使用网线。</p><div class="phone-add-scan"><span data-scan-status role="status">正在扫描…</span><button data-scan>重新扫描</button></div><div data-devices class="phone-add-devices"></div></section>` : `
      <section role="tabpanel" aria-label="设备码添加"><h3>通过设备码添加</h3><p>手机打开 ProfilePilot → 添加到电脑 → 生成新设备码。两端能联网即可，无需处于同一网络。</p><form data-code-form><label>设备码<input name="code" aria-label="设备码" placeholder="XXXX-XXXX-XXXX" maxlength="24" autocomplete="off" spellcheck="false" required></label><details><summary>自定义服务器</summary><label>服务器地址<input name="url" type="url" aria-label="设备码服务器地址" placeholder="使用手机上的同一服务器（默认无需填写）"></label></details><button class="primary" type="submit">添加设备</button></form><p>设备码有效期 10 分钟，只能使用一次。添加后可同步状态；查看画面和操作仍需另行连接。</p></section>`}
      <p class="phone-add-error" role="alert" hidden></p><details class="phone-add-download"><summary>手机还没安装 ProfilePilot？</summary>${phoneDownloadFigure(variant)}</details>`}`;
    dialog.querySelector("[data-close]")!.addEventListener("click", close);
    dialog.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach(button => button.onclick = () => { if (busy) return; tab = button.dataset.tab as typeof tab; render(); if (tab === "nearby") void scan(); else dialog.querySelector<HTMLInputElement>('[name="code"]')?.focus(); });
    dialog.querySelector<HTMLButtonElement>("[data-scan]")?.addEventListener("click", () => void scan());
    dialog.querySelector<HTMLFormElement>("[data-code-form]")?.addEventListener("submit", event => {
      event.preventDefault(); const form = new FormData(event.currentTarget as HTMLFormElement);
      void add(() => window.phones.addDeviceCode(String(form.get("code")), String(form.get("url") || "").trim() || undefined));
    });
    for (const [selector, configure] of [["[data-done]", false], ["[data-configure]", true]] as const) dialog.querySelector(selector)?.addEventListener("click", () => { const device = added!; close(); onAdded(device, configure); });
  }
  function error(value: unknown): void {
    const node = dialog.querySelector<HTMLElement>(".phone-add-error"); if (node) { node.textContent = (value as Error).message; node.hidden = false; }
  }
  async function scan(): Promise<void> {
    if (busy || added || tab !== "nearby") return;
    stop(); const requestVersion = version;
    const button = dialog.querySelector<HTMLButtonElement>("[data-scan]")!; button.disabled = true;
    try {
      const result = await window.phones.discoverDevices();
      if (!dialog.isConnected || requestVersion !== version) return;
      apps = result.apps;
      dialog.querySelector<HTMLElement>("[data-scan-status]")!.textContent = result.appError || (apps.length ? `发现 ${apps.length} 台设备 · 自动刷新` : "暂未发现设备，请检查手机发现开关和网络");
      dialog.querySelector<HTMLElement>("[data-devices]")!.innerHTML = apps.map((app, i) => `<button data-add="${i}" ${!app.deviceId ? "disabled" : ""}><span><strong>${escape(app.name)}</strong><small>${escape(app.ip)} · ${escape(app.version)}</small></span><span>${app.deviceId ? "添加" : "请更新手机 App"}</span></button>`).join("");
      dialog.querySelectorAll<HTMLButtonElement>("[data-add]").forEach(item => item.onclick = () => { const app = apps[Number(item.dataset.add)]; void add(() => window.phones.addNearby(app.id)); });
    } catch (failure) { if (requestVersion === version && dialog.isConnected) error(failure); }
    finally { if (requestVersion === version && dialog.isConnected) { button.disabled = false; timer = setTimeout(() => void scan(), 5000); } }
  }
  async function add(operation: () => Promise<PhoneDevice>): Promise<void> {
    if (busy) return; busy = true; stop();
    dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button:not([data-close]),input").forEach(item => item.disabled = true);
    dialog.setAttribute("aria-busy", "true");
    try { added = await operation(); if (dialog.isConnected) render(); }
    catch (failure) { if (dialog.isConnected) error(failure); }
    finally {
      busy = false; dialog.removeAttribute("aria-busy");
      dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button,input").forEach(item => item.disabled = false);
      if (dialog.isConnected && !added && tab === "nearby") void scan();
    }
  }
  dialog.addEventListener("close", () => { stop(); dialog.remove(); });
  render(); document.body.append(dialog); dialog.showModal(); void scan();
}
