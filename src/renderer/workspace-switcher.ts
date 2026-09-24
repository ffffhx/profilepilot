import { taskIcon } from "./task-icons";

type Workspace = "agent" | "browser" | "local-apps";
const workspaceLabel = (value: Workspace) => ({ agent: "Agent", browser: "浏览器", "local-apps": "本地应用" })[value];
let menu: HTMLElement | undefined;
let active: Workspace;
const trigger = () => document.querySelector<HTMLButtonElement>(".workspace-switch-trigger");

export function workspaceSwitcher(current: Workspace): string {
  active = current;
  return `<button type="button" class="workspace-switch-trigger" aria-label="切换工作区，当前${workspaceLabel(current)}" aria-haspopup="menu" aria-expanded="${!!menu}" title="切换工作区" data-workspace-trigger><img src="./assets/profilepilot-mark.svg" width="25" height="25" alt=""><span>${workspaceLabel(current)}</span>${taskIcon("chevron")}</button>`;
}

export function refreshWorkspaceSwitcher(): void {
  if (menu && !trigger()) close(false);
  if (menu) { trigger()?.setAttribute("aria-controls", menu.id); position(); }
}

function close(focus = true): void {
  menu?.remove(); menu = undefined;
  trigger()?.setAttribute("aria-expanded", "false");
  trigger()?.removeAttribute("aria-controls");
  if (focus) trigger()?.focus({ preventScroll: true });
}

function position(): void {
  const anchor = trigger(); if (!menu || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 296))}px`;
  menu.style.top = `${rect.bottom + 7}px`;
}

function open(last = false): void {
  close(false);
  const popup = document.createElement("div");
  popup.id = "workspace-switch-menu"; popup.className = "workspace-switch-menu";
  popup.setAttribute("popover", "auto"); popup.setAttribute("role", "menu"); popup.setAttribute("aria-label", "切换工作区");
  popup.innerHTML = ([
    ["agent", "Agent", "描述任务，让浏览器为你执行", "./tasks.html", "message"],
    ["browser", "浏览器", "管理账号、Profile 与浏览器连接", "./index.html", "browser"],
    ["local-apps", "本地应用", "管理开发项目、后台服务与调试", "./local-apps.html", "desktop"]
  ] as const).map(([key, label, detail, href, glyph]) => `<a href="${href}" class="workspace-switch-option" data-workspace="${key}" role="menuitemradio" aria-checked="${active === key}" tabindex="-1">${taskIcon(glyph)}<span><strong>${label}</strong><small>${detail}</small></span>${active === key ? taskIcon("check") : ""}</a>`).join("");
  menu = popup; document.body.append(popup);
  trigger()?.setAttribute("aria-expanded", "true"); trigger()?.setAttribute("aria-controls", popup.id);
  popup.addEventListener("toggle", event => { if ((event as ToggleEvent).newState === "closed" && menu === popup) close(false); });
  popup.addEventListener("click", event => {
    const item = (event.target as Element).closest<HTMLAnchorElement>("[data-workspace]");
    if (!item) return;
    if (item.dataset.workspace === active) { event.preventDefault(); close(); return; }
    document.dispatchEvent(new CustomEvent("workspace-before-switch", { detail: item.dataset.workspace }));
    close(false);
  });
  popup.addEventListener("keydown", event => {
    const items = [...popup.querySelectorAll<HTMLElement>("[data-workspace]")];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault(); items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length].focus();
    } else if (event.key === "Escape") { event.preventDefault(); close(); }
    else if (event.key === "Tab") close();
    else if (event.key === " ") { event.preventDefault(); items[index]?.click(); }
  });
  popup.showPopover(); position();
  (last ? popup.lastElementChild as HTMLElement : popup.querySelector<HTMLElement>('[aria-checked="true"]'))?.focus({ preventScroll: true });
}

document.addEventListener("click", event => {
  if (!(event.target as Element).closest("[data-workspace-trigger]")) return;
  event.preventDefault(); if (menu) close(); else open();
});
document.addEventListener("keydown", event => {
  if (!(event.target as Element).closest("[data-workspace-trigger]")) return;
  if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); open(event.key === "ArrowUp"); }
});
document.addEventListener("pointerdown", event => {
  const target = event.target as Node;
  if (menu && !menu.contains(target) && !trigger()?.contains(target)) close(false);
});
window.addEventListener("resize", position);
document.addEventListener("scroll", position, true);
