import { phoneActive, type PhonesApi, type PhonesSnapshot } from "../shared/phones";
import { groupPhoneDevices } from "../shared/phone-devices";
declare global { interface Window { phones: PhonesApi; } }
let installed = false;
export function installPhoneStatus(): void {
  if (installed || !window.phones || window.workspacePane) return; installed = true;
  const badge = document.createElement("a"); badge.className = "phone-global-status"; badge.href = "./phones.html"; badge.hidden = true; badge.setAttribute("role", "status");
  document.body.append(badge);
  const render = (snapshot: PhonesSnapshot) => {
    const devices = groupPhoneDevices(snapshot.devices).map(group => group.device);
    const active = devices.filter(phoneActive);
    const uncertain = devices.filter(device => device.state?.phase === "disconnected");
    badge.hidden = !active.length && !uncertain.length;
    badge.textContent = active.length ? `${active.length} 台手机会话进行中 · ${active.map(device => device.name).join("、")}` : `${uncertain.length} 台手机连接中断 · 查看状态`;
    badge.dataset.uncertain = String(!active.length && !!uncertain.length);
  };
  window.phones.onChanged(render); void window.phones.snapshot().then(render).catch(() => {});
}
