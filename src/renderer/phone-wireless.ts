import type { PhoneDevice, PhoneNearbyApp, PhoneWirelessDiscovery, PhoneWirelessService } from "../shared/phones";

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function openPhoneWireless(onConnected: (device: PhoneDevice, prepare: boolean) => void, deviceId?: string): void {
  if (document.querySelector(".phone-wireless-dialog")) return;
  const dialog = document.createElement("dialog");
  dialog.className = "phone-wireless-dialog";
  dialog.setAttribute("aria-labelledby", "phone-wireless-title");
  let step = deviceId ? 0 : 1, busy = false, services: PhoneWirelessService[] = [], pairingHost = "", address = "", paired = false;
  let connected: PhoneDevice | undefined;
  let apps: PhoneNearbyApp[] = [], selectedApp: PhoneNearbyApp | undefined;
  let discoveryVersion = 0;
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  function stopScan(): void { discoveryVersion++; clearTimeout(scanTimer); }
  const dismiss = () => { stopScan(); dialog.close(); dialog.remove(); };
  function render(): void {
    stopScan();
    dialog.innerHTML = `<div class="wireless-heading"><div><p class="wireless-eyebrow">手机 · 局域网连接</p><h2 id="phone-wireless-title">无线连接 Android 手机</h2></div><button type="button" data-close aria-label="关闭无线连接引导">×</button></div>
      <ol class="wireless-progress" aria-label="连接步骤">${["发现设备", "输入配对码", "连接设备"].map((name, i) => `<li ${Math.min(step, 3) === i + 1 ? 'aria-current="step"' : ""} data-done="${step > i + 1}"><span>${step > i + 1 ? "✓" : i + 1}</span>${name}</li>`).join("")}</ol>
      <div class="wireless-body">${step === 0 ? `
        <h3>自动连接这台手机</h3><p>读取手机最新上报的地址，查找无线调试端口并验证连接。手机和电脑需在同一局域网。</p>
        <p class="wireless-note">连接不会开始控制，也不会恢复暂停的会话。</p>
        <div class="wireless-footer"><button data-manual>手动连接</button><button data-first-pair>首次配对</button><button class="primary" data-auto type="submit">重新查找并连接</button></div>` : step === 1 ? `
        <h3>附近的 ProfilePilot 设备</h3><p>手机打开 ProfilePilot → 添加到电脑 → 开启「允许局域网发现」，并连接同一局域网。无需先开启无线调试；电脑也可以接入同一路由器的网线。</p>
        <div class="wireless-discovery wireless-nearby"><button type="button" data-scan>重新扫描</button><span data-discovery-status role="status">正在扫描…</span><div data-apps></div><div data-services></div></div>
        <div data-selected-app hidden></div>
        <details class="wireless-setup"><summary>首次连接怎么准备？</summary><ol class="wireless-instructions"><li><strong>打开开发者选项</strong><span>在手机设置中搜索「开发者选项」。若尚未开启，在「关于手机」连续点击版本号，按系统提示开启。</span></li><li><strong>开启「无线调试」</strong><span>在手机上确认允许当前网络。</span></li><li><strong>选择「使用配对码配对」</strong><span>保持这个弹窗打开，下一步输入它显示的 6 位配对码。</span></li></ol></details>
        <p class="wireless-note">发现设备后，首次连接仍需系统配对。「允许通过此网络进行无线调试」只是网络授权，仍需使用 6 位码完成电脑配对。</p>
        <div class="wireless-footer"><button data-direct>已配对，直接连接</button><button data-next>手动输入配对信息</button></div>` : step === 2 ? `
        <h3>输入手机配对弹窗中的信息</h3><p>配对地址来自「使用配对码配对」弹窗，配对码仅用于本次连接。</p>
        <div class="wireless-discovery"><button type="button" data-scan>查找附近设备</button><span data-discovery-status role="status"></span><div data-services></div></div>
        <form data-pair-form><label>配对地址<input name="pairAddress" placeholder="192.168.1.8:37123" value="${escape(address)}" maxlength="80" required spellcheck="false" autocomplete="off"></label><label>6 位配对码<input name="pairCode" type="password" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="off" required placeholder="手机显示的 6 位数字"></label><p class="wireless-note">配对码关闭弹窗后可能失效；配对失败时请重新查看。</p><div class="wireless-footer"><button type="button" data-back>上一步</button><button class="primary" type="submit">配对这台手机</button></div></form>` : step === 3 ? `
        <div class="wireless-result">${paired ? "✓ 配对成功" : "连接已配对的手机"}</div><h3>填写无线调试主页面的连接地址</h3><p>关闭手机的配对码弹窗，回到「无线调试」主页面，查看「IP 地址和端口」。</p><p class="wireless-port-tip">连接端口通常与刚才的配对端口不同。</p>
        <div class="wireless-discovery"><button type="button" data-scan>查找可连接设备</button><span data-discovery-status role="status"></span><div data-services></div></div>
        <form data-connect-form><label>连接地址<input name="connectAddress" placeholder="192.168.1.8:40235" value="${escape(address)}" maxlength="80" required spellcheck="false" autocomplete="off"></label><div class="wireless-footer"><button type="button" data-back>返回配对</button><button class="primary" type="submit">连接手机</button></div></form>` : `
        <div class="wireless-result">✓ 无线设备已连接</div><h3>${escape(connected!.name)}</h3><p>${escape(connected!.id)}</p><p>现在可以完成连接，在设备页选择免安装查看或控制。也可安装手机 App，获得控件识别、中文填写和手机端暂停等功能。</p><p class="wireless-note">更换网络或重新开启无线调试后，端口可能变化。届时可选择「已配对，直接连接」，填写手机最新显示的连接地址。</p><div class="wireless-footer"><button data-finish>完成</button><button data-prepare>安装并连接 App</button></div>`}
        <div class="wireless-error" role="alert" hidden></div><details class="wireless-help"><summary>找不到设备或连接失败？</summary><p>请更新并打开手机 ProfilePilot，确认两端在同一局域网。App 被强行停止或系统休眠时，请重新打开。访客 Wi-Fi、公司网络的设备隔离可能阻止发现；旧版 App 可开启无线调试后扫描，或手动输入地址。</p><p>Windows 检查专用网络防火墙；macOS 检查防火墙与本地网络权限。若 ADB 不支持配对，请更新 Android Platform Tools。</p></details></div>`;
    dialog.querySelector("[data-close]")!.addEventListener("click", dismiss);
    dialog.querySelector("[data-auto]")?.addEventListener("click", () => void autoConnect());
    dialog.querySelector("[data-manual]")?.addEventListener("click", () => { step = 3; render(); void scan(); });
    dialog.querySelector("[data-first-pair]")?.addEventListener("click", () => { step = 1; render(); void scan(); });
    dialog.querySelector("[data-next]")?.addEventListener("click", () => { step = 2; render(); void scan(); });
    dialog.querySelector("[data-direct]")?.addEventListener("click", () => { step = 3; pairingHost = ""; render(); void scan(); });
    dialog.querySelector("[data-back]")?.addEventListener("click", () => { step = step === 3 ? 2 : 1; address = ""; paired = false; selectedApp = undefined; render(); void scan(); });
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
    clearTimeout(scanTimer);
    const version = ++discoveryVersion, scanStep = step;
    const label = dialog.querySelector<HTMLElement>("[data-discovery-status]"); if (label) label.textContent = "正在查找…";
    const scanButton = dialog.querySelector<HTMLButtonElement>("[data-scan]"); if (scanButton) scanButton.disabled = true;
    let result: PhoneWirelessDiscovery;
    try { result = await window.phones.discoverWireless(step === 3 && !pairingHost ? deviceId : undefined); }
    catch { result = { services: [], error: "自动发现暂不可用，请手动输入手机地址。" }; }
    if (!dialog.isConnected || version !== discoveryVersion || step !== scanStep) return;
    if (scanButton) scanButton.disabled = false;
    if (step === 1) {
      apps = result.apps || []; services = result.services;
      renderNearby(result);
      scanTimer = setTimeout(() => void scan(), 5000);
      return;
    }
    const previousServices = services;
    services = result.services.filter(item => item.kind === (step === 2 ? "pairing" : "connect") && (!selectedApp || item.address.split(":")[0] === selectedApp.ip) && (step !== 3 || !pairingHost || item.address.split(":")[0] === pairingHost));
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
  function renderNearby(result: PhoneWirelessDiscovery): void {
    const label = dialog.querySelector<HTMLElement>("[data-discovery-status]")!;
    label.textContent = apps.length ? `发现 ${apps.length} 台运行 ProfilePilot 的设备 · 自动刷新`
      : result.appError || (services.length ? "发现无线调试设备；等待 ProfilePilot App 回应 · 自动刷新" : "暂未发现设备，请打开手机 App · 自动刷新中");
    dialog.querySelector<HTMLElement>("[data-apps]")!.innerHTML = apps.map((app, index) => `<button type="button" class="wireless-app" data-nearby-app="${index}" aria-pressed="${selectedApp?.id === app.id}"><span><strong>${escape(app.name)}</strong><small>${escape(app.ip)} · ProfilePilot${app.variant === "debug" ? " 开发版" : ""}</small></span><span>${app.wirelessDebugging === "enabled" ? "选择连接" : app.wirelessDebugging === "disabled" ? "未开启无线调试" : "选择并设置"} ›</span></button>`).join("");
    dialog.querySelectorAll<HTMLButtonElement>("[data-nearby-app]").forEach(button => button.addEventListener("click", () => {
      selectedApp = apps[Number(button.dataset.nearbyApp)];
      renderNearby(result);
      dialog.querySelector<HTMLElement>("[data-selected-app]")!.scrollIntoView({ block: "nearest" });
    }));
    const selected = dialog.querySelector<HTMLElement>("[data-selected-app]")!;
    selected.hidden = !selectedApp;
    if (selectedApp) {
      const current = apps.find(app => app.id === selectedApp!.id);
      if (current) selectedApp = current;
      selected.innerHTML = `<strong>${escape(selectedApp.name)}</strong><p>${current ? selectedApp.wirelessDebugging === "disabled" ? "已发现手机 App。请在这台手机的 ProfilePilot 中点击「Wi-Fi 无线调试」，开启后选择「使用配对码配对」。" : "请在这台手机打开「无线调试 → 使用配对码配对」，然后输入配对码；已配对可直接连接。" : "这台设备已不在本轮扫描中，请重新打开手机 App 并检查网络。"}</p>`;
      if (current && selectedApp.wirelessDebugging !== "enabled") dialog.querySelector<HTMLDetailsElement>(".wireless-setup")!.open = true;
    }
    const candidates = services.map((item, index) => ({ item, index })).filter(({ item }) => !selectedApp || item.address.split(":")[0] === selectedApp.ip);
    const list = dialog.querySelector<HTMLElement>("[data-services]")!;
    list.innerHTML = candidates.map(({ item, index }) => `<button type="button" data-candidate="${index}" ${item.reachable === false ? "disabled" : ""}>${escape(item.address)} · ${item.kind === "pairing" ? "配对" : "连接"}${item.reachable === false ? "（不可达）" : ""}</button>`).join("");
    list.querySelectorAll<HTMLButtonElement>("[data-candidate]").forEach(button => button.addEventListener("click", () => {
      const item = services[Number(button.dataset.candidate)]; address = item.address; step = item.kind === "pairing" ? 2 : 3;
      render(); void scan();
    }));
    const errorLabel = dialog.querySelector<HTMLElement>(".wireless-error")!;
    errorLabel.hidden = !result.error || apps.length > 0;
    if (result.error && !apps.length) errorLabel.textContent = result.error;
  }
  async function autoConnect(): Promise<void> {
    if (busy || !deviceId) return;
    await work(async () => {
      connected = await window.phones.autoConnectWireless(deviceId);
      if (dialog.isConnected) { step = 4; render(); }
    });
  }
  async function work(action: () => Promise<void>): Promise<void> {
    busy = true; stopScan();
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
  dialog.addEventListener("close", () => { stopScan(); dialog.remove(); });
  document.body.append(dialog); render(); dialog.showModal();
  if (deviceId) void autoConnect();
  else void scan();
}
