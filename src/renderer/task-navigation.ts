import { TERMINAL_TASKS, type BrowserTask } from "../shared/tasks";
import { taskIcon as icon } from "./task-icons";

const escape = (value: string): string => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export type TaskMenuAction = "pin" | "unpin" | "archive" | "restore" | "rename" | "delete";

export function taskMenuButton(task: BrowserTask, location: "sidebar" | "list"): string {
  return `<button type="button" id="task-menu-${location}-${task.id}" class="icon-button task-menu-trigger" data-task-menu="${task.id}" aria-label="管理任务：${escape(task.title)}" aria-haspopup="menu" aria-expanded="false" title="更多操作">${icon("more")}</button>`;
}

export function sidebarTasks(tasks: BrowserTask[], selected: string, statuses: Record<string, string>): string {
  const visible = tasks.filter(task => !task.archivedAt);
  const pinned = visible.filter(task => task.pinnedAt).sort((a, b) => b.pinnedAt!.localeCompare(a.pinnedAt!));
  const recent = visible.filter(task => !task.pinnedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const group = (items: BrowserTask[], label: string, name: string): string => `<section class="sidebar-task-group" aria-label="${label}" data-task-group="${name}"><div class="nav-section-label">${label}</div>${items.map(task => `<div class="recent-task-row ${selected === task.id ? "active" : ""}" data-task-row="${task.id}"><button class="recent-task" data-task="${task.id}" title="${escape(task.title)} · ${statuses[task.status]}" ${selected === task.id ? 'aria-current="page"' : ""}>${task.pinnedAt ? `<span class="task-pin" aria-label="已置顶">${icon("pin")}</span>` : `<span class="task-status-dot ${task.status}" aria-label="${statuses[task.status]}"></span>`}<span class="recent-title">${escape(task.title)}</span></button>${taskMenuButton(task, "sidebar")}</div>`).join("")}</section>`;
  return `${pinned.length ? group(pinned, "置顶", "pinned") : ""}${recent.length ? group(recent, "最近任务", "recent") : ""}${!visible.length ? '<div class="nav-section-label">最近任务</div><p class="sidebar-empty">开始的任务会显示在这里</p>' : ""}`;
}

/** One floating menu avoids clipping inside the sidebar's scrolling container. */
export class TaskMenus {
  private menu?: HTMLDivElement;
  private taskId = "";
  private anchorId = "";
  private point?: { x: number; y: number };
  constructor(private root: HTMLElement, private getTask: (id: string) => BrowserTask | undefined, private busy: () => boolean, private action: (id: string, action: TaskMenuAction) => void) {
    root.addEventListener("click", event => {
      const trigger = (event.target as Element).closest<HTMLButtonElement>("[data-task-menu]");
      if (!trigger) return;
      event.stopImmediatePropagation();
      if (trigger.disabled || this.busy()) return;
      if (this.menu && this.anchorId === trigger.id) this.close();
      else this.open(trigger);
    });
    root.addEventListener("contextmenu", event => {
      const trigger = (event.target as Element).closest("[data-task-row]")?.querySelector<HTMLButtonElement>("[data-task-menu]");
      if (!trigger) return;
      event.preventDefault();
      if (!this.busy()) this.open(trigger, { x: event.clientX, y: event.clientY });
    });
    root.addEventListener("keydown", event => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      const trigger = (event.target as Element).closest("[data-task-row]")?.querySelector<HTMLButtonElement>("[data-task-menu]");
      if (!trigger) return;
      event.preventDefault();
      if (!this.busy()) this.open(trigger);
    });
    document.addEventListener("pointerdown", event => {
      if (this.menu && !this.menu.contains(event.target as Node) && !(event.target as Element).closest("[data-task-menu]")) this.close(false);
    });
    document.addEventListener("focusin", event => {
      if (this.menu && !this.menu.contains(event.target as Node) && (event.target as HTMLElement).id !== this.anchorId) this.close(false);
    });
    window.addEventListener("resize", () => this.close());
    root.addEventListener("wheel", () => this.close(false), { passive: true });
  }
  private open(trigger: HTMLButtonElement, point?: { x: number; y: number }): void {
    this.close(false);
    this.taskId = trigger.dataset.taskMenu!; this.anchorId = trigger.id; this.point = point;
    this.menu = document.createElement("div");
    this.menu.className = "task-context-menu";
    this.menu.id = "task-context-menu";
    this.menu.setAttribute("role", "menu");
    this.menu.addEventListener("click", event => {
      const button = (event.target as Element).closest<HTMLButtonElement>("[data-menu-action]");
      if (!button || button.disabled || this.busy()) return;
      const id = this.taskId, action = button.dataset.menuAction as TaskMenuAction;
      this.close(); this.action(id, action);
    });
    this.menu.addEventListener("keydown", event => {
      const items = [...this.menu!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape") { event.preventDefault(); this.close(); }
      else if (event.key === "Tab") this.close();
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    });
    document.body.append(this.menu); this.refresh();
    this.menu?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }
  refresh(): void {
    if (!this.menu) return;
    const task = this.getTask(this.taskId);
    const anchor = document.getElementById(this.anchorId);
    if (!task || !anchor) { this.close(false); return; }
    const focusAction = this.menu.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.menuAction : undefined;
    const item = (action: TaskMenuAction, label: string, glyph: Parameters<typeof icon>[0], disabled = false): string => `<button type="button" role="menuitem" data-menu-action="${action}" ${disabled ? 'disabled title="任务结束后可操作"' : ""} ${action === "delete" ? 'class="danger"' : ""}>${icon(glyph)}<span>${label}</span></button>`;
    const finished = TERMINAL_TASKS.has(task.status);
    this.menu.setAttribute("aria-label", `管理任务：${task.title}`);
    this.menu.innerHTML = (task.archivedAt ? "" : item(task.pinnedAt ? "unpin" : "pin", task.pinnedAt ? "取消置顶" : "置顶", task.pinnedAt ? "unpin" : "pin"))
      + item("rename", "重命名", "rename")
      + (task.archivedAt ? item("restore", "移出归档", "restore") : item("archive", "归档", "archive"))
      + '<div class="task-menu-divider" role="separator"></div>' + item("delete", "删除任务", "trash", !finished);
    anchor.setAttribute("aria-expanded", "true"); anchor.setAttribute("aria-controls", this.menu.id);
    const bounds = anchor.getBoundingClientRect();
    const x = this.point?.x ?? bounds.right - this.menu.offsetWidth;
    const y = this.point?.y ?? bounds.bottom + 4;
    this.menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - this.menu.offsetWidth - 8))}px`;
    this.menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - this.menu.offsetHeight - 8))}px`;
    if (focusAction) this.menu.querySelector<HTMLButtonElement>(`[data-menu-action="${focusAction}"]:not(:disabled)`)?.focus({ preventScroll: true });
  }
  close(restoreFocus = true): void {
    if (!this.menu) return;
    const anchor = document.getElementById(this.anchorId);
    this.menu.remove(); this.menu = undefined;
    anchor?.setAttribute("aria-expanded", "false"); anchor?.removeAttribute("aria-controls");
    if (restoreFocus) anchor?.focus({ preventScroll: true });
  }
}

export function renameTaskTitle(title: string): Promise<string | null> {
  return new Promise(resolve => {
    const origin = document.activeElement as HTMLElement | null;
    const dialog = document.createElement("dialog");
    dialog.className = "task-confirm task-rename";
    dialog.setAttribute("aria-labelledby", "task-rename-title");
    dialog.innerHTML = '<form><h2 id="task-rename-title">重命名任务</h2><label for="task-title-input">任务名称</label><input id="task-title-input" name="title" required maxlength="120" autocomplete="off"><div class="actions"><button type="button" data-rename-cancel>取消</button><button type="submit" class="primary">保存</button></div></form>';
    const input = dialog.querySelector("input")!;
    input.value = title;
    input.addEventListener("input", () => input.setCustomValidity(""));
    dialog.querySelector("form")!.addEventListener("submit", event => {
      event.preventDefault();
      if (!input.value.trim()) { input.setCustomValidity("请输入任务名称。"); input.reportValidity(); return; }
      dialog.close("save");
    });
    dialog.querySelector("[data-rename-cancel]")!.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      const result = dialog.returnValue === "save" ? input.value.trim() : null;
      dialog.remove(); if (origin?.isConnected) origin.focus({ preventScroll: true }); resolve(result);
    }, { once: true });
    document.body.append(dialog); dialog.showModal(); input.focus(); input.select();
  });
}
