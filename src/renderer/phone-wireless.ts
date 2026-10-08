import type { PhoneDevice, PhoneWirelessService } from "../shared/phones";

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function openPhoneWireless(onConnected: (device: PhoneDevice, prepare: boolean) => void, deviceId?: string): void {
  if (document.querySelector(".phone-wireless-dialog")) return;
  const dialog = document.createElement("dialog");
  dialog.className = "phone-wireless-dialog";
  dialog.setAttribute("aria-labelledby", "phone-wireless-title");
  let step = deviceId ? 0 : 1, busy = false, services: PhoneWirelessService[] = [], pairingHost = "", address = "", paired = false;
  let connected: PhoneDevice | undefined;
  let discoveryVersion = 0;
  const dismiss = () => { discoveryVersion++; dialog.close(); dialog.remove(); };
  function render(): void {
    dialog.innerHTML = `<div class="wireless-heading"><div><p class="wireless-eyebrow">手机 · 局域网连接</p><h2 id="phone-wireless-title">无线连接 Android 手机</h2></div><button type="button" data-close aria-label="关闭无线连接引导">×</button></div>
      <ol class="wireless-progress" aria-label="连接步骤">${["手机准备", "输入配对码", "连接设备"].map((name, i) => `<li ${Math.min(step, 3) === i + 1 ? 'aria-current="step"' : ""} data-done="${step > i + 1}"><span>${step > i + 1 ? "✓" : i + 1}</span>${name}</li>`).join("")}</ol>
      <div class="wireless-body">${step === 0 ? `
        <h3>自动连接这台手机</h3><p>读取手机最新上报的地址，查找无线调试端口并验证连接。手机和电脑需在同一局域网。</p>
        <p class="wireless-note">连接不会开始控制，也不会恢复暂停的会话。</p>
        <div class="wireless-footer"><button data-manual>手动连接</button><button data-first-pair>首次配对</button><button class="primary" data-auto type="submit">重新查找并连接</button></div>` : step === 1 ? `
        <h3>先在手机上开启无线调试</h3><p>手机和电脑连接同一局域网。电脑可以使用 Wi-Fi，也可以接入同一路由器的网线。</p>
        <ol class="wireless-instructions"><li><strong>打开开发者选项</strong><span>在手机设置中搜索「开发者选项」。若尚未开启，在「关于手机」连续点击版本号，按系统提示开启。</span></li><li><strong>开启「无线调试」</strong><span>需要 Android 11 或更新版本；在手机上确认允许当前网络。</span></li><li><strong>选择「使用配对码配对」</strong><span>保持这个弹窗打开，下一步输入它显示的地址、端口和 6 位配对码。</span></li></ol>
        <p class="wireless-note">无需先插 USB。配对只建立连接；开始会话后，电脑才会查看或控制手机。</p>
        <div class="wireless-footer"><button data-direct>已配对，直接连接</button><button class="primary" data-next>手机已准备好</button></div>` : step === 2 ? `
        <h3>输入手机配对弹窗中的信息</h3><p>配对地址来自「使用配对码配对」弹窗，配对码仅用于本次连接。</p>
        <div class="wireless-discovery"><button type="button" data-scan>查找附近设备</button><span data-discovery-status role="status"></span><div data-services></div></div>
        <form data-pair-form><label>配对地址<input name="pairAddress" placeholder="192.168.1.8:37123" value="${escape(address)}" maxlength="80" required spellcheck="false" autocomplete="off"></label><label>6 位配对码<input name="pairCode" type="password" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="off" required placeholder="手机显示的 6 位数字"></label><p class="wireless-note">配对码关闭弹窗后可能失效；配对失败时请重新查看。</p><div class="wireless-footer"><button type="button" data-back>上一步</button><button class="primary" type="submit">配对这台手机</button></div></form>` : step === 3 ? `
        <div class="wireless-result">${paired ? "✓ 配对成功" : "连接已配对的手机"}</div><h3>填写无线调试主页面的连接地址</h3><p>关闭手机的配对码弹窗，回到「无线调试」主页面，查看「IP 地址和端口」。</p><p class="wireless-port-tip">连接端口通常与刚才的配对端口不同。</p>
        <div class="wireless-discovery"><button type="button" data-scan>查找可连接设备</button><span data-discovery-status role="status"></span><div data-services></div></div>
        <form data-connect-form><label>连接地址<input name="connectAddress" placeholder="192.168.1.8:40235" value="${escape(address)}" maxlength="80" required spellcheck="false" autocomplete="off"></label><div class="wireless-footer"><button type="button" data-back>返回配对</button><button class="primary" type="submit">连接手机</button></div></form>` : `
        <div class="wireless-result">✓ 无线设备已连接</div><h3>${escape(connected!.name)}</h3><p>${escape(connected!.id)}</p><p>接下来连接手机 App，并在手机上确认所需权限。连接完成后即可使用现有的查看、控制与暂停功能。</p><p class="wireless-note">更换网络或重新开启无线调试后，端口可能变化。届时可选择「已配对，直接连接」，填写手机最新显示的连接地址。</p><div class="wireless-footer"><button data-finish>完成</button><button class="primary" data-prepare>连接手机 App</button></div>`}
        <p class="wireless-error" role="alert" hidden></p><details class="wireless-help"><summary>找不到设备或连接失败？</summary><p>确认两端在同一局域网，手机保持无线调试开启。访客 Wi-Fi、公司网络的设备隔离可能阻止连接。自动发现不可用时，可以手动输入地址。</p><p>Windows 检查专用网络防火墙；macOS 检查防火墙与本地网络权限。若 ADB 不支持配对，请更新 Android Platform Tools。</p></details></div>`;
    dialog.querySelector("[data-close]")!.addEventListener("click", dismiss);
    dialog.querySelector("[data-auto]")?.addEventListener("click", () => void autoConnect());
    dialog.querySelector("[data-manual]")?.addEventListener("click", () => { step = 3; render(); void scan(); });
    dialog.querySelector("[data-first-pair]")?.addEventListener("click", () => { step = 1; render(); });
    dialog.querySelector("[data-next]")?.addEventListener("click", () => { step = 2; render(); void scan(); });
    dialog.querySelector("[data-direct]")?.addEventListener("click", () => { step = 3; pairingHost = ""; render(); void scan(); });
    dialog.querySelector("[data-back]")?.addEventListener("click", () => { discoveryVersion++; step = step === 3 ? 2 : 1; address = ""; paired = false; render(); });
    dialog.querySelector("[data-scan]")?.addEventListener("click", () => void scan());
    dialog.querySelector("[data-pair-form]")?.addEventListener("submit", event => {
      event.preventDefault(); if (busy) return;
      const input = dialog.querySelector<HTMLInputElement>('[name="pairCode"]')!;
      const code = input.value; input.value = "";
      address = dialog.querySelector<HTMLInputElement>('[name="pairAddress"]')!.value.trim();
      void work(async () => {
        const result = await window.phones.pairWireless(address, code);
        if (!dialog.isConnected) return;
        pairingHost = result.address.split(":")[0]; paired = true; address = ""; step = 3; render(); void scan();
      });
    });
    dialog.querySelector("[data-connect-form]")?.addEventListener("submit", event => {
      event.preventDefault(); if (busy) return;
      address = dialog.querySelector<HTMLInputElement>('[name="connectAddress"]')!.value.trim();
      void work(async () => {
        connected = await window.phones.connectWireless(address);
        if (!dialog.isConnected) return;
        step = 4; render();
      });
    });
    for (const [selector, prepare] of [["[data-finish]", false], ["[data-prepare]", true]] as const) {
      dialog.querySelector(selector)?.addEventListener("click", () => { const device = connected!; dismiss(); onConnected(device, prepare); });
    }
  }
  async function scan(): Promise<void> {
    const version = ++discoveryVersion, scanStep = step;
    const label = dialog.querySelector<HTMLElement>("[data-discovery-status]"); if (label) label.textContent = "正在查找…";
    let result;
    try { result = await window.phones.discoverWireless(step === 3 && !pairingHost ? deviceId : undefined); }
    catch { result = { services: [], error: "自动发现暂不可用，请手动输入手机地址。" }; }
    if (!dialog.isConnected || version !== discoveryVersion || step !== scanStep) return;
    const previousServices = services;
    services = result.services.filter(item => item.kind === (step === 2 ? "pairing" : "connect") && (step !== 3 || !pairingHost || item.address.split(":")[0] === pairingHost));
    label!.textContent = result.error || (services.length ? "已检查当前端口，点击可达地址填入" : result.phoneIps?.length ? `手机当前 IP：${result.phoneIps.join("、")}，尚未发现连接端口` : "暂未发现，可重新查找或手动填写");
    const list = dialog.querySelector<HTMLElement>("[data-services]")!;
    list.innerHTML = services.map((item, i) => `<button type="button" data-candidate="${i}" data-unreachable="${item.reachable === false}" ${item.reachable === false ? "disabled" : ""} title="${escape(item.reason || "")}">${escape(item.address)}${item.reachable === false ? " · 不可达" : item.reachable ? " · 可达" : ""}</button>`).join("");
    const available = services.filter(item => item.reachable !== false);
    const addressInput = dialog.querySelector<HTMLInputElement>(step === 2 ? '[name="pairAddress"]' : '[name="connectAddress"]');
    if (addressInput && available.length === 1 && (!addressInput.value || previousServices.some(item => item.address === addressInput.value))) addressInput.value = available[0].address;
    list.querySelectorAll<HTMLButtonElement>("[data-candidate]").forEach(button => button.addEventListener("click", () => {
      const input = dialog.querySelector<HTMLInputElement>(step === 2 ? '[name="pairAddress"]' : '[name="connectAddress"]')!;
      input.value = services[Number(button.dataset.candidate)].address; input.focus();
    }));
  }
  async function autoConnect(): Promise<void> {
    if (busy || !deviceId) return;
    await work(async () => {
      connected = await window.phones.autoConnectWireless(deviceId);
      if (dialog.isConnected) { step = 4; render(); }
    });
  }
  async function work(action: () => Promise<void>): Promise<void> {
    busy = true; discoveryVersion++;
    const submit = dialog.querySelector<HTMLButtonElement>('button[type="submit"]');
    const submitLabel = submit?.textContent;
    if (submit) submit.textContent = step === 2 ? "正在配对…" : step === 0 ? "正在查找并验证连接…" : "正在连接…";
    dialog.querySelector<HTMLElement>(".wireless-error")!.hidden = true;
    dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach(element => element.disabled = true);
    dialog.setAttribute("aria-busy", "true");
    try { await action(); }
    catch (error) { if (dialog.isConnected) { const label = dialog.querySelector<HTMLElement>(".wireless-error")!; label.hidden = false; label.textContent = (error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ""); } }
    finally {
      busy = false; dialog.removeAttribute("aria-busy");
      if (submit?.isConnected) submit.textContent = submitLabel || "重试";
      dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach(element => element.disabled = element.dataset.unreachable === "true");
    }
  }
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => { discoveryVersion++; dialog.remove(); });
  document.body.append(dialog); render(); dialog.showModal();
  if (deviceId) void autoConnect();
}
