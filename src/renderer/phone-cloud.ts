export function openPhoneCloud(onCreated: (id: string) => void): void {
  const dialog = document.createElement("dialog");
  dialog.className = "phone-connect-dialog";
  dialog.setAttribute("aria-label", "通过服务器同步手机状态");
  dialog.innerHTML = `<header><h2>通过服务器同步状态</h2><button data-close aria-label="关闭">×</button></header><p>手机和电脑各自联网即可，无需 USB 或同一 Wi-Fi。</p><p>在手机 ProfilePilot App 的「设备」页扫码或粘贴链接，确认开启状态同步。</p><details><summary>服务器地址</summary><input data-url type="url" aria-label="状态服务器地址" placeholder="留空使用已配置的腾讯云服务"></details><button data-create class="primary">生成手机配对码</button><div data-result role="status"></div>`;
  document.body.append(dialog);
  dialog.querySelector("[data-close]")!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  const button = dialog.querySelector<HTMLButtonElement>("[data-create]")!;
  const result = dialog.querySelector<HTMLElement>("[data-result]")!;
  button.onclick = async () => {
    button.disabled = true; result.textContent = "正在生成配对码…";
    try {
      const url = dialog.querySelector<HTMLInputElement>("[data-url]")!.value.trim();
      const paired = await window.phones.cloudPair(url || undefined);
      onCreated(`cloud-${paired.id}`);
      if (!dialog.isConnected) return;
      result.replaceChildren();
      const img = document.createElement("img"); img.src = paired.qrCode; img.alt = "手机状态同步配对码"; img.width = 260; img.height = 260;
      const note = document.createElement("p"); note.textContent = `配对码有效至 ${new Date(paired.expiresAt).toLocaleTimeString()}。在手机确认后自动更新状态。`;
      const link = document.createElement("textarea"); link.readOnly = true; link.value = paired.uri; link.setAttribute("aria-label", "手机状态同步配对链接"); link.rows = 3;
      const copy = document.createElement("button"); copy.textContent = "复制配对链接";
      copy.onclick = () => { void navigator.clipboard.writeText(paired.uri).then(() => { copy.textContent = "已复制"; }).catch(() => { link.select(); }); };
      result.append(img, note, link, copy); button.hidden = true;
    } catch (error) { result.textContent = (error as Error).message; button.disabled = false; }
  };
  dialog.showModal();
}
