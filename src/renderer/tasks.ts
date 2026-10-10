import { openTaskLink } from "./task-links";
import { skillDefaults } from "../shared/task-skills";
import { skillLibrary, skillForm, skillFromForm } from "./task-skills";
import { taskTemplateMenu, positionTaskTemplateMenu } from "./task-templates";
import { workspaceSwitcher, workspaceIdentityBar, refreshWorkspaceSwitcher } from "./workspace-switcher";
import { installSidebarResize, sidebarResizeHandle } from "./sidebar-resize";
import { tokenUsagePage } from "./task-token-usage";
import type { TokenSource } from "../shared/task-token-usage";
let usageSource: TokenSource = "all";
import type { TaskApi, TaskSnapshot, BrowserTask, TaskStatus, CreateTaskInput, JevProvider } from "../shared/tasks";
import { TERMINAL_TASKS, jevProviderFor } from "../shared/tasks";
import { zonedLocalToIso } from "../shared/task-time";
import type { AppState } from "./types";
import { taskProfileAvailability } from "./task-profile-availability";

import { taskIcon as icon } from "./task-icons";
import { TaskSelects } from "./task-select";
import { confirmTaskAction } from "./task-confirm";
import { modelLabel } from "../shared/task-model";
import { TaskPreviewView } from "./task-preview";
import { nativeBrowserSettings, type NativePairing } from "./native-browser-settings";
import { nativeTaskOptions, nativeTaskInput } from "./native-task-options";
import { historyActions } from "./task-history";
import { taskMenuButton, TaskMenus, renameTaskTitle, type TaskMenuAction } from "./task-navigation";
import { MessageDrafts, draftKey, messageDelivery, findTaskHit, attentionReason, messageKeyAction, ScopedOperations, type MessageDraft } from "./task-interaction-model";
import { TaskDom, autoGrow, installTaskTooltips, isAtTaskLatest, jumpOverlapsReply, scrollToTaskLatest, revealTaskReply, syncTaskScrollInsets } from "./task-interaction-dom";
import { workbenchThread, taskQuickControls } from "./task-workbench-view";
import { TaskChat } from "./task-chat";
import { workbenchNavigation, searchSnippet, appearanceControls, applyAppearance } from "./task-workbench-navigation";
import { showCommands, showArtifact, type WorkbenchCommand } from "./task-workbench-dialogs";
import { showProfileMemory } from "./task-memory";

declare global { interface Window { tasks: TaskApi; } }
const root = document.getElementById("task-app")!;
const refreshSidebarWidth = installSidebarResize({
  id: "tasks", pane: "#task-sidebar", property: "--task-sidebar-custom-width",
  preference: "profilepilot-task-sidebar-width", min: 140,
  max: () => Math.min(440, (root.querySelector(".app-frame")?.clientWidth ?? window.innerWidth) - 320)
});
const selects = new TaskSelects(root);
const taskDom = new TaskDom(root);
const taskChat = new TaskChat();
let draftStorage: Storage | undefined;
try { draftStorage = localStorage; } catch { /* In-memory drafts remain available. */ }
const messageDrafts = new MessageDrafts(draftStorage);
applyAppearance(draftStorage);
const operations = new ScopedOperations();
let showAttention = false;
const readTasks: Record<string, string> = (() => { try { const value = JSON.parse(localStorage.getItem("profilepilot-task-read") || "{}"); return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {}; } catch { return {}; } })();
let searchTarget = "";
let searchTerm = "";
let initialLoadError = "";
const unseenMessages = new Set<string>();
const platformModifier = /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl";
const newlineHint = `Enter 发送 · Shift+Enter / ${platformModifier}+Enter 换行`;
function messageFormKey(form: HTMLFormElement): string { return form.dataset.draftKey || draftKey(form.dataset.taskId || "", form.id, form.dataset.decisionId); }
function captureMessageDrafts(): void {
  root.querySelectorAll<HTMLFormElement>("form[data-draft-key]").forEach(form => {
    if (form.closest("[data-task-chat-owned]")) return;
    const field = form.querySelector<HTMLTextAreaElement>("textarea[name=prompt],textarea[name=steering],textarea[name=answer]");
    if (field) messageDrafts.set(messageFormKey(form), { text: field.value, ...(form.id === "create-task" ? { attachments: [...selectedFiles] } : {}) });
  });
}
function restoreMessageDrafts(): void {
  root.querySelectorAll<HTMLFormElement>("form[data-draft-key]").forEach(form => {
    if (form.closest("[data-task-chat-owned]")) return;
    const field = form.querySelector<HTMLTextAreaElement>("textarea[name=prompt],textarea[name=steering],textarea[name=answer]");
    const value = messageDrafts.get(messageFormKey(form)).text;
    if (field && field.value !== value) field.value = value;
  });
}
type FieldDraft = { name: string; value: string; checked: boolean; type: string };
const pageDrafts = new Map<string, FieldDraft[]>();
const pageDetails = new Map<string, string[]>();
const pageFiles = new Map<string, string[]>();
const replyErrors = new Map<string, string>();
function rememberForms(): void {
  captureMessageDrafts(); taskDom.capture();
  root.querySelectorAll<HTMLFormElement>("form").forEach(form => {
    if (form.closest("[data-task-chat-owned]")) return;
    pageDrafts.set(form.dataset.draftKey || `${selected}:${form.id}`, [...form.querySelectorAll<HTMLInputElement>("input[name],textarea[name],select[name]")].filter(field => field.type !== "password" && !/apiKey|jevApiKey/i.test(field.name)).map(field => ({ name: field.name, value: field.value, checked: field.checked, type: field.type })));
    pageDetails.set(`${selected}:${form.id}`, [...form.querySelectorAll("details[open] summary")].map(summary => summary.textContent || ""));
  });
  if (root.querySelector("#create-task") || root.querySelector("#schedule-form")) pageFiles.set(view, [...selectedFiles]);
}
function restoreForms(): void {
  root.querySelectorAll<HTMLFormElement>("form").forEach(form => {
    if (form.closest("[data-task-chat-owned]")) return;
    const fields = pageDrafts.get(form.dataset.draftKey || `${selected}:${form.id}`);
    if (!fields) return;
    form.querySelectorAll<HTMLInputElement>("input[name],textarea[name],select[name]").forEach(field => {
      const previous = fields.find(item => item.name === field.name && (field.type !== "checkbox" || item.value === field.value));
      if (previous) { if (field.value !== previous.value) field.value = previous.value; if (field.type === "checkbox") field.checked = previous.checked; }
    });
    const details = pageDetails.get(`${selected}:${form.id}`) || [];
    form.querySelectorAll("details").forEach(node => { node.open = details.includes(node.querySelector("summary")?.textContent || ""); });
  });
}
function forgetForm(id: string): void {
  pageDrafts.delete(`${selected}:${id}`); pageDetails.delete(`${selected}:${id}`);
  // Switching workflows happens on the library page, while the composer is unmounted.
  if (id === "create-task") pageDrafts.delete(draftKey("", "create-task"));
  const form = root.querySelector<HTMLFormElement>(`#${id}`);
  if (form?.dataset.draftKey) pageDrafts.delete(form.dataset.draftKey);
}
const api = window.tasks;
const preview = new TaskPreviewView(api);
const inspectorPreference = "profilepilot-task-browser-panel-open";
let inspectorOpen = false;
try { inspectorOpen = localStorage.getItem(inspectorPreference) === "true"; } catch { /* The browser panel starts closed. */ }
const sidebarPreference = "profilepilot-task-sidebar-collapsed";
try { root.classList.toggle("sidebar-collapsed", localStorage.getItem(sidebarPreference) === "true"); } catch { /* Keep the sidebar expanded. */ }
let data: TaskSnapshot;
let profiles: AppState | undefined;
let profilesError = false;
let view = new URLSearchParams(location.search).get("view") || "tasks";
let selected = new URLSearchParams(location.search).get("task") || "";
let search = "";
let sidebarSearch = "";
let narrowSidebarOpen = false;
let filter = "all";
let historyScope: "active" | "archived" = "active";
let editMaterial = "";
let editSchedule = "";
let editTemplate = "";
let creatingTemplate = false;
let formDraft: CreateTaskInput | undefined;
let selectedFiles: string[] = messageDrafts.get(draftKey("", "create-task")).attachments;

const taskMenus = new TaskMenus(root, id => data?.tasks.find(task => task.id === id), () => false, (id, action) => { void manageTask(id, action); });
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
    if (saved.fields) pageDrafts.set(draftKey("", "create-task"), saved.fields);
    if (saved.details) pageDetails.set(":create-task", saved.details);
  }
} catch { /* A stale or unavailable session cache must not prevent startup. */ }
document.addEventListener("workspace-before-switch", () => {
  rememberForms();
  const form = root.querySelector<HTMLFormElement>("#create-task");
  if (form) formDraft = formInput(form);
  try { sessionStorage.setItem("profilepilot-agent-workspace", JSON.stringify({ view, selected, formDraft, selectedFiles: messageDrafts.get(draftKey("", "create-task")).attachments, editTemplate, fields: pageDrafts.get(draftKey("", "create-task")), details: pageDetails.get(":create-task") })); } catch { /* Storage may be unavailable in restricted sessions. */ }
});
const statusNames: Record<TaskStatus, string> = { queued: "排队中", running: "执行中", waiting_user: "等待你处理", paused: "已暂停", completed: "已完成", partial: "部分完成", failed: "失败", cancelled: "已取消" };
const itemNames: Record<string, string> = { pending: "待处理", running: "处理中", waiting_user: "待补充", completed: "完成", skipped: "跳过", failed: "失败", uncertain: "结果未确认" };
const e = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const date = (value: string): string => new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const pill = (task: BrowserTask): string => `<span class="pill ${task.status}">${statusNames[task.status]}</span>`;
const elapsed = (task: BrowserTask): number => Math.round((task.usage.elapsedMs + (task.runningSince ? Math.max(0, Date.now() - Date.parse(task.runningSince)) : 0)) / 1000);
function taskNavigation(): string { return workbenchNavigation(data.tasks.filter(task => !sidebarSearch.trim() || `${task.title} ${task.profileName}`.toLocaleLowerCase().includes(sidebarSearch.trim().toLocaleLowerCase())), selected, statusNames, readTasks); }
function rememberRead(task: BrowserTask, unread = false): void {
  if (unread) readTasks[task.id] = ""; else readTasks[task.id] = task.updatedAt;
  try { localStorage.setItem("profilepilot-task-read", JSON.stringify(readTasks)); } catch { /* In-memory state remains usable. */ }
}
function openTask(id: string, hit = "", term = ""): void {
  rememberForms(); selected = id; view = "tasks"; searchTarget = hit; searchTerm = term;
  const task = data.tasks.find(task => task.id === id); if (task) rememberRead(task);
  render(false);
  root.querySelector<HTMLElement>(".sidebar-recents .recent-task-row.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function focusComposer(reply = false): void {
  const workspace = root.querySelector<HTMLElement>(".workspace");
  if (reply && workspace?.querySelector("#reply-task")) { revealTaskReply(workspace, true); taskDom.capture(); updateJumpLatest(); return; }
  const field = root.querySelector<HTMLTextAreaElement>(reply ? "#answer" : "#steering,#prompt");
  field?.focus(); field?.scrollIntoView({ block: "nearest" });
}
function fillFollowup(text: string, attachments: string[] = [], taskId = selected): void {
  const key = draftKey(taskId, "steer-task"), current = messageDrafts.get(key);
  const next = current.text.trim() ? `${current.text}\n\n${text}` : text;
  messageDrafts.set(key, { text: next, attachments: [...new Set([...current.attachments, ...attachments])] });
  const form = root.querySelector<HTMLFormElement>("#steer-task");
  if (form?.dataset.taskId === taskId) { const field = form.querySelector<HTMLTextAreaElement>("#steering")!; field.value = next; autoGrow(field); render(); focusComposer(); }
}
function restoreSearchTarget(): void {
  if (!searchTarget) return;
  const node = document.getElementById(searchTarget); if (!node) { searchTarget = ""; return; }
  let parent: HTMLElement | null = node; while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
  if (searchTerm.trim()) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), texts: Text[] = []; while (walker.nextNode()) texts.push(walker.currentNode as Text);
    for (const text of texts) {
      if (text.parentElement?.closest("button,mark")) continue;
      const index = text.data.toLocaleLowerCase().indexOf(searchTerm.trim().toLocaleLowerCase()); if (index < 0) continue;
      const range = document.createRange(); range.setStart(text, index); range.setEnd(text, index + searchTerm.trim().length); const mark = document.createElement("mark"); mark.className = "task-search-hit"; range.surroundContents(mark); break;
    }
  }
  node.setAttribute("tabindex", "-1"); node.focus({ preventScroll: true }); node.scrollIntoView({ block: "center" }); taskDom.capture(); searchTarget = "";
}
function updateJumpLatest(): void {
  const workspace = root.querySelector<HTMLElement>(".workspace"), button = root.querySelector<HTMLButtonElement>(".task-jump-latest");
  if (workspace && button) {
    const latest = isAtTaskLatest(workspace, 64);
    if (latest && !button.hidden) scrollToTaskLatest(workspace);
    button.textContent = unseenMessages.has(selected) ? "有新消息 · 回到最新" : "回到最新消息";
    button.hidden = latest;
    if (latest) unseenMessages.delete(selected);
    else button.hidden = jumpOverlapsReply(workspace, button);
  }
}
function jumpLatest(): void { const workspace = root.querySelector<HTMLElement>(".workspace"); if (workspace) { scrollToTaskLatest(workspace); taskDom.capture(); updateJumpLatest(); } }
function commandMenu(): void {
  const click = (selector: string) => () => root.querySelector<HTMLButtonElement>(selector)?.click();
  const task = data.tasks.find(task => task.id === selected);
  const commands: WorkbenchCommand[] = [
    { id: "new", label: "新任务", hint: `${platformModifier}+Shift+O`, run: click('[data-nav="tasks"]') },
    { id: "search", label: "搜索全部对话与结果", run: () => { rememberForms(); view = "history"; selected = ""; showAttention = false; render(false); document.getElementById("history-search")?.focus(); } },
    { id: "attention", label: "需要处理与完成未读", run: click('[data-action="attention"]') },
    { id: "input", label: "聚焦消息输入框", run: () => focusComposer() },
    { id: "drafts", label: "恢复本任务的答复草稿", run: () => draftMenu() },
    { id: "latest", label: "回到最新消息", run: jumpLatest },
    { id: "settings", label: "Agent 设置与外观", run: click('[data-nav="settings"]') }
  ];
  if (task) commands.push(...["pause", "resume", "cancel", "takeover"].filter(action => root.querySelector(`[data-control="${action}"]`)).map(action => ({ id: action, label: ({ pause: "暂停任务", resume: "继续任务", cancel: "停止任务", takeover: "接管浏览器" })[action]!, disabled: !!root.querySelector<HTMLButtonElement>(`[data-control="${action}"]`)?.disabled, run: click(`[data-control="${action}"]`) })), { id: "export", label: "导出 Markdown", run: click('[data-action="export-readable"]') }, { id: "session", label: "会话模型、限制与授权", run: click('[data-action="session-settings"]') });
  if (task?.pending) commands.push({ id: "answer", label: "处理当前等待事项", hint: task.pending.title, run: () => focusComposer(true) });
  commands.push(...data.tasks.filter(item => !item.archivedAt).map(item => ({ id: `task-${item.id}`, label: `切换任务：${item.title}`, hint: `${item.profileName} · ${statusNames[item.status]}`, run: () => openTask(item.id) })));
  showCommands(commands, platformModifier);
}
function draftMenu(): void {
  const id = selected;
  showCommands(messageDrafts.entries(id).map(([key, draft]) => ({ id: key, label: draft.text.slice(0, 80) || "附件草稿", hint: JSON.parse(key)[1] === "reply-task" ? "问题答复草稿；载入普通消息，不会自动确认" : "消息草稿", run: () => fillFollowup(draft.text, draft.attachments, id) })), platformModifier);
}
function toast(text: string, error = false): void { const node = document.getElementById("task-toast")!; node.textContent = text; node.className = error ? "error" : ""; clearTimeout(toastTimer); toastTimer = window.setTimeout(() => node.textContent = "", 7000); }
function updateMessageSend(): void {
  const field = root.querySelector<HTMLTextAreaElement>("#steering");
  if (field?.closest("[data-task-chat-owned]")) return;
  const send = root.querySelector<HTMLButtonElement>("#steer-task .send-task");
  const form = field?.form;
  if (send) send.disabled = operations.running.has(`task:${form?.dataset.taskId}`) || (!field?.value.trim() && !messageDrafts.get(form ? messageFormKey(form) : "").attachments.length);
}
function showPending(): void {
  root.removeAttribute("aria-busy");
  const scope = selected ? `task:${selected}` : `view:${view}`;
  root.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
    if (button.closest("[data-task-chat-owned]")) return;
    const navigation = button.dataset.nav || button.dataset.task || button.dataset.taskMenu || ["focus-browser", "toggle-sidebar", "toggle-task-inspector", "commands", "jump-latest", "retry-operation", "dismiss-operation", "attention", "focus-reply", "session-settings", "close-session-settings"].includes(button.dataset.action || "");
    const urgent = ["pause", "cancel", "takeover"].includes(button.dataset.control || "");
    if (operations.running.has(scope) && !button.disabled && !navigation && !urgent) { button.disabled = true; button.dataset.pendingDisabled = scope; }
    if (!operations.running.has(button.dataset.pendingDisabled || "") && button.dataset.pendingDisabled) { button.disabled = false; delete button.dataset.pendingDisabled; }
  });
  const indicator = document.getElementById("task-operation-pending");
  if (indicator) indicator.hidden = true;
  const status = root.querySelector(".task-operation-status");
  if (status) status.innerHTML = [...operations.running].map(([key, label]) => `<p role="status" class="task-state" data-operation="${e(key)}">${e(label)}…</p>`).join("") + [...operations.errors].map(([key, error]) => `<div class="operation-error" role="alert"><strong>${e(error.label)}未完成</strong><p>${e(error.message)}</p><button type="button" data-action="retry-operation" data-operation="${e(key)}">重试</button><button type="button" data-action="dismiss-operation" data-operation="${e(key)}">关闭提示</button></div>`).join("");
  if (status && initialLoadError) status.insertAdjacentHTML("beforeend", `<div class="operation-error" role="alert">工作台状态更新失败：${e(initialLoadError)}<button type="button" data-action="retry-load">重新读取状态</button></div>`);
  updateMessageSend();
}
async function act(fn: () => Promise<unknown>, urgent = false, key = selected ? `task:${selected}` : `view:${view}`, label = "处理操作"): Promise<void> {
  const operationKey = urgent ? `${key}:control` : key;
  await operations.run(operationKey, label, async () => {
    await fn();
    try { data = await api.snapshot(); initialLoadError = ""; render(); } catch (error) { initialLoadError = String(error); showPending(); }
  }, showPending);
}
async function manageTask(id: string, action: TaskMenuAction): Promise<void> {
  const task = data.tasks.find(task => task.id === id);
  if (!task || operations.running.has(`task:${id}`)) return;
  if (action === "rename") {
    const title = await renameTaskTitle(task.title);
    if (title !== null && title !== task.title) await act(async () => { await api.updateTaskMetadata(id, { title }); toast("任务名称已更新。"); }, false, `task:${id}`, "更新任务名称");
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
  }, false, `task:${id}`, "更新任务记录");
}
function taskProfiles() { return profiles?.profiles.filter(profile => profile.source === "native" || profile.source === "isolated" && !profile.agentAccessDisabled) || []; }
function profileOptions(selectedId = "", scheduled = false): string {
  return profiles ? taskProfiles().map(profile => {
    const status = taskProfileAvailability(profile, data.tasks, data.nativeBrowsers);
    return `<option value="${e(profile.id)}" data-label="${e(profile.name)}" data-description="${e(status.label)}${profile.source === "native" ? " · 系统 Chrome 扩展" : ""}"  ${profile.id === selectedId ? "selected" : ""}>${e(profile.name)}${profile.source === "native" ? " · 系统 Chrome 扩展" : ""} — ${status.label}</option>`;
  }).join("") : `<option value="" disabled>${profilesError ? "浏览器列表读取失败" : "正在读取浏览器列表…"}</option>`;
}
function profileAvailabilityHint(id: string): string {
  const candidates = taskProfiles();
  const states = candidates.map(profile => taskProfileAvailability(profile, data.tasks, data.nativeBrowsers));
  const available = states.filter(state => state.available).length;
  const disconnected = states.filter(state => state.label.startsWith("待连接")).length;
  let text = profilesError ? "浏览器状态读取失败，请重新读取。" : "正在读取浏览器状态…";
  if (profiles) text = !candidates.length ? "暂无可用于任务的浏览器，请在“浏览器”中添加或启用。"
    : `${available ? `${available} 个空闲` : "暂无空闲浏览器"} · ${candidates.length - available - disconnected} 个占用中${disconnected ? ` · ${disconnected} 个系统 Profile 待连接` : ""}。${disconnected ? "纯文字任务可直接开始；浏览器工具使用前需连接系统 Chrome。" : available ? "未启动的空闲浏览器在首次使用浏览器工具时启动；纯文字任务无需连接。" : "纯文字任务可开始；网页任务使用工具时会检查连接与占用。"}`;
  return `<p id="${id}" class="profile-availability ${profiles && available ? "has-available" : ""}" role="status">${text}</p>`;
}
function toolbar(title: string, _subtitle: string, extra = ""): string {
  return `<header class="topline page-header">${taskSidebarToggle()}<div class="page-heading"><h1 title="${e(title)}">${e(title)}</h1></div><div class="header-actions">${extra}</div></header>`;
}
function taskSidebarToggle(): string {
  const collapsed = window.innerWidth <= 650 ? !narrowSidebarOpen : root.classList.contains("sidebar-collapsed");
  const label = collapsed ? "展开任务侧栏" : "收起任务侧栏";
  return `<button id="task-sidebar-toggle" type="button" class="icon-button sidebar-toggle" data-action="toggle-sidebar" aria-controls="task-sidebar" aria-label="${label}" aria-expanded="${!collapsed}" title="${label}">${icon("sidebar")}</button>`;
}
function nav(): string {
  const links = [["templates", "template", "任务模板"], ["schedules", "clock", "定时任务"], ["history", "history", "全部任务"]] as const;
  return `<aside id="task-sidebar" class="sidebar${narrowSidebarOpen ? " task-sidebar-visible" : ""}" aria-label="任务侧栏">
    ${sidebarResizeHandle("tasks", "task-sidebar", "调整任务侧栏宽度")}
    <div class="task-sidebar-heading"><h1>Agent<span aria-hidden="true">.</span></h1></div>
    <button type="button" class="nav-item new-task" data-nav="tasks">${icon("plus")}<span>新任务</span></button>
    <label class="task-sidebar-search">${icon("search")}<input id="task-sidebar-search" type="search" aria-label="搜索任务列表" placeholder="搜索任务…" value="${e(sidebarSearch)}"></label>
    <button type="button" class="nav-item task-attention-nav" data-action="attention">待处理 <span class="attention-count">${data.tasks.filter(task => attentionReason(task, readTasks[task.id])).length}</span></button>
    <div class="sidebar-recents">${taskNavigation()}</div>
    <nav class="sidebar-tools" aria-label="工作区工具">
      ${links.map(([key, glyph, label]) => `<button class="nav-item ${view === key ? "active" : ""}" data-nav="${key}" title="${label}" ${view === key ? 'aria-current="page"' : ""}>${icon(glyph)}<span>${label}</span></button>`).join("")}
      <details class="sidebar-more"><summary>更多</summary><button class="nav-item" data-nav="usage">${icon("usage")}<span>Token 消耗</span></button><button type="button" class="nav-item" data-action="commands">命令与快捷键</button></details>
    </nav>
    <div class="sidebar-footer"><button class="nav-item ${view === "settings" ? "active" : ""}" data-nav="settings" title="Agent 设置">${icon("settings")}<span>Agent 设置</span></button></div>
  </aside>`;
}
function formExtras(label = "任务选项", open = false): string { return `<details class="details" ${open ? "open" : ""}><summary>${label} <span class="details-hint">资料、授权与运行限制</span></summary><div class="field"><label>模板名称（保存模板时使用）</label><input name="templateName" placeholder="留空则使用任务描述"></div><div class="grid-two"><div><label>使用已保存的资料</label>${data.materials.length ? data.materials.map((material) => `<label><input type="checkbox" name="material" value="${e(material.id)}">${e(material.name)} · v${material.version}</label>`).join("") : '<small>尚未添加资料，可在“资料”中保存。</small>'}</div><div><label>选择附件库中的文件</label>${data.attachments.map(file => `<label><input type="checkbox" name="attachment" value="${e(file.id)}" ${selectedFiles.includes(file.id) ? "checked" : ""}>${e(file.name)}</label>`).join("") || "<small>可先添加附件。</small>"}<br><label for="authorization">操作授权范围</label><textarea id="authorization" name="authorization" placeholder="例如：填写后让我确认再提交"></textarea></div></div><div class="field"><label for="grant-origin">允许自动执行的网站来源（可选）</label><input id="grant-origin" name="grantOrigin" type="url" placeholder="https://example.com"><small>系统 Chrome 未收紧权限时默认直接执行；以下额度用于其他连接或需要确认的模式。</small><div class="actions"><label><input type="checkbox" name="grantEffect" value="submit">允许提交 / 保存</label><label><input type="checkbox" name="grantEffect" value="send">允许发送</label><label><input type="checkbox" name="grantEffect" value="delete">允许删除</label></div><label>最多自动执行次数</label><input name="grantMax" type="number" min="1" max="500" value="10"><br><br><label for="items">批量项目（每行一项，可留空）</label><textarea id="items" name="items" placeholder="公司 / 岗位 / 链接，或逐项填写要求"></textarea></div><div class="grid-three"><div><label>时间上限（分钟）</label><input name="minutes" type="number" min="1" max="1440" value="30"></div><div><label>操作次数上限</label><input name="actions" type="number" min="1" max="10000" value="200"></div><div><label>主模型估算费用上限（USD）</label><input name="budgetUsd" type="number" min="0.01" max="1000" step="0.01" value="5"></div></div></details>`; }
function composer(): string {
  const shortcut = "Enter";
  return `<div class="compose"><form id="create-task" class="composer task-composer" data-draft-key="${e(draftKey("", "create-task"))}"><div class="compose-scroll" tabindex="-1" aria-label="任务内容"><div class="compose-intro"><h2>${creatingTemplate ? "新建任务模板" : "今天，想完成什么？"}</h2><p>${creatingTemplate ? "填写模板名称和任务内容，保存后即可重复使用。" : "告诉 Agent 你的目标，剩下的一起完成。"}</p></div>
    ${!data.settings.hasApiKey ? '<div class="notice setup-notice"><span>连接模型服务，即可开始第一个任务。</span><button type="button" data-nav="settings" data-focus="model">前往设置 →</button></div>' : ""}
    ${skillForm(formDraft?.skill, data.skills || [])}
    <div class="compose-template-settings" ${creatingTemplate || editTemplate || formDraft?.skill ? "" : "hidden"}>${formExtras("模板设置", creatingTemplate)}</div>
    ${nativeTaskOptions()}
    ${data.tasks.some(task => !TERMINAL_TASKS.has(task.status)) ? `<section class="home-active"><h2>正在进行</h2>${rows(data.tasks.filter(task => !TERMINAL_TASKS.has(task.status)))}</section>` : ""}
    </div><div class="compose-dock"><div class="compose-input-shell"><label for="prompt" class="sr-only">告诉我你想完成什么</label><textarea id="prompt" name="prompt" data-editor-key="${e(draftKey("", "create-task"))}" data-autogrow data-autogrow-min="44" aria-describedby="task-compose-shortcuts" required placeholder="${creatingTemplate ? "描述这个模板要完成的任务…" : "让浏览器帮你完成一件事…"}" rows="1">${e(messageDrafts.get(draftKey("", "create-task")).text)}</textarea><span id="task-compose-shortcuts" class="sr-only">${e(newlineHint)}</span>
      <div id="chosen-files">${selectedFiles.map(id => `<span class="file-chip">${icon("paperclip")}${e(data.attachments.find(file => file.id === id)?.name || id)}<button type="button" data-remove-file="${id}" aria-label="移除附件">×</button></span>`).join("")}</div>
      <div class="compose-toolbar compose-actions"><button type="button" class="icon-button" data-action="attach" title="添加附件" aria-label="添加附件">${icon("paperclip")}</button><div class="browser-picker">${icon("browser")}<select name="profileId" aria-describedby="task-profile-availability" aria-label="任务使用的浏览器" required><option value="">选择浏览器</option>${profileOptions()}</select>${icon("chevron")}</div>${creatingTemplate ? "" : `<button type="button" class="template-button" data-action="save-template" title="${editTemplate ? "更新模板" : "保存为模板"}" aria-label="${editTemplate ? "更新模板" : "保存为模板"}">${icon("bookmark")}<span>${editTemplate ? "更新模板" : "保存模板"}</span></button>`}<div class="model-controls">${modelPicker()}</div><button type="button" class="task-template-trigger" popovertarget="task-template-menu" aria-controls="task-template-menu">任务模板${icon("chevron")}</button>${creatingTemplate ? '<button class="primary save-template-primary" type="button" data-action="save-template">保存模板</button>' : `<button class="primary send-task" type="submit" title="开始任务（${shortcut}）" aria-label="开始任务">${icon("arrow")}</button>`}</div></div>
    ${profileAvailabilityHint("task-profile-availability")}
    </div></form>${taskTemplateMenu(data.skills || [], data.templates)}</div>`;
}
function rows(tasks: BrowserTask[]): string { return tasks.length ? `<div class="task-rows">${tasks.map(task => {
  const hit = search.trim() ? searchSnippet(task, search) : undefined;
  return `<div class="task-list-entry" data-task-row="${e(task.id)}"><button type="button" class="task-row" data-task="${e(task.id)}" data-hit="${e(hit?.id || "")}"><span class="row-icon">${icon(task.archivedAt ? "archive" : task.pinnedAt ? "pin" : "message")}</span><div class="task-row-copy"><strong>${e(task.title)}</strong><small>${e(task.profileName)} · ${date(task.updatedAt)} · ${e(attentionReason(task, readTasks[task.id]))}</small>${hit?.html || ""}</div>${pill(task)}</button>${taskMenuButton(task, "list")}</div>`;
}).join("")}</div>` : '<div class="empty">没有找到任务。<br>可以新建任务，或调整搜索关键词和筛选。</div>'; }
function inspectorToggle(): string {
  const label = inspectorOpen ? "收起浏览器面板" : "查看浏览器";
  return `<button id="task-inspector-toggle" type="button" class="inspector-toggle" data-action="toggle-task-inspector" aria-controls="task-inspector" aria-expanded="${inspectorOpen}" aria-label="${label}" title="${label}">${icon("browser")}<span>浏览器</span></button>`;
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
    const label = inspectorOpen ? "收起浏览器面板" : "查看浏览器";
    button.setAttribute("aria-expanded", String(inspectorOpen));
    button.setAttribute("aria-label", label);
    button.title = label;
  }
  mountTaskPreview();
}
function taskDetail(task: BrowserTask): string {
  return `<header class="thread-heading">${taskSidebarToggle()}<h2 title="${e(task.title)}">${e(task.title)}</h2><span class="pill ${task.status}">${e(statusNames[task.status])}</span><div class="header-actions">${taskQuickControls(task)}${inspectorToggle()}${historyActions()}</div></header>` + workbenchThread(task, { drafts: messageDrafts, attachments: data.attachments, settings: data.settings, hint: newlineHint, status: statusNames[task.status], inspector: inspectorOpen, stream: data.streams?.[task.id], replyError: task.pending ? replyErrors.get(task.pending.id) : undefined });
}

function materials(): string {
  const material = data.materials.find((item) => item.id === editMaterial);
  return `${toolbar("资料与附件", "Personal materials", '<button data-action="memory">长期记忆</button><button data-action="export-materials">导出资料</button>')}<p class="muted">仅在任务中选择后使用。临时回答不会自动保存到这里。</p><div class="grid-two"><form id="material-form" class="panel"><h2>${material ? "编辑资料" : "添加一份资料"}</h2><div class="field"><label for="material-name">名称</label><input id="material-name" name="name" required value="${e(material?.name || "")}" placeholder="求职资料 / 工作账号信息"></div><div class="field"><label for="material-scope">适用范围</label><input id="material-scope" name="scope" value="${e(material?.scope || "")}" placeholder="例如：招聘申请"></div><div class="field"><label for="material-content">资料内容</label><textarea id="material-content" name="content" rows="9" required placeholder="姓名、联系方式、教育经历，或任务需要的具体信息">${e(material?.content || "")}</textarea></div><button class="primary">保存资料</button>${material ? '<button type="button" data-action="clear-material">取消编辑</button>' : ""}</form><div>${data.materials.map((item) => `<section class="panel"><div class="panel-header"><h2>${e(item.name)}</h2><small>v${item.version}</small></div><small>${e(item.scope || "未指定范围")}</small><p class="material-body">${e(item.content)}</p><div class="actions"><button data-edit-material="${item.id}">编辑</button><button data-delete-material="${item.id}" class="danger">删除</button></div></section>`).join("") || '<div class="empty">保存常用资料，让每次填写更省心。</div>'}</div></div><section class="panel"><div class="panel-header"><h2>附件库</h2><button data-action="import-library">＋ 添加附件</button></div>${data.attachments.map((file) => `<div class="item"><div class="task-row-copy">${e(file.name)}<p class="muted">${Math.ceil(file.size / 1024)} KB</p></div><button data-preview-artifact="${file.id}">预览</button><button data-open-file="${file.id}">打开</button><button class="danger" data-delete-file="${file.id}">删除</button></div>`).join("") || '<small>可以保存简历、表格、图片等任务文件。</small>'}</section>`;
}
function templates(): string {
  return `${toolbar("任务模板", "Reusable tasks")}${skillLibrary(data.skills || [], data.skillIssues || [])}<h2 class="saved-templates-heading">我的参数模板</h2><p class="muted">保存常用条件、资料选择和授权范围，下次直接使用。</p>${data.templates.length ? `<div class="grid-two">${data.templates.map(template => `<section class="panel"><h2>${e(template.name)}</h2>${template.task.skill ? `<small>${e(data.skills?.find(skill => skill.id === template.task.skill?.id)?.title || template.task.skill.id)}</small>` : ""}<p>${e(template.task.prompt)}</p><small>${date(template.updatedAt)}</small><div class="actions"><button class="primary" data-use-template="${template.id}">使用 / 编辑</button><button class="danger" data-delete-template="${template.id}">删除</button></div></section>`).join("")}</div>` : '<div class="empty">填写工作流条件后，点击“保存模板”，即可保留这组参数。</div>'}`;
}
function jevSettings(): string {
  const s = data.settings;
  const provider = jevProviderFor(s);
  return `<form id="jev-settings-form" class="panel"><div class="panel-header"><h2>Jev 浏览器执行</h2><span class="pill">${s.jevEnabled ? "已启用" : "未启用"}</span></div>
    <p class="muted">由 Jev 选择点击、填写和滚动，主模型按需提供填写内容、处理复杂任务并核查结果。启用后，任务要求与当前页面文字会发送到 TypeSafe；选择 Vercel 时还会经过其 AI Gateway。</p>
    <div class="field"><label for="jev-mode">运行方式</label><select id="jev-mode" name="jevMode"><option value="driver" ${s.jevMode !== "advisory" ? "selected" : ""}>Jev 优先执行（推荐）</option><option value="advisory" ${s.jevMode === "advisory" ? "selected" : ""}>主模型执行，Jev 辅助判断</option></select><small>两种方式都遵循任务的权限设置和停止指令。</small></div>
    <div class="field"><label for="jev-provider">连接服务</label><select id="jev-provider" name="jevProvider"><option value="typesafe" ${provider === "typesafe" ? "selected" : ""}>TypeSafe 官方直连（Jev API Key）</option><option value="vercel" ${provider === "vercel" ? "selected" : ""}>Vercel AI Gateway</option></select><small>两种服务的密钥分别保存。切换后请先保存，再测试连接或打开控制台。</small></div>
    <div class="field"><label for="jev-api-key">对应服务的 API Key</label><input id="jev-api-key" name="jevApiKey" type="password" autocomplete="new-password" placeholder="输入所选服务的密钥；已保存时可留空"><small>已保存的配置：${provider === "typesafe" ? "TypeSafe / jev-latest" : "Vercel / typesafe-ai/jev"} · ${s.hasJevApiKey ? "密钥已加密保存" : "尚未配置密钥"}</small></div>
    <label><input id="jev-enabled" name="jevEnabled" type="checkbox" ${s.jevEnabled ? "checked" : ""}>启用 Jev</label>
    <p class="muted">每个任务最多判断 100 次；不确定或不可用时由主模型继续。Jev 与文本辅助调用的费用不计入 主模型估算费用上限，实际费用请查看服务商账单。</p>
    <div class="actions"><button class="primary" type="submit">保存 Jev 设置</button><button type="button" data-action="test-jev">测试 Jev 连接</button><button type="button" data-action="clear-jev-key" class="danger">删除 Jev 密钥</button></div>
    <div class="actions"><button type="button" data-action="jev-billing">充值 / 查看余额 ↗</button><button type="button" data-action="jev-keys">创建 API Key ↗</button></div></form>`;
}
function settings(): string { const s = data.settings; return `${toolbar("Agent 设置", "Agent & privacy", '<button class="primary return-agent" data-action="return-agent">← 返回 Agent 对话</button>')}<div class="settings-wrap">${appearanceControls()}<section class="panel"><div class="panel-header"><h2>长期记忆</h2><button type="button" data-action="memory">管理记忆</button></div><p class="muted">同一 Profile 的任务共享稳定偏好和已确认的信息。可按 Profile 停用，或查看、编辑和删除记忆。</p></section>${nativeBrowserSettings(profiles?.profiles || [], data.nativeBrowsers || [], nativePairing, nativeAuthorization, data.nativeInstallations || [])}<form id="settings-form"><section class="panel"><h2>模型服务</h2><p class="muted">使用 API 密钥连接。任务所需的网页、资料和附件信息会发送给你配置的模型服务。</p><div class="field"><label for="model">模型名称</label><input id="model" name="model" value="${e(s.model)}" required></div><div class="field"><label for="baseUrl">API 地址</label><input id="baseUrl" name="baseUrl" value="${e(s.baseUrl)}" required type="url"></div><div class="field"><label for="authMode">鉴权方式</label><select id="authMode" name="authMode"><option value="" ${!s.authMode ? "selected" : ""}>自动选择</option><option value="apiKey" ${s.authMode === "apiKey" ? "selected" : ""}>API Key（x-api-key）</option><option value="bearer" ${s.authMode === "bearer" ? "selected" : ""}>Bearer Token</option></select></div><div class="field"><label for="apiKey">API 密钥 · ${s.hasApiKey ? "已由系统安全存储保护，留空保留" : "尚未配置"}</label><input id="apiKey" name="apiKey" type="password" autocomplete="new-password" placeholder="输入密钥后保存"></div><div class="actions"><button class="primary">保存设置</button><button type="button" data-action="test-connection">测试连接</button><button type="button" data-action="clear-key" class="danger">删除密钥</button></div></section><section class="panel"><h2>运行与记录</h2><div class="grid-two"><div class="field"><label>不同 Profile 的并发任务数</label><input name="maxConcurrent" type="number" min="1" max="6" value="${s.maxConcurrent}"></div><p class="muted">历史会话和产物会保留，直到你显式删除任务。关闭窗口后任务留在后台；退出应用会停止任务服务。</p></div><label><input name="saveScreenshots" type="checkbox" ${s.saveScreenshots ? "checked" : ""}>按需保存页面截图（可能包含个人信息）</label><label><input name="notifications" type="checkbox" ${s.notifications ? "checked" : ""}>需要处理或任务结束时发送桌面通知</label></section></form>${jevSettings()}<section class="panel"><h2>诊断导出</h2><p class="muted">仅导出任务状态、时间、用量及动作类型，不包含密钥、对话、网页内容、个人资料或附件路径。</p><button data-action="export-diagnostics">导出脱敏诊断</button></section></div>`; }
function schedules(): string { return `${toolbar("定时任务", "Schedules")}<div class="notice">仅在本机应用运行时执行。错过计划会标记未执行，不会自动补交。执行时间按所选时区显示。</div><div class="grid-two"><form id="schedule-form" class="panel"><h2>${editSchedule ? "编辑计划" : "安排任务"}</h2><div class="field"><label>任务名称</label><input name="name" required></div><div class="field"><label>操作要求</label><textarea name="prompt" required></textarea></div><div class="field"><label>使用浏览器</label><select name="profileId" aria-describedby="schedule-profile-availability" required><option value="">选择浏览器</option>${profileOptions("", true)}</select>${profileAvailabilityHint("schedule-profile-availability")}</div><div class="field"><label>执行时间（按下方时区）</label><input name="at" type="datetime-local" required></div><div class="grid-two"><div class="field"><label>时区</label><input name="timezone" value="${e(Intl.DateTimeFormat().resolvedOptions().timeZone)}" required></div><div class="field"><label>重复</label><select name="repeat"><option value="once">仅一次</option><option value="daily">每天</option></select></div></div>${formExtras()}<button class="primary">保存计划</button>${editSchedule ? '<button type="button" data-action="clear-schedule">取消编辑</button>' : ""}</form><div>${data.schedules.map((schedule) => `<section class="panel"><div class="panel-header"><h2>${e(schedule.name)}</h2><span class="pill">${schedule.enabled ? "已启用" : "已停用"}</span></div><p>${e(schedule.task.prompt)}</p><p class="muted">${e(new Date(schedule.at).toLocaleString("zh-CN", { timeZone: schedule.timezone }))} · ${e(schedule.timezone)}<br>${schedule.repeat === "daily" ? "每天" : "仅一次"}</p>${schedule.missedAt ? '<p class="notice">错过计划，未执行</p>' : ""}${schedule.lastTaskId ? `<button data-task="${schedule.lastTaskId}">查看上次结果</button>` : ""}<div class="actions"><button data-edit-schedule="${schedule.id}">编辑</button><button data-toggle-schedule="${schedule.id}">${schedule.enabled ? "暂停计划" : "重新启用"}</button><button data-delete-schedule="${schedule.id}" class="danger">删除</button></div></section>`).join("") || '<div class="empty">还没有安排定时任务。</div>'}</div></div>`; }
function updateTaskChat(immediate = false): void {
  const task = data?.tasks.find(item => item.id === selected);
  if (!task || !document.getElementById("task-chat")) { taskChat.dispose(); return; }
  taskChat.update({ task, stream: data.streams?.[task.id], drafts: messageDrafts, attachments: data.attachments, settings: data.settings,
    notify: toast,
    send: async (id, draft, action) => {
      await api.control(id, action, draft.text, { requestId: draft.requestId, attachmentIds: draft.attachments });
      toast(action === "queue" ? "消息已排队，可取回编辑或撤回。" : "消息已收到。");
    }
  }, immediate);
}
function render(preserve = true): void {
  if (!data) return;
  if (composing && preserve) { renderDeferred = true; return; }
  const key = `${view}:${selected}`;
  if (key !== renderedKey) taskChat.dispose();
  preserve = preserve && renderedKey === key;
  if (!preserve) closeTaskTooltip();
  const menuState = preserve ? selects.capture() : undefined;
  const invalidFields = preserve ? [...root.querySelectorAll<HTMLElement>(".field-error")].map(node => node.id.replace(/-error$/, "")) : [];
  renderedKey = key;
  const saved = new Map<string, { value: string; checked: boolean }>();
  const detailsKey = (node: HTMLDetailsElement): string => node.id || node.querySelector("summary")?.textContent || "";
  const openDetails = new Set([...root.querySelectorAll("details")].filter(node => node.open).map(detailsKey));
  const oldWorkspace = root.querySelector<HTMLElement>(".workspace");
  const workspaceScroll = oldWorkspace?.scrollTop || 0;
  const composeScroll = root.querySelector(".compose-scroll")?.scrollTop || 0;
  const sidebarScroll = root.querySelector(".sidebar-recents")?.scrollTop || 0;
  const inspectorScroll = root.querySelector(".thread-inspector")?.scrollTop || 0;
  const sessionSettingsOpen = preserve && !!root.querySelector<HTMLDialogElement>("#task-session-settings")?.open;
  const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const activeEditorKey = active?.getAttribute("data-editor-key");
  const focusId = active?.id; const start = active?.selectionStart; const end = active?.selectionEnd; const direction = active?.selectionDirection;
  const focusName = active?.name; const focusForm = active?.form?.id;
  if (preserve) root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input[name]:not([name=attachment]),textarea[name],select[name]").forEach((input) => saved.set(`${input.form?.dataset.draftKey || input.form?.id}:${input.name}:${input.type === "checkbox" ? input.value : ""}`, { value: input.value, checked: (input as HTMLInputElement).checked }));
  let content = "";
  const task = selected && data.tasks.find((task) => task.id === selected);
  if (task && ["tasks", "history"].includes(view)) content = taskDetail(task);
  else if (view === "tasks") content = `${toolbar("新任务", "任务与浏览器，一处协同", `<span class="workspace-status"><span class="task-status-dot ${data.tasks.some(task => task.status === "running") ? "running" : ""}"></span>${data.tasks.filter(task => task.status === "running").length ? `${data.tasks.filter(task => task.status === "running").length} 个任务运行中` : "准备就绪"}</span>`)}${composer()}`;
  else if (view === "materials") content = materials();
  else if (view === "usage") content = toolbar("Token 消耗", "Usage") + tokenUsagePage(data, usageSource);
  else if (view === "settings") content = settings();
  else if (view === "templates") content = templates();
  else if (view === "schedules") content = schedules();
  else content = `${toolbar(showAttention ? "需要处理与完成未读" : "全部任务", "History")}<div class="history-scopes" role="group" aria-label="任务归档筛选"><button data-task-scope="active" aria-pressed="${historyScope === "active"}">未归档 <span>${data.tasks.filter(task => !task.archivedAt).length}</span></button><button data-task-scope="archived" aria-pressed="${historyScope === "archived"}">已归档 <span>${data.tasks.filter(task => task.archivedAt).length}</span></button></div><div class="topline history-filter"><input id="history-search" class="search" aria-label="搜索任务" placeholder="搜索消息、执行记录、结果与页面证据…" value="${e(search)}"><select id="history-filter" class="search" aria-label="任务状态"><option value="all">所有状态</option>${Object.entries(statusNames).map(([key, label]) => `<option value="${key}" ${filter === key ? "selected" : ""}>${label}</option>`).join("")}</select></div>${historyScope === "archived" ? '<p class="muted archive-description">归档的任务保留记录和结果，可通过“…”菜单移出归档。</p>' : ""}${rows(data.tasks.filter((task) => (historyScope === "archived" ? !!task.archivedAt : !task.archivedAt) && (filter === "all" || task.status === filter) && (!showAttention || !!attentionReason(task, readTasks[task.id])) && (!search.trim() || !!findTaskHit(task, search))).sort((a, b) => (b.archivedAt || b.updatedAt).localeCompare(a.archivedAt || a.updatedAt)))}`;
  taskDom.update(`${workspaceSwitcher("agent")}${workspaceIdentityBar()}<div class="app-frame">${nav()}<main class="workspace ${view === "tasks" && !selected ? "is-home" : selected ? "is-thread" : "is-page"}"><div class="task-operation-status" aria-label="操作状态"></div>${content}</main></div>`, key);
  const sessionDialog = root.querySelector<HTMLDialogElement>("#task-session-settings");
  if (sessionSettingsOpen && sessionDialog && !sessionDialog.open) sessionDialog.showModal();
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
    const scroll = root.querySelector(".compose-scroll"); if (scroll) scroll.scrollTop = composeScroll;
    root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input[name]:not([name=attachment]),textarea[name],select[name]").forEach((input) => { const previous = saved.get(`${input.form?.dataset.draftKey || input.form?.id}:${input.name}:${input.type === "checkbox" ? input.value : ""}`); if (previous) { if (input.value !== previous.value) input.value = previous.value; if (input.type === "checkbox") (input as HTMLInputElement).checked = previous.checked; } });
    root.querySelectorAll("details").forEach(node => { node.open = openDetails.has(detailsKey(node)); });
    const input = (focusId ? document.getElementById(focusId) : [...root.querySelectorAll<HTMLInputElement>("input,textarea,select")].find(node => node.name === focusName && node.form?.id === focusForm)) as HTMLInputElement | undefined;
    if (!activeEditorKey || input?.getAttribute("data-editor-key") === activeEditorKey) input?.focus({ preventScroll: true });
    if (input && (!activeEditorKey || input.getAttribute("data-editor-key") === activeEditorKey) && typeof start === "number" && typeof end === "number") { try { input.setSelectionRange(start, end, direction || undefined); } catch {} }
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
  updateTaskChat(true);
  restoreMessageDrafts();
  taskDom.restore();
  root.querySelectorAll<HTMLLabelElement>("label").forEach(label => {
    if (label.htmlFor || label.querySelector("input,textarea,select")) return;
    const field = label.nextElementSibling;
    if (field?.matches("input,textarea,select")) {
      if (!field.id) field.id = `field-${(field as HTMLInputElement).form?.id || "task"}-${(field as HTMLInputElement).name}`;
      label.htmlFor = field.id;
    }
  });
  updateNativeOptions();
  const theme = root.querySelector<HTMLSelectElement>("#task-theme"), size = root.querySelector<HTMLSelectElement>("#task-font-size");
  if (theme) theme.value = document.documentElement.dataset.taskTheme || "system";
  if (size) size.value = document.documentElement.dataset.taskFontSize || "medium";
  selects.mount(menuState);
  positionTaskTemplateMenu(root);
  for (const id of invalidFields) {
    const field = document.getElementById(id) as HTMLInputElement | null;
    if (field && !field.validity.valid) showFieldError(field, false);
  }
  if (preserve && focusId && !menuState) { const node = document.getElementById(focusId); if (!activeEditorKey || node?.getAttribute("data-editor-key") === activeEditorKey) node?.focus({ preventScroll: true }); }
  refreshWorkspaceSwitcher();
  refreshSidebarWidth();
  root.querySelectorAll<HTMLTextAreaElement>("textarea[data-autogrow]").forEach(autoGrow);
  taskDom.restore();
  restoreSearchTarget();
  updateJumpLatest();
  showPending();
}
function populateTaskForm(form: HTMLFormElement, input: CreateTaskInput): void {
  const nativeTarget = form.elements.namedItem("nativeTarget") as HTMLSelectElement | null;
  if (nativeTarget) nativeTarget.value = input.nativeTarget?.newTab ? "new" : "current";
  const nativeConfirm = form.elements.namedItem("nativeConfirmActions") as HTMLInputElement | null;
  if (nativeConfirm) nativeConfirm.checked = input.nativeAccess?.confirmActions === true;
  const values: Record<string, string | number | undefined> = { prompt: input.prompt, profileId: input.profileId, authorization: input.authorization, items: input.items?.join("\n"), minutes: input.limits?.minutes, actions: input.limits?.actions, budgetUsd: input.limits?.budgetUsd, grantOrigin: input.grant?.origin, grantMax: input.grant?.maxActions };
  for (const [name, value] of Object.entries(values)) { const field = form.elements.namedItem(name) as HTMLInputElement | null; if (field && value !== undefined && !field.hasAttribute("data-editor-key") && field.value !== String(value)) field.value = String(value); }
  form.querySelectorAll<HTMLInputElement>("[name=material],[name=attachment],[name=grantEffect]").forEach(field => {
    const values: string[] = field.name === "material" ? input.materialIds || [] : field.name === "attachment" ? input.attachmentIds || [] : input.grant?.effects || [];
    field.checked = values.includes(field.value);
  });
}
function formInput(form: HTMLFormElement): CreateTaskInput {
  const f = new FormData(form);
  return { skill: skillFromForm(f) || (form.id === "schedule-form" ? data.schedules.find(item => item.id === editSchedule)?.task.skill : undefined), ...nativeTaskInput(f), prompt: String(f.get("prompt") || ""), profileId: String(f.get("profileId") || ""), authorization: String(f.get("authorization") || ""), materialIds: f.getAll("material").map(String), attachmentIds: [...new Set([...selectedFiles, ...f.getAll("attachment").map(String)])],
    grant: f.get("grantOrigin") ? { origin: String(f.get("grantOrigin")), effects: f.getAll("grantEffect").map(String) as Array<"submit" | "send" | "delete">, maxActions: Number(f.get("grantMax")) } : undefined,
    items: String(f.get("items") || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    limits: { minutes: Number(f.get("minutes")), actions: Number(f.get("actions")), budgetUsd: Number(f.get("budgetUsd")) } };
}
function updateNativeOptions(): void {
  const options = root.querySelector<HTMLElement>("#native-task-options");
  if (options) options.hidden = !root.querySelector<HTMLSelectElement>('#create-task [name="profileId"]')?.value.startsWith("native:");
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
    // The Profile picker is visually first, but an empty task description is
    // the first thing to fix when creating a task, regardless of DOM order.
    const prompt = field.form?.id === "create-task" ? field.form.querySelector<HTMLTextAreaElement>("#prompt") : null;
    const focusControl = prompt && !prompt.validity.valid ? prompt : control;
    validationFocusQueued = true;
    queueMicrotask(() => { focusControl.focus(); focusControl.scrollIntoView({ block: "nearest" }); validationFocusQueued = false; });
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
document.addEventListener("click", event => { if ((event.target as Element)?.closest?.(".task-artifact-dialog")) openTaskLink(event, url => api.openLink(url), toast); });
root.addEventListener("auxclick", event => { openTaskLink(event, url => api.openLink(url), toast); });
root.addEventListener("click", async (event) => {
  if (openTaskLink(event, url => api.openLink(url), toast)) return;
  const button = (event.target as Element).closest<HTMLElement>("button,a"); if (!button) return;
  const d = button.dataset;
  if ((button as HTMLButtonElement).disabled) return;
  if (d.action === "commands") { commandMenu(); return; }
  if (d.action === "focus-reply") { focusComposer(true); return; }
  if (d.action === "jump-latest") { jumpLatest(); return; }
  if (d.action === "attention") { rememberForms(); view = "history"; selected = ""; historyScope = "active"; filter = "all"; search = ""; showAttention = true; render(false); return; }
  if (d.action === "mark-unread") { const task = data.tasks.find(task => task.id === selected); if (task) { rememberRead(task, true); render(); } return; }
  if (d.action === "session-settings") { const dialog = root.querySelector<HTMLDialogElement>("#task-session-settings"); if (dialog && !dialog.open) dialog.showModal(); if (d.focus === "session-model") dialog?.querySelector<HTMLInputElement>("#session-model")?.focus(); return; }
  if (d.action === "close-session-settings") { root.querySelector<HTMLDialogElement>("#task-session-settings")?.close(); root.querySelector<HTMLButtonElement>(".composer-settings")?.focus({ preventScroll: true }); return; }
  if (d.action === "retry-load") { void loadSnapshot(); return; }
  if (d.action === "retry-operation") { const error = operations.errors.get(d.operation!); if (error) void operations.run(d.operation!, error.label, error.retry, showPending); return; }
  if (d.action === "dismiss-operation") { operations.errors.delete(d.operation!); showPending(); return; }
  if (d.messageRemove) { const draft = messageDrafts.get(d.draftKey!); messageDrafts.set(d.draftKey!, { attachments: draft.attachments.filter(id => id !== d.messageRemove) }); render(); return; }
  if (d.action === "attach-message") {
    const key = d.draftKey!, id = String(JSON.parse(key)[0]);
    void act(async () => { const files = await api.importAttachments(); const draft = messageDrafts.get(key); messageDrafts.set(key, { attachments: [...new Set([...draft.attachments, ...files.map(file => file.id)])] }); }, false, `task:${id}`, "添加本轮附件"); return;
  }
  if (d.copyCode !== undefined || d.copyMessage || d.editMessage || d.quoteMessage) {
    const task = data.tasks.find(task => task.id === selected);
    const id = d.copyMessage || d.editMessage || d.quoteMessage;
    const text = d.copyCode !== undefined ? button.closest(".task-code-block")?.querySelector("code")?.textContent || "" : id === "prompt" ? task?.prompt || "" : id === "result" ? [task?.result?.summary, ...(task?.result?.evidence || []), ...(task?.result?.remaining || [])].join("\n\n") : task?.events.find(event => event.id === id)?.text || "";
    if (d.editMessage) fillFollowup(text);
    else if (d.quoteMessage) fillFollowup(`> ${text.replace(/\n/g, "\n> ")}\n\n`);
    else void act(async () => { await navigator.clipboard.writeText(text); toast("已复制。"); }, false, "clipboard", "复制文本");
    return;
  }
  if (d.previewArtifact) {
    const id = d.previewArtifact, taskId = selected || undefined;
    void act(async () => { const file = await api.previewArtifact(id, taskId); showArtifact(file, () => { void act(() => api.openArtifact(id, taskId), false, "artifact:open", "打开原文件"); }, text => { if (taskId) fillFollowup(text, [], taskId); }); }, false, "artifact:preview", "读取文件预览"); return;
  }
  if (d.removeQueued || d.editQueued) {
    const id = selected, messageId = d.removeQueued || d.editQueued!;
    const message = data.tasks.find(task => task.id === id)?.messageQueue?.find(message => message.id === messageId);
    void act(async () => { await api.queue(id, messageId); if (d.editQueued && message) fillFollowup(message.message, message.attachmentIds, id); }, false, `task:${id}`, d.editQueued ? "取回排队消息" : "撤回排队消息"); return;
  }
  if (d.revokePermission) { const id = selected; void act(() => api.permissions(id, d.revokePermission), false, `task:${id}`, "撤销会话授权"); return; }
  if (d.action === "export-readable") { const id = selected; void act(async () => { const path = await api.exportData("task-markdown", id); if (path) toast(`已导出：${path}`); }, false, `task:${id}`, "导出可读任务记录"); return; }
  if (d.usageSource && ["all", "model", "jev", "helper"].includes(d.usageSource)) { usageSource = d.usageSource as TokenSource; render(); root.querySelector<HTMLButtonElement>(`[data-usage-source="${usageSource}"]`)?.focus({ preventScroll: true }); return; }
  if (d.action === "preset-deepseek") {
    const form = document.getElementById("settings-form") as HTMLFormElement;
    const set = (name: string, value: string) => { (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value = value; };
    set("baseUrl", "https://api.deepseek.com/anthropic"); set("model", "deepseek-flash"); set("authMode", "bearer"); set("apiKey", "");
    form.dispatchEvent(new Event("input", { bubbles: true }));
    (form.elements.namedItem("apiKey") as HTMLInputElement).focus();
    toast("已填入 DeepSeek 连接设置，请输入密钥后保存。"); return;
  }
  if (d.action === "toggle-task-inspector") { toggleTaskInspector(); return; }
  if (d.taskScope) { historyScope = d.taskScope as "active" | "archived"; render(); return; }
  if (d.restoreTask) { void manageTask(d.restoreTask, "restore"); return; }
  if (d.action === "toggle-sidebar") {
    if (window.innerWidth <= 650) {
      narrowSidebarOpen = !narrowSidebarOpen;
      root.querySelector("#task-sidebar")?.classList.toggle("task-sidebar-visible", narrowSidebarOpen);
      button.setAttribute("aria-expanded", String(narrowSidebarOpen));
      button.setAttribute("aria-label", narrowSidebarOpen ? "收起任务侧栏" : "展开任务侧栏");
      return;
    }
    const collapsed = root.classList.toggle("sidebar-collapsed");
    button.setAttribute("aria-expanded", String(!collapsed));
    button.setAttribute("aria-label", collapsed ? "展开任务侧栏" : "收起任务侧栏");
    button.title = collapsed ? "展开任务侧栏" : "收起任务侧栏";
    try { localStorage.setItem(sidebarPreference, String(collapsed)); } catch { /* The current window still updates. */ }
    window.dispatchEvent(new Event("resize"));
    return;
  }
  if (d.nav) {
    event.preventDefault();
    // Returning to the current view must not redraw the form or discard its draft.
    if (view === d.nav && !selected) { if (d.nav === "tasks") { if (creatingTemplate) { creatingTemplate = false; render(); } document.getElementById("prompt")?.focus(); } return; }
    if (d.nav === "settings") settingsReturn = { view, selected };
    rememberForms();
    const draft = root.querySelector<HTMLFormElement>("#create-task");
    if (draft) formDraft = formInput(draft);
    showAttention = false; view = d.nav; selectedFiles = view === "tasks" ? messageDrafts.get(draftKey("", "create-task")).attachments : pageFiles.get(view) || []; selected = ""; render(false);
    if (d.nav === "tasks" && !d.focus) document.getElementById("prompt")?.focus();
    if (d.focus) { const field = document.getElementById(d.focus); field?.scrollIntoView({ block: "center" }); field?.focus({ preventScroll: true }); }
    return;
  }
  if (d.task) { narrowSidebarOpen = false; openTask(d.task, d.hit, search); return; }
  if (d.example) { const textarea = root.querySelector<HTMLTextAreaElement>("[name=prompt]"); if (textarea) { textarea.value = textarea.value.trim() ? `${textarea.value.trim()}\n\n${d.example}` : d.example; textarea.focus(); autoGrow(textarea); captureMessageDrafts(); } return; }
  if (d.removeFile) { selectedFiles = selectedFiles.filter((id) => id !== d.removeFile); root.querySelectorAll<HTMLInputElement>('[name="attachment"]').forEach(field => { if (field.value === d.removeFile) field.checked = false; }); captureMessageDrafts(); render(); return; }
  if (d.action === "refresh-skills") { void act(async () => { data = await api.snapshot(); toast("工作流已刷新。"); }, false, "skills:refresh", "刷新工作流"); return; }
  if (d.action === "memory") {
    const choices = new Map((profiles?.profiles || []).map(profile => [profile.id, { id: profile.id, name: profile.name }]));
    for (const task of data.tasks) if (!choices.has(task.profileId)) choices.set(task.profileId, { id: task.profileId, name: task.profileName });
    showProfileMemory(api, [...choices.values()], data.tasks.find(task => task.id === selected)?.profileId || formDraft?.profileId);
    return;
  }
  if (d.useSkill) {
    const skill = data.skills?.find(skill => skill.id === d.useSkill); if (!skill) return;
    const profileId = root.querySelector<HTMLSelectElement>('#create-task [name="profileId"]')?.value || formDraft?.profileId || "";
    root.querySelector<HTMLElement>("#task-template-menu")?.hidePopover(); creatingTemplate = false;
    rememberForms(); forgetForm("create-task"); editTemplate = ""; selected = ""; view = "tasks";
    selectedFiles = [];
    formDraft = { prompt: skill.goal, profileId, skill: { id: skill.id, parameters: skillDefaults(skill) } };
    messageDrafts.set(draftKey("", "create-task"), { text: skill.goal, attachments: [] });
    render(false); root.querySelector<HTMLInputElement>(".task-skill-inputs input:not([type=hidden])")?.focus(); return;
  }
  if (d.action === "remove-skill") {
    const form = root.querySelector<HTMLFormElement>("#create-task");
    if (form) { formDraft = formInput(form); formDraft.skill = undefined; rememberForms(); forgetForm("create-task"); render(false); }
    return;
  }
  if (d.useTemplate) { root.querySelector<HTMLElement>("#task-template-menu")?.hidePopover(); creatingTemplate = false; rememberForms(); const template = data.templates.find(item => item.id === d.useTemplate)!; forgetForm("create-task"); formDraft = template.task; messageDrafts.set(draftKey("", "create-task"), { text: template.task.prompt }); editTemplate = template.id; selectedFiles = template.task.attachmentIds || []; messageDrafts.set(draftKey("", "create-task"), { attachments: selectedFiles }); view = "tasks"; selected = ""; render(false); return; }
  if (d.action === "new-template") {
    root.querySelector<HTMLElement>("#task-template-menu")?.hidePopover();
    rememberForms();
    const form = root.querySelector<HTMLFormElement>("#create-task");
    if (form) formDraft = formInput(form);
    selected = ""; view = "tasks"; editTemplate = ""; creatingTemplate = true; forgetForm("create-task");
    render(false);
    root.querySelector<HTMLInputElement>('[name="templateName"]')?.focus();
    return;
  }
  if (d.editMaterial) { forgetForm("material-form"); editMaterial = d.editMaterial; render(false); document.getElementById("material-name")?.focus(); return; }
  if (d.editSchedule) { forgetForm("schedule-form"); editSchedule = d.editSchedule; selectedFiles = data.schedules.find(item => item.id === editSchedule)?.task.attachmentIds || []; render(false); root.querySelector<HTMLInputElement>('#schedule-form [name="name"]')?.focus(); return; }
  if (d.action === "return-agent") { rememberForms(); view = settingsReturn.view === "settings" ? "tasks" : settingsReturn.view; selected = settingsReturn.selected; if (!["tasks", "history"].includes(view)) { view = "tasks"; selected = ""; } selectedFiles = messageDrafts.get(draftKey("", "create-task")).attachments; render(false); root.querySelector<HTMLElement>("#prompt, #answer, #steering")?.focus({ preventScroll: true }); return; }
  if (d.action === "back") { rememberForms(); selected = ""; selectedFiles = messageDrafts.get(draftKey("", "create-task")).attachments; render(false); return; }
  if (d.action === "edit-task") {
    const task = data.tasks.find(task => task.id === selected);
    if (!task) return;
    selected = ""; view = "tasks"; forgetForm("create-task"); editTemplate = "";
    formDraft = { skill: task.skill ? { id: task.skill.id, parameters: task.skill.parameters } : undefined, prompt: [...task.events].reverse().find(event => event.kind === "user")?.text || task.prompt, profileId: task.profileId, nativeTarget: task.nativeTarget, nativeAccess: task.nativeAccess, authorization: task.authorization, materialIds: task.materials.map(item => item.id), attachmentIds: task.attachments.map(item => item.id), items: task.items.map(item => item.label), limits: task.limits };
    messageDrafts.set(draftKey("", "create-task"), { text: formDraft.prompt });
    selectedFiles = [...formDraft.attachmentIds!]; messageDrafts.set(draftKey("", "create-task"), { attachments: selectedFiles }); pageFiles.set("tasks", selectedFiles);
    render(false); document.getElementById("prompt")?.focus(); return;
  }
  if (d.action === "save-template" && !root.querySelector<HTMLFormElement>("#create-task")?.reportValidity()) return;
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
    if (d.outputFile) await api.openArtifact(d.outputFile, targetTask);
    if (d.deleteSchedule) { await api.deleteSchedule(d.deleteSchedule); if (editSchedule === d.deleteSchedule) { forgetForm("schedule-form"); editSchedule = ""; render(false); } toast("定时任务已删除。"); }
    if (d.toggleSchedule) { const schedule = data.schedules.find((item) => item.id === d.toggleSchedule)!; await api.saveSchedule({ ...schedule, enabled: !schedule.enabled }); }
    switch (d.action) {
      case "retry-items": { const ids = [...root.querySelectorAll<HTMLInputElement>("[name=retryItem]:checked")].map(input => input.value); const task = await api.retryItems(targetTask, ids); if (selected === targetTask) { selected = task.id; view = "tasks"; } break; }
      case "save-template": { const form = root.querySelector<HTMLFormElement>("#create-task")!; const task = formInput(form); const name = String(new FormData(form).get("templateName") || task.prompt.slice(0, 48)); const savingDraft = formDraft; const saved = await api.saveTemplate({ id: editTemplate || undefined, name, task }); if (formDraft === savingDraft) { editTemplate = saved.id; formDraft = saved.task; creatingTemplate = false; } toast("模板已保存，可在任务模板中重复使用。"); break; }
      case "save-task-template": { const task = data.tasks.find(task => task.id === targetTask)!; await api.saveTemplate({ name: task.title, task: { skill: task.skill ? { id: task.skill.id, parameters: task.skill.parameters } : undefined, prompt: task.prompt, profileId: task.profileId, nativeTarget: task.nativeTarget, nativeAccess: task.nativeAccess, authorization: task.authorization, materialIds: task.materials.map(item => item.id), attachmentIds: task.attachments.map(item => item.id), items: task.items.map(item => item.label), limits: task.limits, grant: task.grant } }); toast("已保存为任务模板。"); break; }
      case "attach": { const files = await api.importAttachments(); const key = draftKey("", "create-task"); const draft = messageDrafts.get(key); const ids = [...new Set([...draft.attachments, ...files.map(file => file.id)])]; messageDrafts.set(key, { attachments: ids }); pageFiles.set("tasks", ids); if (!selected && view === "tasks") selectedFiles = ids; break; }
      case "import-library": await api.importAttachments(); break;
      case "back": selected = ""; break;
      case "clear-schedule": forgetForm("schedule-form"); editSchedule = ""; selectedFiles = []; render(false); break;
      case "clear-material": forgetForm("material-form"); editMaterial = ""; render(false); break;
      case "focus-browser": await api.focusTaskBrowser(targetTask); break;
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
      case "export-task": { const result = await api.exportData("task", targetTask); if (result) toast(`已导出：${result}`); break; }
      case "export-materials": { const result = await api.exportData("materials"); if (result) toast(`已导出：${result}`); break; }
      case "export-diagnostics": { const result = await api.exportData("diagnostics"); if (result) toast(`已导出脱敏诊断：${result}`); break; }
    }
  }, ["pause", "cancel", "takeover"].includes(d.control || ""), targetTask ? `task:${targetTask}` : `view:${view}`, d.control ? `${({ pause: "暂停任务", resume: "继续任务", cancel: "停止任务", takeover: "接管浏览器" } as Record<string,string>)[d.control] || "更新任务"}` : button.textContent?.trim() || "处理操作");
});
root.addEventListener("toggle", event => {
  if ((event.target as HTMLElement).id === "task-template-menu") positionTaskTemplateMenu(root);
}, true);
window.addEventListener("resize", () => positionTaskTemplateMenu(root));
document.addEventListener("workspace-before-switch", () => root.querySelector<HTMLElement>("#task-template-menu")?.hidePopover());

document.addEventListener("keydown", event => {
  if (!data || event.isComposing || composing || event.keyCode === 229 || document.querySelector("dialog[open]")) return;
  const modifier = /Mac/i.test(navigator.platform) ? event.metaKey : event.ctrlKey;
  if (modifier && event.key.toLowerCase() === "k") { event.preventDefault(); commandMenu(); return; }
  if (modifier && event.shiftKey && event.key.toLowerCase() === "o") { event.preventDefault(); root.querySelector<HTMLButtonElement>('[data-nav="tasks"]')?.click(); return; }
  if (modifier && event.key.toLowerCase() === "f") { event.preventDefault(); rememberForms(); view = "history"; selected = ""; showAttention = false; render(false); document.getElementById("history-search")?.focus(); return; }
  const field = event.target;
  if (!(field instanceof HTMLTextAreaElement) || !field.matches("#prompt,#answer,#steering")) return;
  if (event.key === "/" && !field.value && !modifier) { event.preventDefault(); commandMenu(); return; }
  if (event.key === "ArrowUp" && !field.value && field.id === "steering") {
    const task = data.tasks.find(task => task.id === selected), last = [...(task?.events || [])].reverse().find(item => item.kind === "user");
    if (last || task) { event.preventDefault(); fillFollowup(last?.text || task!.prompt); } return;
  }
  const form = field.form; if (!form || field.disabled || field.readOnly) return;
  const action = messageKeyAction(event, composing, form.dataset.decisionKind === "confirmation");
  if (action === "ignore") return;
  if (action === "newline") {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      // Chromium's native edit command participates in the textarea undo stack.
      if (!document.execCommand("insertText", false, "\n")) { field.setRangeText("\n", field.selectionStart, field.selectionEnd, "end"); field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertLineBreak" })); }
    }
    return;
  }
  event.preventDefault();
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (action === "submit" && submit && !submit.disabled && !operations.running.has(form.dataset.taskId ? `task:${form.dataset.taskId}` : "view:tasks")) form.requestSubmit(submit);
});
function settleMessage(form: HTMLFormElement, key: string, sent: MessageDraft): void {
  captureMessageDrafts(); messageDrafts.acknowledge(key, sent); pageDrafts.delete(key);
  const live = [...root.querySelectorAll<HTMLFormElement>("form[data-draft-key]")].find(item => item.dataset.draftKey === key);
  const field = live?.querySelector<HTMLTextAreaElement>("textarea[data-editor-key]");
  if (field && field.value === sent.text) { field.value = ""; autoGrow(field); }
}
function submitMessage(form: HTMLFormElement, submitter: HTMLElement | null): void {
  captureMessageDrafts();
  const key = messageFormKey(form), id = form.dataset.taskId || "", decisionId = form.dataset.decisionId || "";
  const values = new FormData(form), approve = submitter?.getAttribute("value") !== "reject";
  const task = data.tasks.find(task => task.id === id);
  const action = task && messageDelivery(task, messageDrafts.get(key).mode);
  const scope = values.get("permissionScope") === "session" ? "session" : "once";
  const sent = messageDrafts.prepare(key, `${form.id}:${decisionId}:${approve}:${scope}:${action}`, () => crypto.randomUUID());
  if (form.id !== "reply-task" && !sent.text.trim() && !sent.attachments.length) return;
  const creation = form.id === "create-task" ? formInput(form) : undefined;
  const originView = view, originSelected = selected;
  void act(async () => {
    if (creation) {
      const created = await api.create(creation); settleMessage(form, key, sent);
      pageFiles.delete("tasks"); formDraft = undefined; editTemplate = "";
      if (view === originView && selected === originSelected) { selected = created.id; selectedFiles = []; }
      toast("任务已创建。");
    } else if (form.id === "reply-task") {
      const current = data.tasks.find(task => task.id === id)?.pending;
      if (current && current.id !== decisionId) throw new Error("等待事项已变化；原答复草稿已保留，请检查当前问题后重新提交。");
      await api.reply(id, decisionId, sent.text, approve, { scope, requestId: sent.requestId, attachmentIds: sent.attachments });
      settleMessage(form, key, sent); replyErrors.delete(decisionId); toast(approve ? "答复已确认收到。" : "已拒绝本次操作。");
    } else {
      await api.control(id, action || "queue", sent.text, { requestId: sent.requestId, attachmentIds: sent.attachments });
      settleMessage(form, key, sent); toast(action === "queue" ? "消息已排队，可取回编辑或撤回。" : "消息已收到，正在调整任务。");
    }
  }, false, id ? `task:${id}` : "view:tasks", form.id === "reply-task" ? "发送答复" : "发送消息");
}
root.addEventListener("submit", (event) => {
  if ((event.target as Element).closest("[data-task-chat-owned]")) return;
  event.preventDefault(); const form = event.target as HTMLFormElement; const values = new FormData(form);
  if (form.id === "create-task" && creatingTemplate) { form.querySelector<HTMLButtonElement>(".save-template-primary")?.click(); return; }
  if (["create-task", "reply-task", "steer-task"].includes(form.id)) { submitMessage(form, (event as SubmitEvent).submitter); return; }
  if (form.id === "task-limits-form" || form.id === "task-model-form") {
    const id = form.dataset.taskId!;
    void act(() => form.id === "task-model-form" ? api.setModel(id, String(values.get("model"))) : api.setLimits(id, { minutes: Number(values.get("minutes")), actions: Number(values.get("actions")), budgetUsd: Number(values.get("budgetUsd")) }), false, `task:${id}`, "更新会话设置"); return;
  }
  void act(async () => {
    if (form.id === "material-form") { await api.saveMaterial({ id: editMaterial || undefined, name: String(values.get("name")), scope: String(values.get("scope")), content: String(values.get("content")) }); forgetForm("material-form"); form.reset(); editMaterial = ""; render(false); toast("资料已保存。"); }
    if (form.id === "jev-settings-form") {
      const key = String(values.get("jevApiKey") || "").trim();
      (form.elements.namedItem("jevApiKey") as HTMLInputElement).value = "";
      await api.saveJevSettings({ enabled: values.has("jevEnabled"), provider: String(values.get("jevProvider")) as JevProvider, mode: String(values.get("jevMode")) as "driver" | "advisory", ...(key ? { apiKey: key } : {}) });
      forgetForm("jev-settings-form"); toast("Jev 设置已保存。");
    }
    if (form.id === "settings-form") { await api.saveSettings({ model: String(values.get("model")), baseUrl: String(values.get("baseUrl")), authMode: (String(values.get("authMode") || "") || undefined) as "apiKey" | "bearer" | undefined, apiKey: values.get("apiKey") ? String(values.get("apiKey")) : undefined, maxConcurrent: Number(values.get("maxConcurrent")), saveScreenshots: values.has("saveScreenshots"), notifications: values.has("notifications") }); (form.elements.namedItem("apiKey") as HTMLInputElement).value = ""; modelCatalogs.clear(); forgetForm("settings-form"); toast("设置已保存。"); }
    if (form.id === "schedule-form") { await api.saveSchedule({ id: editSchedule || undefined, name: String(values.get("name")), task: formInput(form), at: zonedLocalToIso(String(values.get("at")), String(values.get("timezone"))), timezone: String(values.get("timezone")), repeat: String(values.get("repeat")) as "once" | "daily", enabled: true }); forgetForm("schedule-form"); pageFiles.delete("schedules"); editSchedule = ""; selectedFiles = []; render(false); toast("计划已保存。"); }

  });
});
root.addEventListener("input", event => { const input = event.target as HTMLInputElement; if (input.id === "history-search") { search = input.value; render(); } if (input.id === "task-sidebar-search") { sidebarSearch = input.value; render(); } if (input instanceof HTMLTextAreaElement && input.hasAttribute("data-autogrow")) { captureMessageDrafts(); autoGrow(input); updateMessageSend(); } });
root.addEventListener("scroll", event => { if ((event.target as HTMLElement)?.matches?.(".workspace")) updateJumpLatest(); }, true);
root.addEventListener("focusin", event => {
  const target = event.target as HTMLElement, row = target.closest<HTMLElement>(".recent-task-row");
  if (!row?.closest(".sidebar-recents")) return;
  // Keep keyboard-focused tasks visible without moving the sidebar on snapshots.
  requestAnimationFrame(() => { if (row.isConnected && document.activeElement === target) row.scrollIntoView({ block: "nearest", inline: "nearest" }); });
});
window.addEventListener("beforeunload", rememberForms);
document.addEventListener("workspace-route", event => {
  const params = new URLSearchParams((event as CustomEvent<string>).detail);
  const taskId = params.get("task");
  if (taskId && data?.tasks.some(task => task.id === taskId)) { openTask(taskId); return; }
  if (params.get("view") === "settings") {
    root.querySelector<HTMLButtonElement>('.sidebar [data-nav="settings"]')?.click();
  }
});
window.addEventListener("resize", () => { root.querySelectorAll<HTMLTextAreaElement>("textarea[data-autogrow]").forEach(autoGrow); const workspace = root.querySelector<HTMLElement>(".workspace"); if (workspace) syncTaskScrollInsets(workspace); updateJumpLatest(); });
const closeTaskTooltip = installTaskTooltips(root);
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
  if (select.dataset.appearance) {
    const theme = select.dataset.appearance === "theme";
    if (!(theme ? ["system", "light", "dark"] : ["small", "medium", "large"]).includes(select.value)) return;
    document.documentElement.dataset[theme ? "taskTheme" : "taskFontSize"] = select.value;
    try { localStorage.setItem(theme ? "profilepilot-workspace-theme" : "profilepilot-task-font-size", select.value); } catch { /* Current appearance still applies. */ }
    root.querySelectorAll<HTMLTextAreaElement>("textarea[data-autogrow]").forEach(autoGrow); const workspace = root.querySelector<HTMLElement>(".workspace"); if (workspace) syncTaskScrollInsets(workspace); return;
  }
  if (select.name === "sendMode" && select.form) { messageDrafts.set(messageFormKey(select.form), { mode: select.value === "steer" ? "steer" : "queue" }); return; }
  if (select.name === "profileId") updateNativeOptions();
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
root.addEventListener("change", (event) => { const input = event.target as HTMLInputElement; if (input.name === "attachment") { selectedFiles = input.checked ? [...new Set([...selectedFiles, input.value])] : selectedFiles.filter(id => id !== input.value); captureMessageDrafts(); render(); } if (input.id === "history-filter") { filter = input.value; render(); } });
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
async function loadSnapshot(): Promise<void> {
  if (!data) root.innerHTML = '<p class="loading" role="status">正在读取工作台…</p>';
  try { data = await api.snapshot(); initialLoadError = ""; render(); if (!selected && view === "tasks") document.getElementById("prompt")?.focus(); }
  catch (error) { initialLoadError = String(error); if (!data) root.innerHTML = `<div class="loading" role="alert">无法打开工作台：${e(initialLoadError)}<button type="button" data-action="retry-load">重新读取</button></div>`; else showPending(); }
}
void loadSnapshot();
void loadProfiles();
api.onChanged((snapshot) => {
  const workspace = root.querySelector<HTMLElement>(".workspace"), old = data?.tasks.find(task => task.id === selected), next = snapshot.tasks.find(task => task.id === selected);
  if (selected && old && next && workspace && !isAtTaskLatest(workspace, 64) && (old.events.length !== next.events.length || old.result?.summary !== next.result?.summary || data.streams?.[selected]?.text !== snapshot.streams?.[selected]?.text)) unseenMessages.add(selected);
  data = snapshot; initialLoadError = ""; if (nativePairing && data.nativeBrowsers?.some(s => s.profileId === nativePairing!.profileId && s.connected)) nativePairing = undefined;
  if (composing) updateTaskChat();
  render(); });
api.onStream?.(update => {
  if (!data) return;
  const task = data.tasks.find(item => item.id === update.taskId);
  if (!task || task.events.some(event => event.streamId === update.stream.id)) return;
  data.streams = { ...data.streams, [update.taskId]: update.stream };
  if (selected !== update.taskId) return;
  const workspace = root.querySelector<HTMLElement>(".workspace");
  if (workspace && !isAtTaskLatest(workspace, 64)) unseenMessages.add(selected);
  updateTaskChat(); updateJumpLatest();
});
window.profileManager.onStateChanged((state) => { profiles = state; render(); });
window.setInterval(() => {
  if (document.hidden || window.workspacePane?.active === false) return;
  const node = root.querySelector("[data-elapsed]"); const task = data?.tasks.find(task => task.id === selected);
  if (node && task) node.textContent = `${elapsed(task)}s`;
  const activity = root.querySelector<HTMLElement>("[data-activity-age]");
  if (activity) activity.textContent = `此步骤已等待 ${Math.max(0, Math.floor((Date.now() - Date.parse(activity.dataset.at!)) / 1000))} 秒`;
}, 1000);
