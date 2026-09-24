import { openTaskLink } from "./task-links";
import { taskBudgetNote } from "./task-budget";
import { workspaceSwitcher, refreshWorkspaceSwitcher } from "./workspace-switcher";
import { tokenUsagePage } from "./task-token-usage";
import type { TokenSource } from "../shared/task-token-usage";
let usageSource: TokenSource = "all";
import type { TaskApi, TaskSnapshot, BrowserTask, TaskStatus, CreateTaskInput, JevProvider } from "../shared/tasks";
import { TERMINAL_TASKS, jevProviderFor, hasTaskBrowser } from "../shared/tasks";
import { zonedLocalToIso } from "../shared/task-time";
import type { AppState } from "./types";
import { taskProfileAvailability } from "./task-profile-availability";
import { renderJevProgress, renderExecutionStatus, renderModelInfo } from "./task-progress";
import { renderTaskEvents } from "./task-events";

import { taskIcon as icon } from "./task-icons";
import { TaskSelects } from "./task-select";
import { confirmTaskAction } from "./task-confirm";
import { modelLabel } from "../shared/task-model";
import { TaskPreviewView, previewMarkup } from "./task-preview";
import { nativeBrowserSettings, type NativePairing } from "./native-browser-settings";
import { historyActions, taskHistory, taskResultMessage } from "./task-history";
import { taskComposer } from "./task-composer";
import { sidebarTasks, taskMenuButton, TaskMenus, renameTaskTitle, type TaskMenuAction } from "./task-navigation";

declare global { interface Window { tasks: TaskApi; } }
const root = document.getElementById("task-app")!;
const selects = new TaskSelects(root);
type FieldDraft = { name: string; value: string; checked: boolean; type: string };
const pageDrafts = new Map<string, FieldDraft[]>();
const pageDetails = new Map<string, string[]>();
const pageFiles = new Map<string, string[]>();
const replyErrors = new Map<string, string>();
function rememberForms(): void {
  root.querySelectorAll<HTMLFormElement>("form").forEach(form => {
    pageDrafts.set(`${selected}:${form.id}`, [...form.querySelectorAll<HTMLInputElement>("input[name],textarea[name],select[name]")].map(field => ({ name: field.name, value: field.value, checked: field.checked, type: field.type })));
    pageDetails.set(`${selected}:${form.id}`, [...form.querySelectorAll("details[open] summary")].map(summary => summary.textContent || ""));
  });
  pageFiles.set(view, [...selectedFiles]);
}
function restoreForms(): void {
  root.querySelectorAll<HTMLFormElement>("form").forEach(form => {
    const fields = pageDrafts.get(`${selected}:${form.id}`);
    if (!fields) return;
    form.querySelectorAll<HTMLInputElement>("input[name],textarea[name],select[name]").forEach(field => {
      const previous = fields.find(item => item.name === field.name && (field.type !== "checkbox" || item.value === field.value));
      if (previous) { field.value = previous.value; if (field.type === "checkbox") field.checked = previous.checked; }
    });
    const details = pageDetails.get(`${selected}:${form.id}`) || [];
    form.querySelectorAll("details").forEach(node => { node.open = details.includes(node.querySelector("summary")?.textContent || ""); });
  });
}
function forgetForm(id: string): void { pageDrafts.delete(`${selected}:${id}`); pageDetails.delete(`${selected}:${id}`); }
const api = window.tasks;
const preview = new TaskPreviewView(api);
const inspectorPreference = "profilepilot-task-inspector-open";
let inspectorOpen = true;
try { inspectorOpen = localStorage.getItem(inspectorPreference) !== "false"; } catch { /* Keep the default if storage is unavailable. */ }
let data: TaskSnapshot;
let profiles: AppState | undefined;
let profilesError = false;
let view = new URLSearchParams(location.search).get("view") || "tasks";
let selected = new URLSearchParams(location.search).get("task") || "";
let search = "";
let filter = "all";
let historyScope: "active" | "archived" = "active";
let editMaterial = "";
let editSchedule = "";
let editTemplate = "";
let formDraft: CreateTaskInput | undefined;
let selectedFiles: string[] = [];
let pending = 0;
const taskMenus = new TaskMenus(root, id => data?.tasks.find(task => task.id === id), () => pending > 0, (id, action) => { void manageTask(id, action); });
let composing = false;
let renderDeferred = false;
let renderedKey = "";
let toastTimer: number;
let settingsReturn = { view: "tasks", selected: "" };
const modelCatalogs = new Map<string, { ids: string[]; status: string; requested: boolean }>();
function modelPicker(): string {
  const catalog = modelCatalogs.get(data.settings.baseUrl);
  const ids = [...new Set([data.settings.model, ...(catalog?.ids || [])])];
  return `<div class="model-picker"><select id="agent-model" data-model-picker="true" data-status="${e(catalog?.status || "正在读取当前服务的模型列表…")}" aria-label="选择模型">${ids.map(id => `<option value="${e(id)}" ${id === data.settings.model ? "selected" : ""}>${e(modelLabel(id))}</option>`).join("")}</select></div>`;
}
function jevEntry(): string {
  const s = data.settings;
  const enabled = !!s.hasJevApiKey && !!s.jevEnabled;
  const status = !s.hasJevApiKey ? "未配置" : !s.jevEnabled ? "未启用" : s.jevMode === "advisory" ? "辅助判断" : "优先执行";
  return `<button type="button" class="jev-entry ${enabled ? "is-enabled" : ""}" data-nav="settings" data-focus="jev-provider-trigger" title="Jev 负责网页操作，主模型负责理解任务与核查结果。点击配置 Jev。" aria-label="Jev ${status}，打开 Jev 设置"><span class="task-status-dot ${enabled ? "running" : ""}"></span><span>Jev · ${status}</span>${icon("settings")}</button>`;
}
let nativePairing: NativePairing | undefined;
let nativeAuthorization: { profileId: string; expiresAt: string } | undefined;
let restoringWorkspace = false;
// Keep the active Agent draft in this window's session while visiting browser
// management. Credentials and settings form fields are never included.
try {
  const saved = JSON.parse(sessionStorage.getItem("profilepilot-agent-workspace") || "null");
  sessionStorage.removeItem("profilepilot-agent-workspace");
  if (saved) {
    restoringWorkspace = true;
    view = ["tasks", "history"].includes(saved.view) ? saved.view : "tasks";
    selected = typeof saved.selected === "string" ? saved.selected : "";
    formDraft = saved.formDraft; selectedFiles = saved.selectedFiles || []; editTemplate = saved.editTemplate || "";
    if (saved.fields) pageDrafts.set(":create-task", saved.fields);
    if (saved.details) pageDetails.set(":create-task", saved.details);
  }
} catch { /* A stale or unavailable session cache must not prevent startup. */ }
document.addEventListener("workspace-before-switch", () => {
  rememberForms();
  const form = root.querySelector<HTMLFormElement>("#create-task");
  if (form) formDraft = formInput(form);
  try { sessionStorage.setItem("profilepilot-agent-workspace", JSON.stringify({ view, selected, formDraft, selectedFiles: pageFiles.get("tasks") || selectedFiles, editTemplate, fields: pageDrafts.get(":create-task"), details: pageDetails.get(":create-task") })); } catch { /* Storage may be unavailable in restricted sessions. */ }
});
const statusNames: Record<TaskStatus, string> = { queued: "排队中", running: "执行中", waiting_user: "等待你处理", paused: "已暂停", completed: "已完成", partial: "部分完成", failed: "失败", cancelled: "已取消" };
const itemNames: Record<string, string> = { pending: "待处理", running: "处理中", waiting_user: "待补充", completed: "完成", skipped: "跳过", failed: "失败", uncertain: "结果未确认" };
const e = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const date = (value: string): string => new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const pill = (task: BrowserTask): string => `<span class="pill ${task.status}">${statusNames[task.status]}</span>`;
const elapsed = (task: BrowserTask): number => Math.round((task.usage.elapsedMs + (task.runningSince ? Math.max(0, Date.now() - Date.parse(task.runningSince)) : 0)) / 1000);
function toast(text: string, error = false): void { const node = document.getElementById("task-toast")!; node.textContent = text; node.className = error ? "error" : ""; clearTimeout(toastTimer); toastTimer = window.setTimeout(() => node.textContent = "", 7000); }
function updateMessageSend(): void {
  const field = root.querySelector<HTMLTextAreaElement>("#steering");
  const send = root.querySelector<HTMLButtonElement>("#steer-task .send-task");
  if (send) send.disabled = pending > 0 || !field?.value.trim();
}
function showPending(): void {
  root.setAttribute("aria-busy", String(pending > 0));
  root.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
    const navigation = ["focus-browser", "toggle-sidebar", "toggle-task-inspector"].includes(button.dataset.action || "");
    const urgent = ["pause", "cancel", "takeover"].includes(button.dataset.control || "");
    if (pending && !button.disabled && !navigation && !urgent) { button.disabled = true; button.dataset.pendingDisabled = "true"; }
    if (!pending && button.dataset.pendingDisabled) { button.disabled = false; delete button.dataset.pendingDisabled; }
  });
  const indicator = document.getElementById("task-operation-pending");
  if (indicator) indicator.hidden = !pending;
  updateMessageSend();
}
async function act(fn: () => Promise<unknown>, urgent = false): Promise<void> {
  if (pending && !urgent) { toast("正在处理上一项操作，请稍候。"); return; }
  pending++; showPending();
  try { await fn(); data = await api.snapshot(); render(); }
  catch (error) { toast(String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method.*?Error: /, ""), true); }
  finally { pending--; showPending(); }
}
async function manageTask(id: string, action: TaskMenuAction): Promise<void> {
  const task = data.tasks.find(task => task.id === id);
  if (!task || pending) return;
  if (action === "rename") {
    const title = await renameTaskTitle(task.title);
    if (title !== null && title !== task.title) await act(async () => { await api.updateTaskMetadata(id, { title }); toast("任务名称已更新。"); });
    return;
  }
  if (action === "delete" && !await confirmTaskAction("删除这条任务？", `“${task.title}”的记录和结果将被删除，无法恢复。`)) return;
  if (action === "archive" && !TERMINAL_TASKS.has(task.status) && !await confirmTaskAction("停止并归档这条任务？", `“${task.title}”将退出排队或停止执行，已有记录和结果会保留。移出归档后不会自动继续。`, "停止并归档")) return;
  await act(async () => {
    if (action === "delete") {
      await api.deleteTask(id); if (selected === id) selected = "";
      toast("任务已删除。");
    } else if (action === "pin" || action === "unpin") {
      await api.updateTaskMetadata(id, { pinned: action === "pin" });
      toast(action === "pin" ? "任务已置顶。" : "已取消置顶。");
    } else {
      await api.updateTaskMetadata(id, { archived: action === "archive" });
      if (action === "archive" && selected === id) { rememberForms(); selected = ""; }
      toast(action === "archive" ? "任务已归档，可在“全部任务 → 已归档”中查看和恢复。" : "任务已移出归档。");
    }
  });
}
function taskProfiles() { return profiles?.profiles.filter(profile => profile.source === "native" || profile.source === "isolated" && !profile.agentAccessDisabled) || []; }
function profileOptions(selectedId = "", scheduled = false): string {
  return profiles ? taskProfiles().map(profile => {
    const status = taskProfileAvailability(profile, data.tasks, data.nativeBrowsers);
    return `<option value="${e(profile.id)}" data-label="${e(profile.name)}" data-description="${e(status.label)}${profile.source === "native" ? " · 系统 Chrome 扩展" : ""}" ${(!scheduled || profile.source === "native") && !status.available ? "disabled" : ""} ${profile.id === selectedId ? "selected" : ""}>${e(profile.name)}${profile.source === "native" ? " · 系统 Chrome 扩展" : ""} — ${status.label}</option>`;
  }).join("") : `<option value="" disabled>${profilesError ? "浏览器列表读取失败" : "正在读取浏览器列表…"}</option>`;
}
function profileAvailabilityHint(id: string): string {
  const candidates = taskProfiles();
  const states = candidates.map(profile => taskProfileAvailability(profile, data.tasks, data.nativeBrowsers));
  const available = states.filter(state => state.available).length;
  const disconnected = states.filter(state => state.label.startsWith("待连接")).length;
  let text = profilesError ? "浏览器状态读取失败，请重新读取。" : "正在读取浏览器状态…";
  if (profiles) text = !candidates.length ? "暂无可用于任务的浏览器，请在“浏览器”中添加或启用。"
    : `${available ? `${available} 个空闲` : "暂无空闲浏览器"} · ${candidates.length - available - disconnected} 个占用中${disconnected ? ` · ${disconnected} 个系统 Profile 待连接` : ""}。${disconnected ? "在浏览器选择菜单中连接系统 Chrome。" : available ? "未启动的空闲浏览器会在任务开始时自动启动。" : "可等待占用释放，或在“浏览器”中查看详情。"}`;
  return `<p id="${id}" class="profile-availability ${profiles && available ? "has-available" : ""}" role="status">${text}</p>`;
}
function toolbar(title: string, _subtitle: string, extra = ""): string {
  const collapsed = root.classList.contains("sidebar-collapsed");
  return `<header class="topline page-header"><div class="page-heading"><button type="button" class="icon-button sidebar-toggle" data-action="toggle-sidebar" aria-label="${collapsed ? "展开侧栏" : "收起侧栏"}" aria-expanded="${!collapsed}" title="${collapsed ? "展开侧栏" : "收起侧栏"}">${icon("sidebar")}</button><h1 title="${e(title)}">${e(title)}</h1></div><div class="header-actions">${extra}</div></header>`;
}
function nav(): string {
  const links = [["materials", "folder", "资料"], ["templates", "template", "任务模板"], ["schedules", "clock", "定时任务"], ["history", "history", "全部任务"], ["usage", "usage", "Token 消耗"]] as const;
  return `<aside class="sidebar" aria-label="侧栏">
    ${workspaceSwitcher("agent")}
    <nav class="primary-nav" aria-label="工作区">
      <button class="nav-item new-task ${view === "tasks" && !selected ? "active" : ""}" data-nav="tasks" title="Agent 对话 · 创建任务">${icon("compose")}<span>新任务</span>${icon("plus")}</button>
      ${links.map(([key, glyph, label]) => `<button class="nav-item ${view === key ? "active" : ""}" data-nav="${key}" title="${label}" ${view === key ? 'aria-current="page"' : ""}>${icon(glyph)}<span>${label}</span></button>`).join("")}
    </nav>
    <div class="sidebar-recents">${sidebarTasks(data.tasks, selected, statusNames)}</div>
    <div class="sidebar-footer"><button class="nav-item ${view === "settings" ? "active" : ""}" data-nav="settings" title="设置">${icon("settings")}<span>设置</span></button><div class="local-status"><span></span>本机工作区</div></div>
  </aside>`;
}
function formExtras(): string { return `<details class="details"><summary>任务选项 <span class="details-hint">资料、授权与运行限制</span></summary><div class="field"><label>模板名称（保存模板时使用）</label><input name="templateName" placeholder="留空则使用任务描述"></div><div class="grid-two"><div><label>使用已保存的资料</label>${data.materials.length ? data.materials.map((material) => `<label><input type="checkbox" name="material" value="${e(material.id)}">${e(material.name)} · v${material.version}</label>`).join("") : '<small>尚未添加资料，可在“资料”中保存。</small>'}</div><div><label>选择附件库中的文件</label>${data.attachments.map(file => `<label><input type="checkbox" name="attachment" value="${e(file.id)}" ${selectedFiles.includes(file.id) ? "checked" : ""}>${e(file.name)}</label>`).join("") || "<small>可先添加附件。</small>"}<br><label for="authorization">操作授权范围</label><textarea id="authorization" name="authorization" placeholder="例如：填写后让我确认再提交"></textarea></div></div><div class="field"><label for="grant-origin">允许自动执行的网站来源（可选）</label><input id="grant-origin" name="grantOrigin" type="url" placeholder="https://example.com"><small>仅在你明确授权的网站和次数内自动提交，其他操作仍会询问。</small><div class="actions"><label><input type="checkbox" name="grantEffect" value="submit">允许提交 / 保存</label><label><input type="checkbox" name="grantEffect" value="send">允许发送</label><label><input type="checkbox" name="grantEffect" value="delete">允许删除</label></div><label>最多自动执行次数</label><input name="grantMax" type="number" min="1" max="500" value="10"><br><br><label for="items">批量项目（每行一项，可留空）</label><textarea id="items" name="items" placeholder="公司 / 岗位 / 链接，或逐项填写要求"></textarea></div><div class="grid-three"><div><label>时间上限（分钟）</label><input name="minutes" type="number" min="1" max="1440" value="30"></div><div><label>操作次数上限</label><input name="actions" type="number" min="1" max="10000" value="200"></div><div><label>主模型估算费用上限（USD）</label><input name="budgetUsd" type="number" min="0.01" max="1000" step="0.01" value="5"></div></div></details>`; }
function composer(): string {
  const shortcut = "Enter";
  return `<div class="compose"><div class="compose-intro"><img class="compose-mark" src="./assets/profilepilot-mark.svg" alt=""><h2>今天想让浏览器做什么？</h2><p>描述你的任务，随时查看进度或接管操作。</p></div>
    ${!data.settings.hasApiKey ? '<div class="notice setup-notice"><span>连接模型服务，即可开始第一个任务。</span><button data-nav="settings" data-focus="model">前往设置 →</button></div>' : ""}
    <form id="create-task" class="composer"><label for="prompt" class="sr-only">告诉我你想完成什么</label><textarea id="prompt" name="prompt" required placeholder="让浏览器帮你完成一件事…" rows="3"></textarea>
      <div id="chosen-files">${selectedFiles.map(id => `<span class="file-chip">${icon("paperclip")}${e(data.attachments.find(file => file.id === id)?.name || id)}<button type="button" data-remove-file="${id}" aria-label="移除附件">×</button></span>`).join("")}</div>
      <div class="compose-toolbar"><button type="button" class="icon-button" data-action="attach" title="添加附件" aria-label="添加附件">${icon("plus")}</button><div class="browser-picker">${icon("browser")}<select name="profileId" aria-describedby="task-profile-availability" aria-label="任务使用的浏览器" required><option value="">选择浏览器</option>${profileOptions()}</select>${icon("chevron")}</div><button type="button" class="template-button" data-action="save-template" title="${editTemplate ? "更新模板" : "保存为模板"}" aria-label="${editTemplate ? "更新模板" : "保存为模板"}">${icon("bookmark")}<span>${editTemplate ? "更新模板" : "保存模板"}</span></button><button class="primary send-task" type="submit" title="开始任务（${shortcut}）" aria-label="开始任务">${icon("arrow")}</button></div>
      <div class="composer-meta"><div class="model-controls">${modelPicker()}${jevEntry()}</div><span class="keyboard-hint">Enter 发送 · Ctrl+Enter 换行</span></div>
      ${formExtras()}
    </form>
    ${profileAvailabilityHint("task-profile-availability")}
    <div class="examples">${[
      ["folder", "填写申请", "使用简历和资料", "帮我打开招聘官网，使用选择的资料和简历填写申请，提交前让我确认。"],
      ["browser", "整理网页", "把信息汇总成表格", "帮我整理网页中的信息，记录标题、关键内容和来源链接，汇总成表格。"],
      ["template", "处理后台", "按要求逐项录入", "把附件表格中的资料逐项录入后台，缺少必填信息时问我，记录每项结果。"]
    ].map(([glyph, title, subtitle, prompt]) => `<button class="example" data-example="${e(prompt)}">${icon(glyph as "folder" | "browser" | "template")}<span><strong>${title}</strong><small>${subtitle}</small></span></button>`).join("")}</div>
    <p class="compose-footnote">使用你自己的浏览器与账号 · 重要操作由你确认</p>
  </div>`;
}
function rows(tasks: BrowserTask[]): string { return tasks.length ? `<div class="task-rows">${tasks.map((task) => `<div class="task-list-entry" data-task-row="${task.id}"><button class="task-row" data-task="${task.id}"><span class="row-icon">${icon(task.archivedAt ? "archive" : task.pinnedAt ? "pin" : "message")}</span><div class="task-row-copy"><strong>${e(task.title)}</strong><small>${e(task.profileName)} · ${date(task.updatedAt)}</small></div>${pill(task)}</button>${taskMenuButton(task, "list")}</div>`).join("")}</div>` : '<div class="empty">没有找到任务。<br>可以新建任务，或调整搜索关键词和筛选。</div>'; }
function inspectorToggle(): string {
  const label = inspectorOpen ? "收起任务信息侧栏" : "展开任务信息侧栏";
  return `<button id="task-inspector-toggle" type="button" class="inspector-toggle" data-action="toggle-task-inspector" aria-controls="task-inspector" aria-expanded="${inspectorOpen}" aria-label="${label}" title="${label}">${icon("sidebarRight")}<span>任务信息</span></button>`;
}
function mountTaskPreview(): void {
  const panel = inspectorOpen ? root.querySelector<HTMLElement>(".browser-live") : null;
  preview.mount(panel, panel ? selected : null);
}
function toggleTaskInspector(): void {
  inspectorOpen = !inspectorOpen;
  try { localStorage.setItem(inspectorPreference, String(inspectorOpen)); } catch { /* The toggle also works without persistent storage. */ }
  const inspector = root.querySelector<HTMLElement>("#task-inspector");
  if (inspector) inspector.hidden = !inspectorOpen;
  root.querySelector(".task-detail")?.classList.toggle("inspector-collapsed", !inspectorOpen);
  const button = root.querySelector<HTMLButtonElement>("#task-inspector-toggle");
  if (button) {
    const label = inspectorOpen ? "收起任务信息侧栏" : "展开任务信息侧栏";
    button.setAttribute("aria-expanded", String(inspectorOpen));
    button.setAttribute("aria-label", label);
    button.title = label;
  }
  mountTaskPreview();
}
function taskDetail(task: BrowserTask): string {
  const shortcut = "Enter";
  if (TERMINAL_TASKS.has(task.status)) return toolbar(task.title, "", historyActions()) + (task.archivedAt ? `<div class="task-archive-notice">${icon("archive")}<span>已归档 · 任务记录和结果已保留</span><button data-restore-task="${task.id}">移出归档</button></div>` : "") + taskHistory(task, data.settings, statusNames[task.status], itemNames);
  const result = task.result ? taskResultMessage(task, statusNames[task.status]) : "";
  const active = !TERMINAL_TASKS.has(task.status);
  const controls = `<div class="actions">${active ? `${["running", "queued"].includes(task.status) ? '<button data-control="pause">暂停</button>' : !task.pending ? '<button class="primary" data-control="resume">继续任务</button>' : ""}<button data-control="takeover" ${hasTaskBrowser(task) ? "" : 'disabled title="任务连接浏览器后可接管"'}>接管浏览器</button><button class="danger" data-control="cancel">取消</button>` : '<button data-control="rerun">再次执行</button><button data-action="delete-task" class="danger">删除</button>'}<button data-action="save-task-template">保存为模板</button><button data-action="export-task">导出</button></div>`;
  const reply = task.pending ? `<form id="reply-task" class="decision" data-decision-kind="${task.pending.kind}" aria-label="等待你处理"><div class="eyebrow">${task.pending.kind === "confirmation" ? "等待确认" : "等待你处理"}</div><h2>${e(task.pending.title)}</h2><p>${e(task.pending.details)}</p><label for="answer">补充说明或修改要求</label><textarea name="answer" id="answer" placeholder="可以补充信息，或说明需要修改的地方" aria-describedby="reply-help"></textarea><p id="reply-help" class="muted">${task.pending.kind === "confirmation" ? "请点击按钮确认或拒绝本次操作。" : `${shortcut} 发送，Ctrl+Enter 换行。发送后将继续当前任务。`}</p>${replyErrors.has(task.pending.id) ? `<p class="field-error" role="alert">${e(replyErrors.get(task.pending.id))}</p>` : ""}<div class="actions">${task.pending.kind === "handoff" ? '<button type="button" data-action="focus-browser">打开浏览器处理 ↗</button>' : ""}<button type="submit" class="primary" name="decision" value="approve">${task.pending.kind === "confirmation" ? "确认这次操作" : "发送并继续"}</button>${task.pending.kind === "confirmation" ? '<button type="submit" name="decision" value="reject">不执行，重新处理</button>' : ""}</div></form>` : "";
  const transcript = `<section class="panel thread-transcript"><div class="panel-header"><h2>任务进展</h2><small>${task.usage.actions} 次操作</small></div><div class="event-list" id="events">${renderTaskEvents(task.events)}${result}${task.items.length ? `<section class="panel"><div class="panel-header"><h2>逐项结果</h2>${!active && task.items.some(item => item.status !== "completed") ? '<button data-action="retry-items">继续所选项</button>' : ""}</div><div class="item-list">${task.items.map((item) => `<div class="item">${!active && item.status !== "completed" ? `<input type="checkbox" name="retryItem" value="${item.id}" aria-label="继续 ${e(item.label)}">` : ""}<span class="pill">${itemNames[item.status]}</span><div>${e(item.label)}<p class="muted">${e(item.result || "")}</p>${item.evidence ? `<small>依据：${e(item.evidence)}</small>` : ""}</div></div>`).join("")}</div></section>` : ""}${reply}</div>${active && !task.pending ? taskComposer() : ""}</section>`;
  return `${toolbar(task.title, "Task workspace", '<button class="back" data-action="back">← 返回任务</button>' + inspectorToggle())}<div class="task-detail${inspectorOpen ? "" : " inspector-collapsed"}"><div class="thread-main"><div class="task-status"><div class="actions">${pill(task)}<span class="pill">${e(task.profileName)}</span>${task.needsReconciliation ? '<span class="pill partial">需要核查上次操作</span>' : ""}</div></div>${renderExecutionStatus(task)}${transcript}</div><aside id="task-inspector" class="thread-inspector" aria-label="任务信息" ${inspectorOpen ? "" : "hidden"}><div class="inspector-actions">${controls}</div>${previewMarkup()}${renderModelInfo(task, data.settings)}${task.plan.length ? `<section class="panel"><h2>执行步骤</h2><ol class="plan">${task.plan.map((step) => `<li>${e(step)}</li>`).join("")}</ol></section>` : ""}${renderJevProgress(task)}<section class="panel"><h2>运行情况</h2><div class="grid-two"><div><small>累计耗时</small><span class="metric" data-elapsed>${elapsed(task)}s</span></div><div><small>主模型估算费用</small><span class="metric">$${task.usage.costUsd.toFixed(3)}</span></div></div><p class="muted">上限 ${task.limits.minutes} 分钟 · ${task.limits.actions} 次操作 · $${task.limits.budgetUsd}</p><small>${e(taskBudgetNote(task))}</small><br><small>${task.usage.inputTokens} 输入（含缓存） / ${task.usage.outputTokens} 输出 token</small></section>${task.outputs?.length ? `<section class="panel"><h2>下载的文件</h2>${task.outputs.map(file => `<button data-output-file="${file.id}">${e(file.name)} ↗</button>`).join("")}</section>` : ""}<details class="panel"><summary>执行记录与资料版本</summary><p class="muted">${task.materials.map((item) => `${e(item.name)} v${item.version}`).join("、") || "未选择保存的资料"}</p>${task.receipts.map((receipt) => `<p class="muted">${date(receipt.at)} · ${e(receipt.action.summary)}<br>${({ started: "已请求执行", executed: "动作已执行", uncertain: "结果未确认" })[receipt.status]}</p>`).join("")}</details></aside></div>`;
}
function materials(): string {
  const material = data.materials.find((item) => item.id === editMaterial);
  return `${toolbar("资料与附件", "Personal materials", '<button data-action="export-materials">导出资料</button>')}<p class="muted">仅在任务中选择后使用。临时回答不会自动保存到这里。</p><div class="grid-two"><form id="material-form" class="panel"><h2>${material ? "编辑资料" : "添加一份资料"}</h2><div class="field"><label for="material-name">名称</label><input id="material-name" name="name" required value="${e(material?.name || "")}" placeholder="求职资料 / 工作账号信息"></div><div class="field"><label for="material-scope">适用范围</label><input id="material-scope" name="scope" value="${e(material?.scope || "")}" placeholder="例如：招聘申请"></div><div class="field"><label for="material-content">资料内容</label><textarea id="material-content" name="content" rows="9" required placeholder="姓名、联系方式、教育经历，或任务需要的具体信息">${e(material?.content || "")}</textarea></div><button class="primary">保存资料</button>${material ? '<button type="button" data-action="clear-material">取消编辑</button>' : ""}</form><div>${data.materials.map((item) => `<section class="panel"><div class="panel-header"><h2>${e(item.name)}</h2><small>v${item.version}</small></div><small>${e(item.scope || "未指定范围")}</small><p class="material-body">${e(item.content)}</p><div class="actions"><button data-edit-material="${item.id}">编辑</button><button data-delete-material="${item.id}" class="danger">删除</button></div></section>`).join("") || '<div class="empty">保存常用资料，让每次填写更省心。</div>'}</div></div><section class="panel"><div class="panel-header"><h2>附件库</h2><button data-action="import-library">＋ 添加附件</button></div>${data.attachments.map((file) => `<div class="item"><div class="task-row-copy">${e(file.name)}<p class="muted">${Math.ceil(file.size / 1024)} KB</p></div><button data-open-file="${file.id}">打开</button><button class="danger" data-delete-file="${file.id}">删除</button></div>`).join("") || '<small>可以保存简历、表格、图片等任务文件。</small>'}</section>`;
}
function templates(): string {
  return `${toolbar("任务模板", "Reusable tasks")}<p class="muted">复用操作要求、资料选择和授权范围。使用时可以修改参数，执行时重新识别网页。</p>${data.templates.length ? `<div class="grid-two">${data.templates.map(template => `<section class="panel"><h2>${e(template.name)}</h2><p>${e(template.task.prompt)}</p><small>${date(template.updatedAt)}</small><div class="actions"><button class="primary" data-use-template="${template.id}">使用 / 编辑</button><button class="danger" data-delete-template="${template.id}">删除</button></div></section>`).join("")}</div>` : '<div class="empty">在新建任务时保存模板，或从已完成的任务保存。</div>'}`;
}
function jevSettings(): string {
  const s = data.settings;
  const provider = jevProviderFor(s);
  return `<form id="jev-settings-form" class="panel"><div class="panel-header"><h2>Jev 浏览器执行</h2><span class="pill">${s.jevEnabled ? "已启用" : "未启用"}</span></div>
    <p class="muted">由 Jev 选择点击、填写和滚动，主模型按需提供填写内容、处理复杂任务并核查结果。启用后，任务要求与当前页面文字会发送到 TypeSafe；选择 Vercel 时还会经过其 AI Gateway。</p>
    <div class="field"><label for="jev-mode">运行方式</label><select id="jev-mode" name="jevMode"><option value="driver" ${s.jevMode !== "advisory" ? "selected" : ""}>Jev 优先执行（推荐）</option><option value="advisory" ${s.jevMode === "advisory" ? "selected" : ""}>主模型执行，Jev 辅助判断</option></select><small>提交确认、支付接管和暂停规则在两种方式下均生效。</small></div>
    <div class="field"><label for="jev-provider">连接服务</label><select id="jev-provider" name="jevProvider"><option value="typesafe" ${provider === "typesafe" ? "selected" : ""}>TypeSafe 官方直连（Jev API Key）</option><option value="vercel" ${provider === "vercel" ? "selected" : ""}>Vercel AI Gateway</option></select><small>两种服务的密钥分别保存。切换后请先保存，再测试连接或打开控制台。</small></div>
    <div class="field"><label for="jev-api-key">对应服务的 API Key</label><input id="jev-api-key" name="jevApiKey" type="password" autocomplete="new-password" placeholder="输入所选服务的密钥；已保存时可留空"><small>已保存的配置：${provider === "typesafe" ? "TypeSafe / jev-latest" : "Vercel / typesafe-ai/jev"} · ${s.hasJevApiKey ? "密钥已加密保存" : "尚未配置密钥"}</small></div>
    <label><input id="jev-enabled" name="jevEnabled" type="checkbox" ${s.jevEnabled ? "checked" : ""}>启用 Jev</label>
    <p class="muted">每个任务最多判断 100 次；不确定或不可用时由主模型继续。Jev 与文本辅助调用的费用不计入 主模型估算费用上限，实际费用请查看服务商账单。</p>
    <div class="actions"><button class="primary" type="submit">保存 Jev 设置</button><button type="button" data-action="test-jev">测试 Jev 连接</button><button type="button" data-action="clear-jev-key" class="danger">删除 Jev 密钥</button></div>
    <div class="actions"><button type="button" data-action="jev-billing">充值 / 查看余额 ↗</button><button type="button" data-action="jev-keys">创建 API Key ↗</button></div></form>`;
}
function settings(): string { const s = data.settings; return `${toolbar("Agent 设置", "Agent & privacy", '<button class="primary return-agent" data-action="return-agent">← 返回 Agent 对话</button>')}<div class="settings-wrap">${nativeBrowserSettings(profiles?.profiles || [], data.nativeBrowsers || [], nativePairing, nativeAuthorization, data.nativeInstallations || [])}<form id="settings-form"><section class="panel"><h2>模型服务</h2><p class="muted">使用 API 密钥连接。任务所需的网页、资料和附件信息会发送给你配置的模型服务。</p><div class="field"><label for="model">模型名称</label><input id="model" name="model" value="${e(s.model)}" required></div><div class="field"><label for="baseUrl">API 地址</label><input id="baseUrl" name="baseUrl" value="${e(s.baseUrl)}" required type="url"></div><div class="field"><label for="authMode">鉴权方式</label><select id="authMode" name="authMode"><option value="" ${!s.authMode ? "selected" : ""}>自动选择</option><option value="apiKey" ${s.authMode === "apiKey" ? "selected" : ""}>API Key（x-api-key）</option><option value="bearer" ${s.authMode === "bearer" ? "selected" : ""}>Bearer Token</option></select></div><div class="field"><label for="apiKey">API 密钥 · ${s.hasApiKey ? "已由系统安全存储保护，留空保留" : "尚未配置"}</label><input id="apiKey" name="apiKey" type="password" autocomplete="new-password" placeholder="输入密钥后保存"></div><div class="actions"><button class="primary">保存设置</button><button type="button" data-action="test-connection">测试连接</button><button type="button" data-action="clear-key" class="danger">删除密钥</button></div></section><section class="panel"><h2>运行与记录</h2><div class="grid-two"><div class="field"><label>不同 Profile 的并发任务数</label><input name="maxConcurrent" type="number" min="1" max="6" value="${s.maxConcurrent}"></div><div class="field"><label>已结束任务保留天数</label><input name="retentionDays" type="number" min="1" max="3650" value="${s.retentionDays}"></div></div><label><input name="saveScreenshots" type="checkbox" ${s.saveScreenshots ? "checked" : ""}>按需保存页面截图（可能包含个人信息）</label><label><input name="notifications" type="checkbox" ${s.notifications ? "checked" : ""}>需要处理或任务结束时发送桌面通知</label></section></form>${jevSettings()}<section class="panel"><h2>诊断导出</h2><p class="muted">仅导出任务状态、时间、用量及动作类型，不包含密钥、对话、网页内容、个人资料或附件路径。</p><button data-action="export-diagnostics">导出脱敏诊断</button></section></div>`; }
function schedules(): string { return `${toolbar("定时任务", "Schedules")}<div class="notice">仅在本机应用运行时执行。错过计划会标记未执行，不会自动补交。执行时间按所选时区显示。</div><div class="grid-two"><form id="schedule-form" class="panel"><h2>${editSchedule ? "编辑计划" : "安排任务"}</h2><div class="field"><label>任务名称</label><input name="name" required></div><div class="field"><label>操作要求</label><textarea name="prompt" required></textarea></div><div class="field"><label>使用浏览器</label><select name="profileId" aria-describedby="schedule-profile-availability" required><option value="">选择浏览器</option>${profileOptions("", true)}</select>${profileAvailabilityHint("schedule-profile-availability")}</div><div class="field"><label>执行时间（按下方时区）</label><input name="at" type="datetime-local" required></div><div class="grid-two"><div class="field"><label>时区</label><input name="timezone" value="${e(Intl.DateTimeFormat().resolvedOptions().timeZone)}" required></div><div class="field"><label>重复</label><select name="repeat"><option value="once">仅一次</option><option value="daily">每天</option></select></div></div>${formExtras()}<button class="primary">保存计划</button>${editSchedule ? '<button type="button" data-action="clear-schedule">取消编辑</button>' : ""}</form><div>${data.schedules.map((schedule) => `<section class="panel"><div class="panel-header"><h2>${e(schedule.name)}</h2><span class="pill">${schedule.enabled ? "已启用" : "已停用"}</span></div><p>${e(schedule.task.prompt)}</p><p class="muted">${e(new Date(schedule.at).toLocaleString("zh-CN", { timeZone: schedule.timezone }))} · ${e(schedule.timezone)}<br>${schedule.repeat === "daily" ? "每天" : "仅一次"}</p>${schedule.missedAt ? '<p class="notice">错过计划，未执行</p>' : ""}${schedule.lastTaskId ? `<button data-task="${schedule.lastTaskId}">查看上次结果</button>` : ""}<div class="actions"><button data-edit-schedule="${schedule.id}">编辑</button><button data-toggle-schedule="${schedule.id}">${schedule.enabled ? "暂停计划" : "重新启用"}</button><button data-delete-schedule="${schedule.id}" class="danger">删除</button></div></section>`).join("") || '<div class="empty">还没有安排定时任务。</div>'}</div></div>`; }
function render(preserve = true): void {
  if (!data) return;
  if (composing && preserve) { renderDeferred = true; return; }
  const key = `${view}:${selected}`;
  preserve = preserve && renderedKey === key;
  const menuState = preserve ? selects.capture() : undefined;
  const invalidFields = preserve ? [...root.querySelectorAll<HTMLElement>(".field-error")].map(node => node.id.replace(/-error$/, "")) : [];
  renderedKey = key;
  const saved = new Map<string, { value: string; checked: boolean }>();
  const detailsKey = (node: HTMLDetailsElement): string => node.id || node.querySelector("summary")?.textContent || "";
  const openDetails = new Set([...root.querySelectorAll("details")].filter(node => node.open).map(detailsKey));
  const oldWorkspace = root.querySelector<HTMLElement>(".workspace");
  const workspaceScroll = oldWorkspace?.scrollTop || 0;
  const followEvents = !oldWorkspace || oldWorkspace.scrollHeight - oldWorkspace.clientHeight - workspaceScroll < 32;
  const sidebarScroll = root.querySelector(".sidebar-recents")?.scrollTop || 0;
  const inspectorScroll = root.querySelector(".thread-inspector")?.scrollTop || 0;
  const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const focusId = active?.id; const start = active?.selectionStart; const end = active?.selectionEnd;
  const focusName = active?.name; const focusForm = active?.form?.id;
  if (preserve) root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input[name]:not([name=attachment]),textarea[name],select[name]").forEach((input) => saved.set(`${input.form?.id}:${input.name}:${input.type === "checkbox" ? input.value : ""}`, { value: input.value, checked: (input as HTMLInputElement).checked }));
  let content = "";
  const task = selected && data.tasks.find((task) => task.id === selected);
  if (task && ["tasks", "history"].includes(view)) content = taskDetail(task);
  else if (view === "tasks") content = `${toolbar("任务工作台", "Browser assistant", `<span class="workspace-status"><span class="task-status-dot ${data.tasks.some(task => task.status === "running") ? "running" : ""}"></span>${data.tasks.filter(task => task.status === "running").length ? `${data.tasks.filter(task => task.status === "running").length} 个任务运行中` : "准备就绪"}</span>`)}${composer()}${data.tasks.some((task) => !TERMINAL_TASKS.has(task.status)) ? `<section class="home-active"><h2>正在进行</h2>${rows(data.tasks.filter((task) => !TERMINAL_TASKS.has(task.status)))}</section>` : ""}`;
  else if (view === "materials") content = materials();
  else if (view === "usage") content = toolbar("Token 消耗", "Usage") + tokenUsagePage(data, usageSource);
  else if (view === "settings") content = settings();
  else if (view === "templates") content = templates();
  else if (view === "schedules") content = schedules();
  else content = `${toolbar("全部任务", "History")}<div class="history-scopes" role="group" aria-label="任务归档筛选"><button data-task-scope="active" aria-pressed="${historyScope === "active"}">未归档 <span>${data.tasks.filter(task => !task.archivedAt).length}</span></button><button data-task-scope="archived" aria-pressed="${historyScope === "archived"}">已归档 <span>${data.tasks.filter(task => task.archivedAt).length}</span></button></div><div class="topline history-filter"><input id="history-search" class="search" aria-label="搜索任务" placeholder="搜索任务、结果、浏览器…" value="${e(search)}"><select id="history-filter" class="search" aria-label="任务状态"><option value="all">所有状态</option>${Object.entries(statusNames).map(([key, label]) => `<option value="${key}" ${filter === key ? "selected" : ""}>${label}</option>`).join("")}</select></div>${historyScope === "archived" ? '<p class="muted archive-description">归档的任务保留记录和结果，可通过“…”菜单移出归档。</p>' : ""}${rows(data.tasks.filter((task) => (historyScope === "archived" ? !!task.archivedAt : !task.archivedAt) && (filter === "all" || task.status === filter) && `${task.title} ${task.profileName} ${task.result?.summary || ""}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => (b.archivedAt || b.updatedAt).localeCompare(a.archivedAt || a.updatedAt)))}`;
  root.innerHTML = `<div class="app-frame">${nav()}<main class="workspace ${view === "tasks" && !selected ? "is-home" : selected ? "is-thread" : "is-page"}">${content}</main></div>`;
  const recents = root.querySelector(".sidebar-recents"); if (recents) recents.scrollTop = sidebarScroll;
  taskMenus.refresh();
  const inspector = root.querySelector(".thread-inspector"); if (inspector && preserve) inspector.scrollTop = inspectorScroll;
  mountTaskPreview();
  if (!profiles) {
    root.querySelectorAll<HTMLSelectElement>('select[name="profileId"]').forEach(select => {
      select.disabled = true;
      select.options[0].textContent = profilesError ? "浏览器列表读取失败" : "正在读取浏览器列表…";
    });
    root.querySelectorAll<HTMLButtonElement>("#create-task button.primary, #schedule-form button.primary").forEach(button => button.disabled = true);
    if (profilesError) {
      const notice = document.createElement("div");
      notice.className = "notice";
      notice.innerHTML = '浏览器列表读取失败。<button type="button">重新读取</button>';
      notice.querySelector("button")!.addEventListener("click", () => { void loadProfiles(); });
      root.querySelector(".workspace")!.prepend(notice);
    }
  }
  if (!preserve && view === "tasks" && formDraft) {
    const form = root.querySelector<HTMLFormElement>("#create-task");
    if (form) { populateTaskForm(form, formDraft); (form.elements.namedItem("templateName") as HTMLInputElement).value = data.templates.find(template => template.id === editTemplate)?.name || ""; }
  }
  if (!preserve && view === "schedules" && editSchedule) {
    const schedule = data.schedules.find(item => item.id === editSchedule);
    const form = root.querySelector<HTMLFormElement>("#schedule-form");
    if (schedule && form) {
      populateTaskForm(form, schedule.task);
      const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: schedule.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(schedule.at));
      const value = (type: string): string => parts.find(part => part.type === type)?.value || "";
      const fields = { name: schedule.name, timezone: schedule.timezone, repeat: schedule.repeat, at: `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}` };
      for (const [name, value] of Object.entries(fields)) (form.elements.namedItem(name) as HTMLInputElement).value = value;
    }
  }
  if (preserve) {
    root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input[name]:not([name=attachment]),textarea[name],select[name]").forEach((input) => { const previous = saved.get(`${input.form?.id}:${input.name}:${input.type === "checkbox" ? input.value : ""}`); if (previous) { input.value = previous.value; if (input.type === "checkbox") (input as HTMLInputElement).checked = previous.checked; } });
    root.querySelectorAll("details").forEach(node => { node.open = openDetails.has(detailsKey(node)); });
    const input = (focusId ? document.getElementById(focusId) : [...root.querySelectorAll<HTMLInputElement>("input,textarea,select")].find(node => node.name === focusName && node.form?.id === focusForm)) as HTMLInputElement | undefined;
    input?.focus({ preventScroll: true });
    if (input && typeof start === "number" && typeof end === "number") { try { input.setSelectionRange(start, end); } catch {} }
    const workspace = root.querySelector(".workspace"); if (workspace) workspace.scrollTop = workspaceScroll;
  }
  if (!preserve) restoreForms();
  if (restoringWorkspace && profiles) {
    const form = root.querySelector<HTMLFormElement>("#create-task");
    if (form && formDraft) populateTaskForm(form, formDraft);
    restoreForms(); restoringWorkspace = false;
  }
  // The workspace owns conversation scrolling. Follow the latest message only
  // when opening a task or when the reader was already at the bottom.
  const workspace = root.querySelector<HTMLElement>(".workspace");
  if (workspace && root.querySelector("#events") && (!preserve || followEvents)) workspace.scrollTop = workspace.scrollHeight;
  root.querySelectorAll<HTMLLabelElement>("label").forEach(label => {
    if (label.htmlFor || label.querySelector("input,textarea,select")) return;
    const field = label.nextElementSibling;
    if (field?.matches("input,textarea,select")) {
      if (!field.id) field.id = `field-${(field as HTMLInputElement).form?.id || "task"}-${(field as HTMLInputElement).name}`;
      label.htmlFor = field.id;
    }
  });
  selects.mount(menuState);
  for (const id of invalidFields) {
    const field = document.getElementById(id) as HTMLInputElement | null;
    if (field && !field.validity.valid) showFieldError(field, false);
  }
  if (preserve && focusId && !menuState) document.getElementById(focusId)?.focus({ preventScroll: true });
  refreshWorkspaceSwitcher();
  showPending();
}
function populateTaskForm(form: HTMLFormElement, input: CreateTaskInput): void {
  const values: Record<string, string | number | undefined> = { prompt: input.prompt, profileId: input.profileId, authorization: input.authorization, items: input.items?.join("\n"), minutes: input.limits?.minutes, actions: input.limits?.actions, budgetUsd: input.limits?.budgetUsd, grantOrigin: input.grant?.origin, grantMax: input.grant?.maxActions };
  for (const [name, value] of Object.entries(values)) { const field = form.elements.namedItem(name) as HTMLInputElement | null; if (field && value !== undefined) field.value = String(value); }
  form.querySelectorAll<HTMLInputElement>("[name=material],[name=attachment],[name=grantEffect]").forEach(field => {
    const values: string[] = field.name === "material" ? input.materialIds || [] : field.name === "attachment" ? input.attachmentIds || [] : input.grant?.effects || [];
    field.checked = values.includes(field.value);
  });
}
function formInput(form: HTMLFormElement): CreateTaskInput {
  const f = new FormData(form);
  return { prompt: String(f.get("prompt") || ""), profileId: String(f.get("profileId") || ""), authorization: String(f.get("authorization") || ""), materialIds: f.getAll("material").map(String), attachmentIds: [...new Set([...selectedFiles, ...f.getAll("attachment").map(String)])],
    grant: f.get("grantOrigin") ? { origin: String(f.get("grantOrigin")), effects: f.getAll("grantEffect").map(String) as Array<"submit" | "send" | "delete">, maxActions: Number(f.get("grantMax")) } : undefined,
    items: String(f.get("items") || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    limits: { minutes: Number(f.get("minutes")), actions: Number(f.get("actions")), budgetUsd: Number(f.get("budgetUsd")) } };
}
let validationFocusQueued = false;
function showFieldError(field: HTMLInputElement, focus: boolean): void {
  for (let parent = field.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
  const control = document.getElementById(`${field.id}-trigger`) || field;
  const anchor = field.closest(".select-field") || field;
  const id = `${field.id}-error`;
  let error = document.getElementById(id);
  if (!error) { error = document.createElement("p"); error.id = id; error.className = "field-error"; error.setAttribute("role", "alert"); anchor.after(error); }
  error.textContent = field.validity.valueMissing ? "请填写此项。" : field.validationMessage;
  if (field.name === "profileId" && field.validity.valueMissing) error.textContent = "请选择一个空闲浏览器。";
  control.setAttribute("aria-invalid", "true");
  control.setAttribute("aria-describedby", id);
  if (focus && !validationFocusQueued) {
    validationFocusQueued = true;
    queueMicrotask(() => { control.focus(); control.scrollIntoView({ block: "nearest" }); validationFocusQueued = false; });
  }
}
root.addEventListener("invalid", event => {
  event.preventDefault(); showFieldError(event.target as HTMLInputElement, true);
}, true);
const clearFieldError = (event: Event): void => {
  const field = event.target as HTMLInputElement;
  if (!field.matches("input,textarea,select") || !field.validity.valid) return;
  document.getElementById(`${field.id}-error`)?.remove();
  const control = document.getElementById(`${field.id}-trigger`) || field;
  control.removeAttribute("aria-invalid");
  if (control.getAttribute("aria-describedby") === `${field.id}-error`) control.removeAttribute("aria-describedby");
};
root.addEventListener("input", clearFieldError);
root.addEventListener("change", clearFieldError);
document.addEventListener("compositionstart", () => { composing = true; });
document.addEventListener("compositionend", () => {
  composing = false;
  if (renderDeferred) { renderDeferred = false; window.setTimeout(() => render(), 0); }
});
root.addEventListener("auxclick", event => { openTaskLink(event, url => api.openLink(url), toast); });
root.addEventListener("click", async (event) => {
  if (openTaskLink(event, url => api.openLink(url), toast)) return;
  const button = (event.target as Element).closest<HTMLElement>("button,a"); if (!button) return;
  const d = button.dataset;
  if (d.usageSource && ["all", "model", "jev", "helper"].includes(d.usageSource)) { usageSource = d.usageSource as TokenSource; render(); root.querySelector<HTMLButtonElement>(`[data-usage-source="${usageSource}"]`)?.focus({ preventScroll: true }); return; }
  if (pending && !["pause", "cancel", "takeover"].includes(d.control || "") && !["focus-browser", "toggle-sidebar", "toggle-task-inspector"].includes(d.action || "")) {
    event.preventDefault(); toast("正在保存或处理操作，请稍候。"); return;
  }
  if (d.action === "preset-deepseek") {
    const form = document.getElementById("settings-form") as HTMLFormElement;
    const set = (name: string, value: string) => { (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value = value; };
    set("baseUrl", "https://api.deepseek.com/anthropic"); set("model", "deepseek-flash"); set("authMode", "bearer"); set("apiKey", "");
    form.dispatchEvent(new Event("input", { bubbles: true }));
    (form.elements.namedItem("apiKey") as HTMLInputElement).focus();
    toast("??? DeepSeek ?????????????????????????????"); return;
  }
  if (d.action === "toggle-task-inspector") { toggleTaskInspector(); return; }
  if (d.taskScope) { historyScope = d.taskScope as "active" | "archived"; render(); return; }
  if (d.restoreTask) { void manageTask(d.restoreTask, "restore"); return; }
  if (d.action === "toggle-sidebar") {
    const collapsed = root.classList.toggle("sidebar-collapsed");
    button.setAttribute("aria-expanded", String(!collapsed));
    button.setAttribute("aria-label", collapsed ? "展开侧栏" : "收起侧栏");
    button.title = collapsed ? "展开侧栏" : "收起侧栏";
    return;
  }
  if (d.nav) {
    event.preventDefault();
    // Returning to the current view must not redraw the form or discard its draft.
    if (view === d.nav && !selected) return;
    if (d.nav === "settings") settingsReturn = { view, selected };
    rememberForms();
    const draft = root.querySelector<HTMLFormElement>("#create-task");
    if (draft) formDraft = formInput(draft);
    view = d.nav; selectedFiles = pageFiles.get(view) || []; selected = ""; render(false);
    if (d.focus) { const field = document.getElementById(d.focus); field?.scrollIntoView({ block: "center" }); field?.focus({ preventScroll: true }); }
    return;
  }
  if (d.task) { if (selected === d.task) return; rememberForms(); const draft = root.querySelector<HTMLFormElement>("#create-task"); if (draft) formDraft = formInput(draft); selected = d.task; if (!["tasks", "history"].includes(view)) view = "tasks"; render(false); return; }
  if (d.example) { const textarea = root.querySelector<HTMLTextAreaElement>("[name=prompt]"); if (textarea) { textarea.value = textarea.value.trim() ? `${textarea.value.trim()}\n\n${d.example}` : d.example; textarea.focus(); } return; }
  if (d.removeFile) { selectedFiles = selectedFiles.filter((id) => id !== d.removeFile); root.querySelectorAll<HTMLInputElement>('[name="attachment"]').forEach(field => { if (field.value === d.removeFile) field.checked = false; }); render(); return; }
  if (d.useTemplate) { const template = data.templates.find(item => item.id === d.useTemplate)!; forgetForm("create-task"); formDraft = template.task; editTemplate = template.id; selectedFiles = template.task.attachmentIds || []; view = "tasks"; selected = ""; render(false); return; }
  if (d.editMaterial) { forgetForm("material-form"); editMaterial = d.editMaterial; render(false); document.getElementById("material-name")?.focus(); return; }
  if (d.editSchedule) { forgetForm("schedule-form"); editSchedule = d.editSchedule; selectedFiles = data.schedules.find(item => item.id === editSchedule)?.task.attachmentIds || []; render(false); root.querySelector<HTMLInputElement>('#schedule-form [name="name"]')?.focus(); return; }
  if (d.action === "return-agent") { rememberForms(); view = settingsReturn.view === "settings" ? "tasks" : settingsReturn.view; selected = settingsReturn.selected; if (!["tasks", "history"].includes(view)) { view = "tasks"; selected = ""; } selectedFiles = pageFiles.get("tasks") || []; render(false); root.querySelector<HTMLElement>("#prompt, #answer, #steering")?.focus({ preventScroll: true }); return; }
  if (d.action === "back") { rememberForms(); selected = ""; selectedFiles = pageFiles.get("tasks") || []; render(false); return; }
  if (d.action === "edit-task") {
    const task = data.tasks.find(task => task.id === selected);
    if (!task) return;
    selected = ""; view = "tasks"; forgetForm("create-task"); editTemplate = "";
    formDraft = { prompt: task.prompt, profileId: task.profileId, authorization: task.authorization, materialIds: task.materials.map(item => item.id), attachmentIds: task.attachments.map(item => item.id), items: task.items.map(item => item.label), limits: task.limits };
    selectedFiles = [...formDraft.attachmentIds!]; pageFiles.set("tasks", selectedFiles);
    render(false); document.getElementById("prompt")?.focus(); return;
  }
  if (d.action === "save-template" && !root.querySelector<HTMLFormElement>("#create-task")!.reportValidity()) return;
  if (!Object.keys(d).some((key) => ["control", "disconnectNative", "deleteTemplate", "deleteMaterial", "deleteFile", "openFile", "outputFile", "deleteSchedule", "toggleSchedule", "action"].includes(key))) return;
  const destructive = d.deleteTemplate ? ["删除这个模板？", "删除后无法恢复，已经创建的任务不会受影响。"]
    : d.deleteMaterial ? ["删除这份资料？", "删除后无法恢复，请确认不再需要这份资料。"]
    : d.deleteFile ? ["删除这个附件？", "该附件将从本机附件库中移除。"]
    : d.deleteSchedule ? ["删除这个定时任务？", "删除后不会再按此计划执行。"]
    : d.disconnectNative ? ["断开浏览器配对？", "再次使用这个浏览器前，需要重新配对扩展。"]
    : d.action === "delete-task" ? ["删除这条任务？", "任务记录和结果将被删除，无法恢复。"]
    : ["clear-key", "clear-jev-key"].includes(d.action || "") ? ["删除已保存的密钥？", "后续使用此服务前需要重新填写密钥。"] : undefined;
  // Capture the target before awaiting a dialog or an IPC response.
  const targetTask = selected;
  if (destructive && !await confirmTaskAction(destructive[0], destructive[1])) return;
  void act(async () => {
    if (d.disconnectNative) { await api.disconnectNativeBrowser(d.disconnectNative); if (nativePairing?.profileId === d.disconnectNative) nativePairing = undefined; }
    if (d.control) await api.control(targetTask, d.control as any);
    if (d.deleteTemplate) { await api.deleteTemplate(d.deleteTemplate); if (editTemplate === d.deleteTemplate) { editTemplate = ""; formDraft = undefined; } }
    if (d.deleteMaterial) { await api.deleteMaterial(d.deleteMaterial); if (editMaterial === d.deleteMaterial) { forgetForm("material-form"); editMaterial = ""; render(false); } toast("资料已删除。"); }
    if (d.deleteFile) { await api.deleteAttachment(d.deleteFile); selectedFiles = selectedFiles.filter(id => id !== d.deleteFile); toast("附件已删除。"); }
    if (d.openFile) await api.openArtifact(d.openFile);
    if (d.outputFile) await api.openArtifact(d.outputFile, selected);
    if (d.deleteSchedule) { await api.deleteSchedule(d.deleteSchedule); if (editSchedule === d.deleteSchedule) { forgetForm("schedule-form"); editSchedule = ""; render(false); } toast("定时任务已删除。"); }
    if (d.toggleSchedule) { const schedule = data.schedules.find((item) => item.id === d.toggleSchedule)!; await api.saveSchedule({ ...schedule, enabled: !schedule.enabled }); }
    switch (d.action) {
      case "retry-items": { const ids = [...root.querySelectorAll<HTMLInputElement>("[name=retryItem]:checked")].map(input => input.value); const task = await api.retryItems(selected, ids); selected = task.id; view = "tasks"; break; }
      case "save-template": { const form = root.querySelector<HTMLFormElement>("#create-task")!; const task = formInput(form); const name = String(new FormData(form).get("templateName") || task.prompt.slice(0, 48)); const saved = await api.saveTemplate({ id: editTemplate || undefined, name, task }); editTemplate = saved.id; formDraft = saved.task; toast("模板已保存，可在任务模板中重复使用。"); break; }
      case "save-task-template": { const task = data.tasks.find(task => task.id === selected)!; await api.saveTemplate({ name: task.title, task: { prompt: task.prompt, profileId: task.profileId, authorization: task.authorization, materialIds: task.materials.map(item => item.id), attachmentIds: task.attachments.map(item => item.id), items: task.items.map(item => item.label), limits: task.limits, grant: task.grant } }); toast("已保存为任务模板。"); break; }
      case "attach": { const files = await api.importAttachments(); selectedFiles.push(...files.map((file) => file.id)); break; }
      case "import-library": await api.importAttachments(); break;
      case "back": selected = ""; break;
      case "clear-schedule": forgetForm("schedule-form"); editSchedule = ""; selectedFiles = []; render(false); break;
      case "clear-material": forgetForm("material-form"); editMaterial = ""; render(false); break;
      case "focus-browser": await api.focusTaskBrowser(selected); break;
      case "extension-folder": await api.openNativeExtensionFolder(); break;
      case "pair-native": { const profileId = root.querySelector<HTMLSelectElement>("#native-profile")?.value; if (!profileId) throw new Error("请选择系统 Profile。"); nativePairing = { profileId, ...await api.pairNativeBrowser(profileId) }; break; }
      case "authorize-native": {
        const profileId = root.querySelector<HTMLSelectElement>("#native-profile")?.value;
        if (!profileId) throw new Error("请选择系统 Profile。");
        nativeAuthorization = { profileId, ...await api.authorizeNativeBrowser(profileId) };
        nativePairing = undefined; break;
      }
      case "copy-native-code": if (nativePairing) { await navigator.clipboard.writeText(nativePairing.code); toast("配对码已复制，请粘贴到 Chrome 的 ProfilePilot 扩展。"); } break;
      case "test-jev": {
        const form = root.querySelector<HTMLFormElement>("#jev-settings-form")!;
        const f = new FormData(form);
        if (String(f.get("jevProvider")) !== jevProviderFor(data.settings) || String(f.get("jevMode")) !== (data.settings.jevMode || "driver") || String(f.get("jevApiKey") || "").trim()) {
          toast("Jev 配置尚未保存，请先点击“保存 Jev 设置”，再测试连接。", true); break;
        }
        toast("正在测试 Jev 连接…"); toast(await api.testJevConnection()); break; }
      case "clear-jev-key": forgetForm("jev-settings-form"); await api.saveJevSettings({ enabled: false, apiKey: "" }); data = await api.snapshot(); render(false); toast("Jev 密钥已删除。"); break;
      case "jev-keys": await api.openJevConsole("keys"); break;
      case "jev-billing": await api.openJevConsole("billing"); break;
      case "test-connection": {
        const form = root.querySelector<HTMLFormElement>("#settings-form")!;
        const f = new FormData(form);
        if (String(f.get("model")) !== data.settings.model || String(f.get("baseUrl")) !== data.settings.baseUrl || String(f.get("authMode") || "") !== (data.settings.authMode || "") || String(f.get("apiKey") || "").trim()) {
          toast("模型配置尚未保存，请先点击“保存设置”，再测试连接。", true); break;
        }
        toast("正在测试模型连接…"); toast(await api.testConnection()); break; }
      case "clear-key": forgetForm("settings-form"); await api.saveSettings({ ...data.settings, apiKey: "" }); toast("模型密钥已删除。"); break;
      case "delete-task": await api.deleteTask(targetTask); if (selected === targetTask) selected = ""; toast("任务已删除。"); break;
      case "export-task": { const result = await api.exportData("task", selected); if (result) toast(`已导出：${result}`); break; }
      case "export-materials": { const result = await api.exportData("materials"); if (result) toast(`已导出：${result}`); break; }
      case "export-diagnostics": { const result = await api.exportData("diagnostics"); if (result) toast(`已导出脱敏诊断：${result}`); break; }
    }
  }, ["pause", "cancel", "takeover"].includes(d.control || ""));
});
root.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing || composing || event.keyCode === 229) return;
  const field = event.target;
  if (!(field instanceof HTMLTextAreaElement) || !field.matches("#prompt, #answer, #steering")) return;
  const form = field.closest<HTMLFormElement>("#create-task, #reply-task, #steer-task");
  if (!form || field.disabled || field.readOnly) return;
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    field.setRangeText("\n", field.selectionStart, field.selectionEnd, "end");
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertLineBreak" }));
    return;
  }
  if (event.shiftKey || event.altKey) return;
  // Explicit confirmation remains a button click; a shortcut must not approve
  // a consequential action while the user is composing an explanation.
  if (form?.dataset.decisionKind === "confirmation") return;
  const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!submit || submit.disabled) return;
  event.preventDefault();
  if (!event.repeat) form.requestSubmit(submit);
});
root.addEventListener("submit", (event) => {
  event.preventDefault(); const form = event.target as HTMLFormElement; const values = new FormData(form);
  void act(async () => {
    if (form.id === "create-task") { const task = await api.create(formInput(form)); forgetForm("create-task"); pageFiles.delete("tasks"); selected = task.id; selectedFiles = []; formDraft = undefined; editTemplate = ""; }
    if (form.id === "reply-task") {
      const task = data.tasks.find((task) => task.id === selected)!;
      const decision = task.pending!;
      const approve = (event as SubmitEvent).submitter?.getAttribute("value") !== "reject";
      replyErrors.delete(decision.id);
      try { await api.reply(task.id, decision.id, String(values.get("answer") || ""), approve); }
      catch (error) { replyErrors.set(decision.id, String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method.*?Error: /, "")); render(); throw error; }
      forgetForm("reply-task");
      if (decision.kind !== "confirmation") toast("消息已发送，将继续当前任务。");
    }
    if (form.id === "material-form") { await api.saveMaterial({ id: editMaterial || undefined, name: String(values.get("name")), scope: String(values.get("scope")), content: String(values.get("content")) }); forgetForm("material-form"); editMaterial = ""; render(false); toast("资料已保存。"); }
    if (form.id === "jev-settings-form") {
      const key = String(values.get("jevApiKey") || "").trim();
      (form.elements.namedItem("jevApiKey") as HTMLInputElement).value = "";
      await api.saveJevSettings({ enabled: values.has("jevEnabled"), provider: String(values.get("jevProvider")) as JevProvider, mode: String(values.get("jevMode")) as "driver" | "advisory", ...(key ? { apiKey: key } : {}) });
      forgetForm("jev-settings-form"); toast("Jev 设置已保存。");
    }
    if (form.id === "settings-form") { await api.saveSettings({ model: String(values.get("model")), baseUrl: String(values.get("baseUrl")), authMode: (String(values.get("authMode") || "") || undefined) as "apiKey" | "bearer" | undefined, apiKey: values.get("apiKey") ? String(values.get("apiKey")) : undefined, maxConcurrent: Number(values.get("maxConcurrent")), retentionDays: Number(values.get("retentionDays")), saveScreenshots: values.has("saveScreenshots"), notifications: values.has("notifications") }); (form.elements.namedItem("apiKey") as HTMLInputElement).value = ""; modelCatalogs.clear(); forgetForm("settings-form"); toast("设置已保存。"); }
    if (form.id === "schedule-form") { await api.saveSchedule({ id: editSchedule || undefined, name: String(values.get("name")), task: formInput(form), at: zonedLocalToIso(String(values.get("at")), String(values.get("timezone"))), timezone: String(values.get("timezone")), repeat: String(values.get("repeat")) as "once" | "daily", enabled: true }); forgetForm("schedule-form"); pageFiles.delete("schedules"); editSchedule = ""; selectedFiles = []; render(false); toast("计划已保存。"); }
    if (form.id === "steer-task") {
      const text = String(values.get("steering") || "").trim(); if (!text) return;
      const task = data.tasks.find((task) => task.id === selected)!;
      await api.control(task.id, TERMINAL_TASKS.has(task.status) ? "resume" : "steer", text);
      forgetForm("steer-task");
      const field = root.querySelector<HTMLTextAreaElement>("#steering");
      if (field?.value === String(values.get("steering") || "")) field.value = "";
      toast("消息已发送，将用于后续执行。");
    }
  });
});
root.addEventListener("input", (event) => { const input = event.target as HTMLInputElement; if (input.id === "history-search") { search = input.value; render(); } if (input.id === "steering") updateMessageSend(); });
root.addEventListener("model-menu-open", () => {
  const endpoint = data.settings.baseUrl;
  if (modelCatalogs.get(endpoint)?.requested) return;
  const catalog = { ids: [] as string[], status: "正在读取当前服务的模型列表…", requested: true };
  modelCatalogs.set(endpoint, catalog);
  void api.listModels().then(ids => { catalog.ids = ids; catalog.status = "当前服务的模型 · 选择后自动保存"; }).catch(() => { catalog.status = "暂时无法读取列表。可直接输入模型 ID，或检查模型服务设置。"; }).finally(() => { if (data.settings.baseUrl === endpoint) render(); });
});
root.addEventListener("model-settings", () => {
  root.querySelector<HTMLButtonElement>('.sidebar [data-nav="settings"]')?.click();
  const field = document.getElementById("model"); field?.scrollIntoView({ block: "center" }); field?.focus({ preventScroll: true });
});
root.addEventListener("native-browser-settings", () => {
  root.querySelector<HTMLButtonElement>('.sidebar [data-nav="settings"]')?.click();
  const field = document.getElementById("native-profile-trigger");
  field?.scrollIntoView({ block: "center" }); field?.focus({ preventScroll: true });
});
root.addEventListener("change", event => {
  const select = event.target as HTMLSelectElement;
  if (select.id !== "agent-model" || select.value === data.settings.model) return;
  const previous = data.settings.model;
  const model = select.value;
  void act(async () => {
    try {
      await api.saveSettings({ ...data.settings, model });
      const draft = pageDrafts.get(":settings-form")?.find(field => field.name === "model"); if (draft) draft.value = model;
      toast(`已选择 ${modelLabel(model)}。`);
    } catch (error) { select.value = previous; render(); throw error; }
  });
});
root.addEventListener("change", (event) => { const input = event.target as HTMLInputElement; if (input.name === "attachment") { selectedFiles = input.checked ? [...new Set([...selectedFiles, input.value])] : selectedFiles.filter(id => id !== input.value); render(); } if (input.id === "history-filter") { filter = input.value; render(); } });
async function loadProfiles(): Promise<void> {
  profilesError = false;
  render();
  try {
    const state = await window.profileManager.getInitialState();
    // A pushed state may already have supplied a newer scan during startup.
    if (!profiles) profiles = state;
  } catch {
    profilesError = !profiles;
  }
  render();
}
void api.snapshot().then((snapshot) => { if (!data) { data = snapshot; render(); } }).catch((error) => { if (!data) root.innerHTML = `<p class="loading">无法打开工作台：${e(String(error))}</p>`; });
void loadProfiles();
api.onChanged((snapshot) => { data = snapshot; if (nativePairing && data.nativeBrowsers?.some(s => s.profileId === nativePairing!.profileId && s.connected)) nativePairing = undefined; render(); });
window.profileManager.onStateChanged((state) => { profiles = state; render(); });
window.setInterval(() => {
  const node = root.querySelector("[data-elapsed]"); const task = data?.tasks.find(task => task.id === selected);
  if (node && task) node.textContent = `${elapsed(task)}s`;
  const activity = root.querySelector<HTMLElement>("[data-activity-age]");
  if (activity) activity.textContent = `此步骤已等待 ${Math.max(0, Math.floor((Date.now() - Date.parse(activity.dataset.at!)) / 1000))} 秒`;
}, 1000);
