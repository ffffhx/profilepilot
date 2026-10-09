import type { TaskTemplate } from "../shared/tasks";
import type { TaskSkillDefinition } from "../shared/task-skills";
import { escapeTaskHtml as e } from "./task-rich-text";
import { taskIcon as icon } from "./task-icons";

export function taskTemplateMenu(skills: TaskSkillDefinition[], templates: TaskTemplate[]): string {
  return `<div id="task-template-menu" class="task-template-menu" popover="auto" aria-label="选择任务模板">
    <header>任务模板</header><div class="task-template-list">
    ${skills.length ? `<p class="task-template-group">内置任务</p>${skills.map(skill => `<button type="button" data-use-skill="${e(skill.id)}">${icon("template")}<span><strong>${e(skill.title)}</strong><small>${e(skill.description)}</small></span></button>`).join("")}` : '<p class="task-template-empty">暂无可用的内置任务模板</p>'}
    ${templates.length ? `<p class="task-template-group">我的模板</p>${templates.map(template => `<button type="button" data-use-template="${e(template.id)}">${icon("bookmark")}<span><strong>${e(template.name)}</strong><small>${e(template.task.prompt)}</small></span></button>`).join("")}` : ""}
    </div><footer><button type="button" data-action="new-template">${icon("plus")}新建任务模板</button></footer>
  </div>`;
}

export function positionTaskTemplateMenu(root: HTMLElement): void {
  const menu = root.querySelector<HTMLElement>("#task-template-menu");
  const trigger = root.querySelector<HTMLElement>('[popovertarget="task-template-menu"]');
  if (!menu?.matches(":popover-open") || !trigger) return;
  const rect = trigger.getBoundingClientRect();
  const gap = 10;
  menu.style.width = `${Math.min(380, innerWidth - 2 * gap)}px`;
  menu.style.maxHeight = `${Math.max(120, Math.min(480, innerHeight - 2 * gap))}px`;
  const height = menu.getBoundingClientRect().height;
  menu.style.left = `${Math.max(gap, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - gap))}px`;
  menu.style.top = `${Math.max(gap, Math.min(rect.top - height - gap, innerHeight - height - gap))}px`;
}
