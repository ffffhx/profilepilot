import { taskIcon } from "./task-icons";

export function pcControlTabs(current: "browser" | "local-apps" | "phones" | "desktop" | "gpui"): string {
  return `<nav class="pc-control-tabs" aria-label="控制台分类">${([
    ["browser", "./index.html", "browser", "浏览器 Profiles"],
    ["local-apps", "./local-apps.html", "desktop", "Electron 应用"],
    ["gpui", "./gpui.html", "desktop", "GPUI 应用"],
    ["desktop", "./desktop.html", "desktop", "Windows 桌面"],
    ["phones", "./phones.html", "phone", "手机设备"]
  ] as const).map(([id, href, icon, label]) => `<a href="${href}" data-pc-view="${id}"${current === id ? ' aria-current="page"' : ""}>${taskIcon(icon)}<span>${label}</span></a>`).join("")}</nav>`;
}
