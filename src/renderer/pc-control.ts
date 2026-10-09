import { taskIcon } from "./task-icons";

export function pcControlTabs(current: "browser" | "local-apps"): string {
  return `<nav class="pc-control-tabs" aria-label="PC 控制分类">${([
    ["browser", "./index.html", "browser", "浏览器 Profiles"],
    ["local-apps", "./local-apps.html", "desktop", "Electron 应用"]
  ] as const).map(([id, href, icon, label]) => `<a href="${href}" data-pc-view="${id}"${current === id ? ' aria-current="page"' : ""}>${taskIcon(icon)}<span>${label}</span></a>`).join("")}</nav>`;
}
