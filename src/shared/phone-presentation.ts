import { phoneActive, type PhoneDevice, type PhoneSetting } from "./phones";
import type { PhoneDeviceGroup } from "./phone-devices";

export interface PhoneSettingRow {
  key: PhoneSetting; label: string; description: string;
  status: "enabled" | "disabled" | "unknown"; value: string;
}
export type PhoneConnectionCondition = "ready" | "blocked" | "unknown";
export interface PhoneRoutePresentation {
  transport: "usb" | "wifi";
  device?: PhoneDevice;
  condition: PhoneConnectionCondition;
  connected: boolean;
  detected: boolean;
  unresponsive: boolean;
  unauthorized: boolean;
  label: string;
  note: string;
  setting: PhoneSettingRow;
}

/** Connection to THIS computer comes from local evidence; reports only describe phone readiness. */
export function phoneConnectionPresentation(group: PhoneDeviceGroup, now = Date.now()) {
  const view = phonePresentation(group.device, now);
  const live = group.routes.filter(route => phonePresentation(route, now).directKnown && route.state?.phase !== "disconnected" && route.state?.readiness?.computerConnected !== false);
  const connected = live.length > 0;
  const occupied = group.routes.some(route => {
    const state = phonePresentation(route, now);
    return state.active || state.paused;
  });
  const developer = view.settings.find(row => row.key === "developerOptions");
  const routes: PhoneRoutePresentation[] = view.emulator ? [] : (["usb", "wifi"] as const).map(transport => {
    const candidates = group.routes.filter(route => route.transport === transport);
    const device = candidates.find(route => phonePresentation(route, now).directKnown)
      || candidates.find(route => route.connection === "device")
      || candidates.find(route => route.connection === "unauthorized") || candidates[0];
    const connected = !!device && live.includes(device);
    const detected = device?.connection === "device";
    const unresponsive = !!device && phonePresentation(device, now).unresponsive;
    const unauthorized = device?.connection === "unauthorized";
    const setting = view.settings.find(row => row.key === (transport === "usb" ? "usbDebugging" : "wirelessDebugging"))!;
    // A current authorized transport is stronger evidence than an unreadable system switch.
    const condition: PhoneConnectionCondition = detected ? "ready"
      : setting.status === "disabled" || developer?.status === "disabled" ? "blocked"
      : setting.status === "enabled" && developer?.status === "enabled" ? "ready" : "unknown";
    const label = connected ? "已连接" : unauthorized ? "等待授权" : unresponsive ? "App 未响应" : detected ? "已就绪"
      : condition === "blocked" ? "未就绪" : condition === "unknown" ? "待确认" : transport === "usb" ? "等待插线" : "待连接";
    const note = connected ? "已与这台电脑建立连接" : unauthorized ? "请在手机上允许此电脑的调试连接"
      : unresponsive ? "电脑能识别此连接，但手机 App 暂时没有回复"
      : detected ? "电脑已识别手机，等待连接手机 App"
      : condition === "blocked" ? developer?.status === "disabled" ? "请先在手机上开启开发者选项" : `请在手机上开启${transport === "usb" ? "USB 调试" : "无线调试"}`
      : transport === "usb" ? "插入数据线后自动识别" : "连接时需处于同一网络并完成配对";
    return { transport, device, condition, connected, detected, unresponsive, unauthorized, label, note, setting };
  });
  const condition: PhoneConnectionCondition = view.missing ? "blocked" : !view.permissionsReady ? "unknown"
    : view.emulator ? connected ? "ready" : "unknown"
    : routes.some(route => route.condition === "ready") ? "ready"
    : routes.every(route => route.condition === "blocked") ? "blocked" : "unknown";
  const ready = routes.filter(route => route.condition === "ready").map(route => route.transport === "usb" ? "USB" : "Wi-Fi");
  const unresponsive = !connected && view.unresponsive;
  const label = unresponsive && !view.known ? "暂时无法读取" : condition === "ready" ? "连接条件已就绪" : view.missing ? "权限未就绪" : condition === "blocked" ? "暂不能连接" : "待确认";
  const note = view.missing ? `${view.missing} 项控制权限未就绪，请查看下方提示。`
    : unresponsive && !view.known ? "手机未返回最新状态，暂时无法判断权限是否开启。"
    : !view.known ? "等待手机更新状态后，再确认连接条件。"
    : !view.permissionsReady ? "部分控制权限尚未确认。"
    : condition === "ready" ? view.emulator ? "模拟器与控制权限已就绪。" : connected ? `已验证 ${live.map(route => route.transport === "usb" ? "USB" : "Wi-Fi").filter((value, index, all) => all.indexOf(value) === index).join("、")} 连接。` : `权限与调试开关已就绪；${ready.join(" / ")} 连接尚未验证。`
    : condition === "blocked" ? "USB 和 Wi-Fi 均未就绪，请开启下方调试开关。"
    : view.emulator ? "启动模拟器后检测连接条件。" : "控制权限已开启，连接方式仍待确认。";
  const connectionNote = connected ? view.paused ? "任务已暂停，连接仍然保留。" : view.locked ? "手机已锁屏，操作前请先解锁。"
    : view.emulator ? "本机模拟器已连接。" : `已通过 ${live.map(route => route.transport === "usb" ? "USB" : "Wi-Fi").filter((value, index, all) => all.indexOf(value) === index).join("、")} 连接这台电脑。`
    : group.device.pending || (unresponsive ? "电脑仍能识别设备，正在等待手机 App 回复。" : routes.some(route => route.detected) ? "已识别手机，请在下方完成 App 连接。" : view.emulator ? "启动本机模拟器后建立连接。" : "还没有与这台电脑建立连接。" );
  // Old observations can help explain what happened, but never establish the
  // current lock/permission state after the companion stops responding.
  const latestReadiness = (group.device.cloud?.reportedAt ?? 0) > (group.device.confirmedAt ?? 0) ? group.device.cloud?.report?.readiness : group.device.state?.readiness;
  const issue = unresponsive ? {
    title: `${view.subject} App 暂时没有响应`,
    description: group.device.error.startsWith("手机没有返回这次操作的结果。") ? group.device.error
      : `电脑仍能识别这台${view.subject}，但暂时收不到 ProfilePilot App 的回复，${view.known ? "画面无法更新" : "权限和画面都无法更新"}。`,
    lastState: !view.known && latestReadiness?.unlocked === false ? `上次收到状态时${view.subject}处于锁屏状态，目前是否已解锁尚未确认。` : "",
    steps: [view.emulator ? "打开模拟器窗口，解锁并打开其中的 ProfilePilot App，稍等几秒。" : "先点亮并解锁手机，打开手机上的 ProfilePilot App，稍等几秒。",
      group.device.transport === "wifi" ? "若仍未恢复，确认手机和电脑在同一网络，再点上方“重新连接手机 App”。"
        : view.emulator ? "若仍未恢复，重新连接模拟器中的 App。" : "若仍未恢复，重新插拔 USB 数据线，再点上方“重新连接手机 App”。"],
    detail: group.device.error
  } : null;
  const connectionLabel = connected ? "已连接" : unresponsive ? "App 未响应" : "未连接";
  return { view: { ...view, canPreview: connected && view.canPreview, canSetup: connected && view.canSetup }, connected, occupied, routes, condition, label, note, connectionNote, connectionLabel, issue };
}
export function phoneEnhancementPresentation(device?: PhoneDevice, now = Date.now()) {
  const view = device && phonePresentation(device, now);
  const inspection = device?.connection === "device" && device.appInstallation && now - device.appInstallation.checkedAt < 45000 ? device.appInstallation.status : "unknown";
  const installation = inspection !== "unknown" ? inspection : view?.known ? "installed" : "unknown";
  const connected = installation !== "missing" && !!view?.directKnown && device?.state?.readiness?.computerConnected !== false;
  const permissions: PhoneSettingRow[] = view?.permissions || [
    { key: "accessibility", label: "无障碍服务", description: "识别控件，支持中文填写", status: "unknown", value: "未检测" },
    { key: "overlay", label: "悬浮窗", description: "显示操作状态，随时暂停", status: "unknown", value: "未检测" },
    { key: "notifications", label: "通知权限", description: "接收连接与任务提醒", status: "unknown", value: "未检测" }
  ];
  return { installation, connected, unresponsive: !!view?.unresponsive, canSetup: installation !== "missing" && !!view?.canSetup,
    label: installation === "missing" ? "未安装" : connected ? "已安装 · 已连接" : installation === "installed" ? "已安装 · 待连接" : "待检测",
    tone: connected ? "ready" : installation === "missing" ? "warning" : "neutral",
    note: installation === "missing" ? "安装 App 并开启所需权限，即可使用增强功能。"
      : connected ? "已连接手机 App，下方是当前权限状态。"
      : installation === "installed" ? "App 已安装，连接后即可使用增强功能。"
      : device?.connection === "device" ? "暂时无法检测安装状态，可重新检测或在手机上确认。" : "先连接手机，自动检测 App 安装与权限状态。",
    permissions: installation === "missing" ? permissions.map(row => ({ ...row, status: "unknown" as const, value: "安装后开启" })) : permissions };
}
export function phonePresentation(device: PhoneDevice, now = Date.now()) {
  const emulator = device.transport === "emulator";
  const subject = emulator ? "模拟器" : "手机";
  const displayName = emulator && device.name === "Android 手机" ? "Android 模拟器"
    : device.name === "Android 手机" && device.cloud?.report?.name ? device.cloud.report.name : device.name;
  const state = device.state;
  const connected = device.connection === "device";
  const unresponsive = connected && device.companion === "unavailable" && (!!device.error || device.confirmedAt !== null);
  const directKnown = connected && device.companion === "ready" && !!state && device.confirmedAt !== null && now - device.confirmedAt < 8000;
  const cloudOnline = !!device.cloud?.report && device.cloud.reportedAt !== null && now - device.cloud.reportedAt < 45000;
  const cloudSource = !directKnown && cloudOnline;
  const known = directKnown || cloudOnline;
  const diagnostics = directKnown ? state : cloudSource ? device.cloud?.report : undefined;
  const booleanStatus = (value: boolean | undefined) => !known || value === undefined ? "unknown" : value ? "enabled" : "disabled";
  const debugStatus = (value: string | undefined) => !known || !value || value === "unconfirmed" ? "unknown" : value === "enabled" ? "enabled" : "disabled";
  const row = (key: PhoneSetting, label: string, description: string, status: PhoneSettingRow["status"], value?: string): PhoneSettingRow => ({ key, label, description, status, value: value || (status === "unknown" ? unresponsive && !known ? "暂时无法读取" : "未检测" : status === "enabled" ? "已开启" : "未开启") });
  const accessibility = diagnostics?.readiness?.accessibilityService;
  const accessibilityStatus = !known ? "unknown" : accessibility === "unknown" ? "unknown" : accessibility ? accessibility === "running" && !!diagnostics?.permissions.accessibility ? "enabled" : "disabled" : booleanStatus(diagnostics?.permissions.accessibility);
  const permissions = [
    row("accessibility", "无障碍服务", "允许点击、滑动和输入", accessibilityStatus, known && accessibility === "enabled" ? "未运行" : undefined),
    row("overlay", "悬浮窗", "显示操作状态，随时暂停", booleanStatus(diagnostics?.permissions.overlay)),
    row("notifications", "通知权限", "接收连接与任务提醒", booleanStatus(diagnostics?.permissions.notifications))
  ];
  const settings = emulator ? [] : [
    row("developerOptions", "开发者选项", "", debugStatus(diagnostics?.readiness?.developerOptions)),
    row("usbDebugging", "USB 调试", "开启不代表已插入 USB", debugStatus(diagnostics?.readiness?.usbDebugging)),
    row("wirelessDebugging", "Wi-Fi 无线调试", "", debugStatus(diagnostics?.readiness?.wirelessDebugging))
  ];
  if (known) for (const setting of settings) {
    if (setting.status !== "unknown") continue;
    const reasons = diagnostics?.readiness?.debugReasons;
    const reason = reasons?.[setting.key as keyof typeof reasons];
    const explanation = reason === "denied" ? ["系统拒绝读取", "手机 App 没有读取此开关的权限，请在手机开发者选项中查看。"]
      : reason === "missing" ? ["系统未提供状态", "手机系统没有返回此开关的值，请在手机开发者选项中查看。"]
      : reason === "masked-zero" ? ["状态待确认", "系统返回了可能被隐藏的状态，暂不能判断此开关是否开启。"]
      : reason === "error" ? ["读取失败", "手机读取此开关时出错，将随下一次状态上报重新检测。"]
      : reason === "invalid" ? ["状态异常", "手机系统返回了无法识别的开关值，请在手机开发者选项中查看。"]
      : ["状态待确认", "手机已上报，但未提供此开关的检测原因；请更新手机 App 后重试。"];
    setting.value = explanation[0]; setting.description = explanation[1];
  }
  const missing = permissions.filter(item => item.status === "disabled").length;
  const permissionsReady = permissions.every(item => item.status === "enabled");
  const active = directKnown && phoneActive(device), paused = directKnown && state?.phase === "paused";
  const idle = directKnown && !!state && ["idle", "stopped"].includes(state.phase);
  const locked = known && diagnostics?.readiness?.unlocked === false;
  const note = cloudSource ? "手机正在通过服务器同步状态。查看画面或操作手机时，再建立控制连接。"
    : device.transport === "cloud" ? device.cloud?.paired ? "手机暂未更新状态，请检查手机网络或打开 ProfilePilot App。" : "请用手机 ProfilePilot App 扫码，开启状态同步。"
    : device.connection === "unauthorized" ? emulator ? "请在模拟器窗口中确认此电脑的调试连接。" : "请解锁手机，并在手机上允许此电脑进行 USB 调试。"
    : !connected ? emulator ? "启动本机模拟器后会自动检测连接，无需 USB 数据线或真实手机。" : device.transport === "wifi" ? "请确认手机与电脑在同一网络，并开启无线调试。" : "请用 USB 连接手机，并在手机上允许连接。"
    : device.companion === "pairing" ? `请在${subject}里的 ProfilePilot App 中确认与这台电脑配对。`
    : device.companion !== "ready" ? `${subject}已连接，还需要连接${subject}里的 ProfilePilot App。`
    : !known ? `正在等待${subject}更新状态，请保持连接。`
    : paused ? `任务已暂停，你可以自行操作${subject}。`
    : locked ? `请先解锁${subject}，再查看画面或执行任务。`
    : missing ? `连接正常，有 ${missing} 项控制权限尚未就绪。`
    : active ? state?.mode === "view" ? `连接正常，正在查看${subject}画面。` : "连接正常，正在执行你的任务。"
    : permissionsReady ? "连接正常，控制所需权限已就绪。" : "连接正常，正在检测控制权限。";
  return { emulator, subject, displayName, connected, known, directKnown, cloudOnline, cloudSource, unresponsive, permissions, settings, missing, permissionsReady, active, paused, locked, note,
    label: cloudSource ? "状态同步在线 · 控制未连接" : device.transport === "cloud" ? device.cloud?.paired ? "状态同步离线" : "等待手机扫码" : device.connection === "unauthorized" ? `等待${subject}授权` : connected ? `${subject}已连接` : `${subject}未连接`,
    canPreview: directKnown && permissionsReady && !locked && !device.pending && (idle || active && state?.phase !== "executing"),
    canSetup: idle && !device.pending
  };
}
