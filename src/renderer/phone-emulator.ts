import type { PhoneDevice } from "../shared/phones";

/** Launch a configured local AVD; app pairing remains an explicit subsequent step. */
export function openPhoneEmulator(connected: (device: PhoneDevice) => void): void {
  if (document.querySelector(".phone-emulator-dialog")) return;
  const dialog = document.createElement("dialog");
  dialog.className = "phone-connect-dialog phone-emulator-dialog";
  dialog.setAttribute("aria-label", "连接本机模拟器");
  dialog.innerHTML = '<header><h2>连接本机模拟器</h2><button data-close aria-label="关闭模拟器窗口">×</button></header><p>选择电脑上已有的虚拟安卓设备。已运行的模拟器会直接连接。</p><div class="phone-connect-choices" data-emulator-list></div><p role="status" data-emulator-status>正在查找本机模拟器…</p>';
  dialog.querySelector("[data-close]")!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog); dialog.showModal();
  const status = dialog.querySelector<HTMLElement>("[data-emulator-status]")!;
  const list = dialog.querySelector<HTMLElement>("[data-emulator-list]")!;
  const load = async () => {
    try {
      const names = await window.phones.listEmulators();
      if (!dialog.isConnected) return;
      status.textContent = names.length ? "启动后会自动检测连接，首次启动可能需要一点时间。" : "尚未创建虚拟设备。请在 Android Studio 的 Device Manager 中创建模拟器，再回来连接。";
      for (const name of names) {
        const button = document.createElement("button"); button.dataset.emulatorName = name;
        const label = document.createElement("strong"); label.textContent = name;
        const caption = document.createElement("small"); caption.textContent = "启动 / 连接";
        const text = document.createElement("span"); text.append(label, caption); button.append(text); list.append(button);
        button.addEventListener("click", async () => {
          list.querySelectorAll("button").forEach(item => item.disabled = true);
          status.setAttribute("role", "status"); status.textContent = `正在启动并连接 ${name}…`;
          try {
            const device = await window.phones.connectEmulator(name);
            if (dialog.isConnected) { connected(device); dialog.close(); }
          } catch (error) {
            status.setAttribute("role", "alert"); status.textContent = (error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, "");
            list.querySelectorAll("button").forEach(item => item.disabled = false);
          }
        });
      }
    } catch (error) {
      status.setAttribute("role", "alert"); status.textContent = (error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, "");
    }
  };
  void load();
}
