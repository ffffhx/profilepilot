import { groupPhoneDevices, type PhoneDeviceGroup } from "./phone-devices";
import { phoneConnectionPresentation, phonePresentation } from "./phone-presentation";
import type { PhoneDevice } from "./phones";

export type PhoneListFilter = "all" | "online" | "offline";

/** A list row represents hardware, not an individual USB/Wi-Fi route. */
export function phoneListItem(group: PhoneDeviceGroup) {
  const device = group.device;
  const view = phonePresentation(device);
  const online = phoneConnectionPresentation(group).connected;
  const available = group.routes.some(route => route.connection === "device");
  const unauthorized = group.routes.some(route => route.connection === "unauthorized");
  const basic = group.routes.find(route => route.basic && !["stopped", "disconnected"].includes(route.basic.phase))?.basic;
  const occupied = phoneConnectionPresentation(group).occupied;
  const transports = [...new Set(group.routes.filter(route => route.connection === "device").map(route => route.transport))];
  if (!transports.length) transports.push(device.transport);
  const connection = transports.map(transport => ({ usb: "USB", wifi: "Wi-Fi", emulator: "本机", cloud: "状态同步", registered: "待配置连接" })[transport]).join(" / ");
  const status = device.pending || (online ? "已连接" : available ? "可连接" : unauthorized ? "等待授权" : view.emulator ? "未启动" : view.cloudOnline ? "仅状态同步" : device.registration ? "已添加 · 未连接控制" : "未连接");
  const session = basic ? basic.phase === "disconnected" ? "连接中断" : basic.phase === "paused" ? "已暂停" : basic.mode === "view" ? "正在查看" : "正在操作"
    : occupied ? view.paused ? "已暂停" : `${device.state?.controller || "Agent"} · ${device.state?.mode === "view" ? "正在查看" : "正在操作"}` : online ? "空闲" : "—";
  const action = basic ? "basic-open" : occupied ? "details" : "basic-control";
  const actionLabel = "查看手机";
  const actionHint = online ? "" : unauthorized ? "请先在手机上确认调试授权" : view.emulator ? "模拟器未启动，请在设备详情中启动" : "设备未连接，连接后即可查看";
  return { id: device.id, name: view.displayName, kind: view.emulator ? "本机模拟器" : "Android 设备", emulator: view.emulator,
    online, available, occupied: occupied || !!basic, connection, status, tone: online ? "ready" : available || unauthorized || device.pending ? "warning" : "neutral", session, action, actionLabel, actionHint,
    pending: !!device.pending, search: [view.displayName, device.model, ...group.routes.map(route => route.id)].join(" ").toLocaleLowerCase() };
}

export function phoneList(devices: PhoneDevice[], search = "", filter: PhoneListFilter = "all", preferredId = "") {
  const all = groupPhoneDevices(devices, preferredId).map(phoneListItem);
  const query = search.trim().toLocaleLowerCase();
  return { all, online: all.filter(item => item.online).length,
    items: all.filter(item => (!query || item.search.includes(query)) && (filter === "all" || item.online === (filter === "online"))) };
}
