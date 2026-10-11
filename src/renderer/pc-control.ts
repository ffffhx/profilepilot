import { taskIcon } from "./task-icons";

export function pcControlTabs(current: "browser" | "local-apps" | "phones"): string {
  return `<nav class="pc-control-tabs" aria-label="控制台分类">${([
    ["browser", "./index.html", "browser", "浏览器 Profiles"],
    ["local-apps", "./local-apps.html", "desktop", "Electron 应用"],
    ["phones", "./phones.html", "phone", "Android 设备"]
  ] as const).map(([id, href, icon, label]) => `<a href="${href}" data-pc-view="${id}"${current === id ? ' aria-current="page"' : ""}>${taskIcon(icon)}<span>${label}</span></a>`).join("")}</nav>`;
}
