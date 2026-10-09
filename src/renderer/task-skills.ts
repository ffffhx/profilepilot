import type { TaskSkillDefinition, TaskSkillSelection } from "../shared/task-skills";

const e = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export function skillLibrary(skills: TaskSkillDefinition[], issues: string[]): string {
  return `<section class="skill-library"><div class="skill-library-intro"><div><span class="skill-eyebrow">WORKFLOWS</span><h2>把常做的事，交给熟悉的流程。</h2><p>选一个工作流，填入这次的条件。相同 Skill 也可用于 Codex 和 Claude Code。</p></div><button type="button" data-action="refresh-skills">刷新工作流</button></div>
  <div class="skill-library-grid">${skills.map((skill, index) => `<article class="skill-card"><div class="skill-card-meta"><span class="skill-number">${String(index + 1).padStart(2, "0")}</span><span>v${e(skill.version)}</span></div><h3>${e(skill.title)}</h3><p>${e(skill.description)}</p><div class="skill-card-fields">${skill.inputs.filter(field => field.required).map(field => `<span>${e(field.label)}</span>`).join("")}</div><button type="button" class="primary" data-use-skill="${e(skill.id)}">填写条件 <span aria-hidden="true">↗</span></button></article>`).join("") || '<div class="empty">尚未发现适用于 ProfilePilot 的共享工作流。安装后点击“刷新工作流”。</div>'}</div>
  ${issues.length ? `<details class="skill-load-issues"><summary>${issues.length} 项加载提示</summary><ul>${issues.map(issue => `<li>${e(issue)}</li>`).join("")}</ul></details>` : ""}</section>`;
}

export function skillForm(selection: TaskSkillSelection | undefined, skills: TaskSkillDefinition[], removable = true): string {
  if (!selection) return "";
  const skill = skills.find(skill => skill.id === selection.id);
  if (!skill) return `<section class="task-skill-inputs"><input type="hidden" name="skillId" value="${e(selection.id)}"><p class="notice">工作流 ${e(selection.id)} 暂不可用，请恢复安装或移除后继续。</p>${removable ? '<button type="button" data-action="remove-skill">移除工作流</button>' : ""}</section>`;
  return `<section class="task-skill-inputs" aria-label="工作流参数"><input type="hidden" name="skillId" value="${e(skill.id)}"><header><div><span class="skill-eyebrow">本次使用</span><strong>${e(skill.title)}</strong></div>${removable ? '<button type="button" data-action="remove-skill" class="skill-remove">移除</button>' : ""}</header><div class="skill-parameters">${skill.inputs.map(field => {
    const id = `skill-param-${field.key}`, name = `skill:${field.key}`, value = selection.parameters[field.key] ?? field.default ?? "";
    const attributes = `id="${id}" name="${name}" ${field.required ? "required" : ""}`;
    const control = field.type === "select" ? `<select ${attributes}>${field.options!.map(option => `<option value="${e(option)}" ${option === value ? "selected" : ""}>${e(option)}</option>`).join("")}</select>` : field.type === "textarea" ? `<textarea ${attributes} rows="2" placeholder="${e(field.placeholder)}">${e(value)}</textarea>` : `<input ${attributes} type="text" value="${e(value)}" placeholder="${e(field.placeholder)}">`;
    return `<div class="field ${field.type === "textarea" ? "skill-field-wide" : ""}"><label for="${id}">${e(field.label)}${field.required ? '<span class="skill-required" aria-hidden="true"> *</span>' : ""}</label>${control}</div>`;
  }).join("")}</div></section>`;
}

export function skillFromForm(form: FormData): TaskSkillSelection | undefined {
  const id = String(form.get("skillId") || "");
  if (!id) return undefined;
  const parameters: Record<string, string> = {};
  form.forEach((value, key) => { if (key.startsWith("skill:")) parameters[key.slice(6)] = String(value); });
  return { id, parameters };
}
