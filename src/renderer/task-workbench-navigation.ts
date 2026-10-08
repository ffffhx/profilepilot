import type { BrowserTask } from "../shared/tasks";
import { taskIcon as icon } from "./task-icons";
import { taskMenuButton } from "./task-navigation";
import { escapeTaskHtml as e } from "./task-rich-text";
import { attentionReason, findTaskHit } from "./task-interaction-model";

export function workbenchNavigation(tasks: BrowserTask[], selected: string, statuses: Record<string, string>, read: Record<string, string>): string {
  const visible = tasks.filter(task => !task.archivedAt);
  const groups = [
    { name: "pinned", label: "置顶", items: visible.filter(task => task.pinnedAt).sort((a, b) => b.pinnedAt!.localeCompare(a.pinnedAt!)) },
    { name: "active", label: "进行中", items: visible.filter(task => !task.pinnedAt && !["completed", "failed", "cancelled", "partial"].includes(task.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) },
    { name: "recent", label: "最近任务", items: visible.filter(task => !task.pinnedAt && ["completed", "failed", "cancelled", "partial"].includes(task.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }
  ];
  return groups.filter(group => group.items.length).map(group => `<details open id="sidebar-${group.name}" class="sidebar-task-group"><summary class="nav-section-label">${group.label} · ${group.items.length}</summary>${group.items.map(task => {
    const state = attentionReason(task, read[task.id]) || statuses[task.status];
    const time = new Date(task.updatedAt).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    return `<div class="recent-task-row ${selected === task.id ? "active" : ""}" data-task-row="${e(task.id)}"><button type="button" class="recent-task" data-task="${e(task.id)}" title="${e(task.title)} · ${e(task.profileName)} · ${e(state)}" ${selected === task.id ? 'aria-current="page"' : ""}><span class="recent-document" aria-label="${e(state)}">${icon("template")}</span>${task.pinnedAt ? `<span class="task-pin" aria-label="已置顶">${icon("pin")}</span>` : ""}<span class="recent-task-copy"><span class="recent-title">${e(task.title)}</span><span class="recent-meta">${e(task.profileName)} · ${e(time)} · ${e(state)}</span></span></button>${taskMenuButton(task, "sidebar")}</div>`;
  }).join("")}</details>`).join("") || '<p class="sidebar-empty">开始的任务会显示在这里</p>';
}

export function searchSnippet(task: BrowserTask, query: string): { id: string; html: string } | undefined {
  const hit = findTaskHit(task, query); if (!hit) return;
  const index = hit.text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  const begin = Math.max(0, index - 32), end = Math.min(hit.text.length, Math.max(0, index) + query.length + 90);
  const text = hit.text.slice(begin, end);
  const start = text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  const snippet = start < 0 ? e(text) : `${e(text.slice(0, start))}<mark>${e(text.slice(start, start + query.trim().length))}</mark>${e(text.slice(start + query.trim().length))}`;
  return { id: hit.id, html: `<span class="task-search-hit">${e(hit.label)}：${begin ? "…" : ""}${snippet}${end < hit.text.length ? "…" : ""}</span>` };
}

export function appearanceControls(): string {
  return `<section class="panel"><h2>外观与阅读</h2><label for="task-theme">主题</label><select id="task-theme" data-appearance="theme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select><label for="task-font-size">正文字号</label><select id="task-font-size" data-appearance="fontSize"><option value="small">小</option><option value="medium">中</option><option value="large">大</option></select></section>`;
}

export function applyAppearance(storage?: Pick<Storage, "getItem">): void {
  let theme = "light", fontSize = "medium";
  // The approved workspace design starts light; its preference is separate from the old dark console.
  try { theme = storage?.getItem("profilepilot-workspace-theme") || theme; fontSize = storage?.getItem("profilepilot-task-font-size") || fontSize; } catch { /* Defaults remain usable. */ }
  document.documentElement.dataset.taskTheme = ["dark", "light", "system"].includes(theme) ? theme : "system";
  document.documentElement.dataset.taskFontSize = ["small", "medium", "large"].includes(fontSize) ? fontSize : "medium";
}
