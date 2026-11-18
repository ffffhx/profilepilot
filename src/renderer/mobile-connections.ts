import type { MobileSnapshot, MobilePairing } from "../shared/mobile";

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function createMobileConnections(): (() => Promise<void>) | undefined {
  if (!window.mobile) return;
  const dialog = document.createElement("dialog"); dialog.className = "mobile-dialog"; dialog.setAttribute("aria-label", "移动版连接"); document.body.append(dialog);
  let state: MobileSnapshot | undefined, pairing: MobilePairing | undefined, busy = false, message = "", address = "";
  let qrMode: "web" | "app" = "web";
  function render(): void {
    if (!dialog.open) return;
    const focus = document.activeElement instanceof HTMLInputElement && dialog.contains(document.activeElement) ? { name: document.activeElement.name, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
    const qrSrc = pairing ? (qrMode === "web" ? pairing.webQr || pairing.qr : pairing.qr) : "";
    dialog.innerHTML = `<header><div><span class="mobile-eyebrow">PROFILEPILOT MOBILE</span><h2>把工作区带在身边</h2></div><button data-mobile="close" aria-label="关闭">✕</button></header><p>手机扫码即可在 iPhone Safari / Android Chrome 直接查看、创建并审批电脑任务，无需安装手机 App。</p>
      <div class="mobile-service"><div><strong>移动版连接</strong><small>${state?.listening ? `已开启 · ${esc(state.computerName)}` : "开启后可与自己的手机安全配对"}</small></div><button data-mobile="toggle" ${busy || !state ? "disabled" : ""}>${state?.enabled ? "关闭连接" : "开启连接"}</button></div>
      ${state?.enabled ? `<label class="mobile-address">手机可访问的电脑地址<input name="mobile-address" list="mobile-endpoints" placeholder="https://192.168.1.10:端口" value="${esc(address)}"><datalist id="mobile-endpoints">${state.endpoints.map(url => `<option value="${esc(url)}"></option>`).join("")}</datalist></label><p class="mobile-help">同一 Wi-Fi 或 Tailscale 组网可直接连接；首次在手机浏览器打开自签名 HTTPS 地址时，点击「高级 → 继续访问」即可完成加密配对。</p><div class="mobile-actions"><button class="primary" data-mobile="pair" ${busy || !state.listening ? "disabled" : ""}>${pairing ? "重新生成配对码" : "生成配对二维码"}</button><button data-mobile="save" ${busy ? "disabled" : ""}>保存连接地址</button></div>` : ""}
      ${pairing && state?.enabled ? `<section class="mobile-pair"><img src="${esc(qrSrc)}" alt="手机配对二维码"><div><h3>${qrMode === "web" ? "手机相机或浏览器扫码即用" : "在原生手机 App 中扫码"}</h3><p>${qrMode === "web" ? "用 iPhone 相机 / Safari 或 Android Chrome 扫码直接打开网页工作台（可添加到主屏幕）。" : "打开 ProfilePilot 安卓 App 扫码连接电脑。"}</p><p data-pair-countdown></p><div class="mobile-actions"><button class="primary" data-mobile="copy-web">复制网页配对链接</button><button data-mobile="copy">复制 App 配对码</button><button data-mobile="switch-qr">${qrMode === "web" ? "切换为 App 二维码" : "切换为免安装网页二维码"}</button></div><small>一次性配对链接包含临时授权，仅交给自己的手机。</small></div></section>` : ""}
      <section class="mobile-devices"><h3>已授权手机 <span>${state?.devices.length || 0}</span></h3>${state?.devices.length ? state.devices.map(device => `<div class="mobile-device"><div><strong>${esc(device.name)}</strong><small>${device.lastSeen ? `最近连接 ${esc(new Date(device.lastSeen).toLocaleString())}` : "等待首次连接"}</small></div><button data-mobile="permission" data-id="${esc(device.id)}" ${busy ? "disabled" : ""}>${device.canControl ? "可发任务 · 改为仅查看" : "仅查看 · 允许操作"}</button><button data-mobile="revoke" data-id="${esc(device.id)}" ${busy ? "disabled" : ""}>移除</button></div>`).join("") : '<p class="mobile-help">尚未连接手机。首次配对后，电脑会记住这台设备。</p>'}</section>
      <footer><span>支持 iPhone Safari / Android Chrome 网页工作台与安卓 App</span><button data-mobile="apk">打开 APK 所在位置</button></footer><p class="mobile-notice" role="status">${esc(message || state?.error || "")}</p>`;
    if (focus) { const input = dialog.querySelector<HTMLInputElement>(`input[name="${focus.name}"]`); input?.focus(); if (focus.start !== null) input?.setSelectionRange(focus.start, focus.end); }
    countdown();
  }
  function countdown(): void { const el = dialog.querySelector("[data-pair-countdown]"); if (el && pairing) { const seconds = Math.max(0, Math.ceil((Date.parse(pairing.expiresAt) - Date.now()) / 1000)); el.textContent = seconds ? `二维码 ${seconds} 秒后失效 · 仅可配对一次` : "二维码已过期，请重新生成"; } }
  dialog.addEventListener("input", event => { if (event.target instanceof HTMLInputElement) address = event.target.value; });
  dialog.addEventListener("click", async event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-mobile]"); if (!button) return;
    const action = button.dataset.mobile;
    if (action === "close") { dialog.close(); pairing = undefined; return; }
    if (action === "switch-qr") { qrMode = qrMode === "web" ? "app" : "web"; render(); return; }
    if (busy) return; busy = true; message = ""; render();
    try {
      if (action === "toggle" && state) { state = await window.mobile.configure({ enabled: !state.enabled }); pairing = undefined; address ||= state.endpoints[0] || ""; }
      if (action === "save" && state) { state = await window.mobile.configure({ enabled: state.enabled, advertisedUrl: address }); pairing = undefined; message = "连接地址已保存。"; }
      if (action === "pair") { pairing = await window.mobile.pair(address); qrMode = "web"; }
      if (action === "copy-web" && pairing) { await navigator.clipboard.writeText(pairing.webPairUrl); message = "网页配对链接已复制，可在手机 Safari 或 Chrome 打开。"; }
      if (action === "copy" && pairing) { await navigator.clipboard.writeText(pairing.uri); message = "App 配对链接已复制。"; }
      if (action === "apk") await window.mobile.openApkFolder();
      if (action === "revoke" && button.dataset.id) { state = await window.mobile.revoke(button.dataset.id); pairing = undefined; message = "授权已撤销，电脑上的任务继续保留。"; }
      if (action === "permission" && button.dataset.id) { const device = state?.devices.find(d => d.id === button.dataset.id); if (device) state = await window.mobile.updateDevice(device.id, { canControl: !device.canControl }); }
    } catch (error) { message = (error as Error).message; }
    busy = false; render();
  });
  window.mobile.onChanged(value => { state = value; render(); });
  window.setInterval(countdown, 1000);
  return async () => { dialog.showModal(); render(); try { state = await window.mobile.snapshot(); address = state.advertisedUrl || state.endpoints[0] || ""; } catch (error) { message = (error as Error).message; } render(); };
}
