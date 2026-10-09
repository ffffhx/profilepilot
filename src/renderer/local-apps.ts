import type { LocalAppInput, LocalAppView, LocalAppsApi, LocalAppPreview } from "../shared/local-apps";
import { localAppAvailability, localAppAgentLabel } from "../shared/local-app-presentation";
import { workspaceIdentityBar, workspaceSwitcher, refreshWorkspaceSwitcher } from "./workspace-switcher";
import { taskIcon } from "./task-icons";
import { confirmTaskAction } from "./task-confirm";
import { pcControlTabs } from "./pc-control";
import { workspaceHidden, onWorkspaceVisibilityChanged } from "./workspace-lifecycle";

declare global { interface Window { localApps: LocalAppsApi; } }
const api = window.localApps;
const root = document.getElementById("local-apps")!;
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
let apps: LocalAppView[] = [];
let selected = sessionStorage.getItem("local-app-selected") || "";
let search = "";
let busy = false;
let refreshing = false;
let initialized = false;
let detailKey = "";
let listKey = "";
let messageTimer: number;
let preview: LocalAppPreview | undefined;
let previewKey = "", previewGeneration = 0, previewPending = false, previewAt = 0;
let menuId = "";

root.innerHTML = `${workspaceSwitcher("local-apps")}${workspaceIdentityBar()}
  <div class="pc-apps-shell">
    <header class="app-topbar pc-control-header"><div class="pc-control-brand"><h1>PC 控制</h1><p>管理浏览器与桌面应用</p></div><div class="pc-control-actions"><button data-action="refresh">刷新</button><button class="primary" data-action="add">${taskIcon("plus")}添加应用</button></div></header>
    ${pcControlTabs("local-apps")}
    <main class="pc-apps-layout">
      <section class="pc-apps-registry" aria-labelledby="apps-list-title"><header class="pc-apps-list-head"><div class="app-list-title"><h2 id="apps-list-title">Electron 应用</h2><span class="app-count">0</span></div><label class="app-search-field">${taskIcon("search")}<input class="app-search" type="search" aria-label="搜索应用" placeholder="搜索应用…"></label></header><div class="app-list" aria-label="本地应用列表"><p role="status">正在读取应用…</p></div><footer class="app-list-footer">Agent 操作期间，你可以随时接管或停止。</footer></section>
      <aside class="app-content" aria-label="应用详情" aria-live="off"><p role="status">正在读取本地应用…</p></aside>
    </main>
  </div><div class="app-menu" role="menu" hidden></div>`;
refreshWorkspaceSwitcher();

function message(text: string, error = false): void {
  clearTimeout(messageTimer);
  const element = document.getElementById("app-message")!;
  element.textContent = text; element.hidden = false; element.dataset.error = String(error);
  element.setAttribute("role", error ? "alert" : "status");
  messageTimer = window.setTimeout(() => { element.hidden = true; }, error ? 12_000 : 4000);
}
function status(app: LocalAppView): string {
  return ({ running: "运行中", starting: "启动中", stopping: "停止中", stopped: "未运行", failed: "运行异常", unknown: "待确认" })[app.runtime.status];
}
function appIcon(app: LocalAppView, className: string): string {
  return `<span class="${className}${app.iconUrl ? " has-app-icon" : ""}" aria-hidden="true">${taskIcon("desktop")}${app.iconUrl ? `<img src="${escape(app.iconUrl)}" alt="">` : ""}</span>`;
}
root.addEventListener("error", event => {
  const image = event.target;
  if (image instanceof HTMLImageElement && image.parentElement?.classList.contains("has-app-icon")) {
    image.parentElement.classList.remove("has-app-icon"); image.remove();
  }
}, true);
function primaryAction(app: LocalAppView): { action: string; label: string } {
  if (app.controls.start) return { action: "start", label: "启动" };
  if (localAppAvailability(app).ready) return { action: "show", label: "显示" };
  if (app.mode === "service" || ["starting", "stopping", "unknown"].includes(app.runtime.status)) return { action: "refresh", label: "检查" };
  return { action: "connect", label: "连接" };
}
function agentSummary(app: LocalAppView): string {
  if (app.mode === "service") return '<span class="muted">—</span>';
  if (!app.agent?.sessionId) return '<span class="muted">未被使用</span>';
  return `<span class="app-agent-summary"><strong>${escape(app.agent.name || "Agent")}</strong><small>${localAppAgentLabel(app)}</small></span>`;
}
function appRow(app: LocalAppView): string {
  const available = localAppAvailability(app), primary = primaryAction(app);
  return `<tr data-app-row="${escape(app.id)}" class="${selected === app.id ? "selected" : ""}">
    <td><button class="app-pick" data-select="${escape(app.id)}" aria-current="${selected === app.id}" title="${escape(app.name)}">${appIcon(app, "app-list-icon")}<span class="app-label"><strong>${escape(app.name)}</strong></span></button></td>
    <td><span class="app-state ${app.runtime.status}"><span class="status-dot ${app.runtime.status}" aria-hidden="true"></span>${status(app)}</span></td>
    <td><span class="app-availability${available.ready ? " connected" : ""}">${available.ready ? taskIcon("check") : ""}${available.label}</span></td>
    <td>${agentSummary(app)}</td>
    <td class="app-row-actions"><div><button data-app-id="${escape(app.id)}" data-action="${primary.action}" ${busy ? "disabled" : ""}>${primary.label}</button><button class="app-more" data-app-id="${escape(app.id)}" data-action="more" aria-label="${escape(app.name)}的更多操作" aria-haspopup="menu" aria-expanded="${menuId === app.id}" ${busy ? "disabled" : ""}>⋮</button></div></td>
  </tr>`;
}
function renderPreview(app: LocalAppView): string {
  const ready = localAppAvailability(app).ready;
  const hint = app.mode === "service" ? "后台服务没有应用画面" : !ready ? "连接应用后可查看画面" : preview?.error || "正在获取应用画面…";
  const time = preview?.capturedAt ? new Date(preview.capturedAt).toLocaleTimeString() : "";
  return `<div class="app-preview-head"><h3>应用画面</h3>${ready ? `<button data-action="refresh-preview" aria-label="刷新应用画面" title="刷新画面">${taskIcon("history")}</button>` : ""}</div>${ready && preview?.screenshot ? `<button class="app-preview-screen" data-action="show" aria-label="显示 ${escape(app.name)} 的应用窗口"><img src="${escape(preview.screenshot)}" alt="${escape(preview.title || app.name)}的当前画面"></button><p class="app-preview-caption" title="${escape(preview.title)}">${escape(preview.title)}<small>采集于 ${escape(time)}</small></p>` : `<div class="app-preview-empty">${taskIcon("desktop")}<span>${escape(hint)}</span></div>`}`;
}
function agentDetails(app: LocalAppView): string {
  const available = localAppAvailability(app), agent = app.agent;
  if (agent?.sessionId) return `<h3>当前 Agent</h3><div class="app-agent-person"><span class="app-agent-avatar">${taskIcon("spark")}</span><strong>${escape(agent.name || "Agent")}</strong><span class="status-dot ${agent.ownership === "user" ? "unknown" : "running"}"></span></div>
      <p class="app-agent-context">${agent.targetTitle ? `当前窗口：${escape(agent.targetTitle)}` : "此应用已分配给 Agent 会话。"}</p>
      <p class="app-agent-state" data-agent-status data-connected="${available.ready}">${localAppAgentLabel(app)}</p>
      <div class="agent-session-actions"><button class="primary" data-agent-control="${agent.ownership === "user" ? "return" : "takeover"}" ${busy || !available.ready ? "disabled" : ""}>${agent.ownership === "user" ? "交还 Agent" : "接管应用"}</button><button class="danger" data-agent-control="stop" ${busy ? "disabled" : ""}>停止任务</button></div>`;
  const state = available.ready ? "可供 Agent 操作" : app.mode === "service" ? "不支持界面操作" : app.runtime.status === "stopped" ? "等待应用启动" : "尚未连接 Agent";
  const primary = primaryAction(app);
  return `<h3>当前 Agent</h3><p class="app-agent-state" data-agent-status data-connected="${available.ready}"><span class="status-dot ${available.ready ? "running" : ""}"></span>${state}</p><p class="app-agent-context">${available.note}</p>
    ${!available.ready && app.mode !== "service" ? `<div class="agent-session-actions"><button data-action="${primary.action}" ${busy ? "disabled" : ""}>${primary.label === "启动" ? "启动应用" : primary.label === "连接" ? "连接应用" : "检查状态"}</button></div>` : ""}`;
}
function updatePreviewKey(app?: LocalAppView): void {
  const key = app && localAppAvailability(app).ready ? JSON.stringify([app.id, app.cdpPort, app.agentPort, app.agent?.sessionId, app.agent?.targetId]) : "";
  if (key === previewKey) return;
  previewKey = key; previewGeneration++; previewAt = 0; preview = undefined;
}
async function refreshPreview(force = false): Promise<void> {
  const app = apps.find(item => item.id === selected);
  if (workspaceHidden() || !app || !localAppAvailability(app).ready || previewPending || !force && Date.now() - previewAt < 4000) return;
  const pane = root.querySelector<HTMLElement>(".app-preview");
  if (!force && pane && (pane.getBoundingClientRect().top > innerHeight || pane.getBoundingClientRect().bottom < 0)) return;
  previewPending = true;
  const generation = previewGeneration;
  try {
    const next = await api.preview(app.id);
    if (generation !== previewGeneration || workspaceHidden()) return;
    preview = next; previewAt = Date.now();
    const container = root.querySelector(".app-preview");
    if (container) container.innerHTML = renderPreview(app);
  } catch {
    if (generation !== previewGeneration || workspaceHidden()) return;
    preview = { screenshot: null, title: "", capturedAt: new Date().toISOString(), error: "暂时无法获取画面，请确认应用窗口已打开。" };
    previewAt = Date.now();
    const container = root.querySelector(".app-preview");
    if (container) container.innerHTML = renderPreview(app);
  } finally { previewPending = false; }
}
function render(): void {
  const filtered = apps.filter(app => app.name.toLowerCase().includes(search.toLowerCase()));
  root.querySelector(".app-count")!.textContent = String(apps.length);
  const nextList = JSON.stringify([filtered, selected, busy]);
  if (listKey !== nextList) {
    root.querySelector(".app-list")!.innerHTML = `<table class="pc-apps-table" aria-label="Electron 应用列表"><colgroup><col class="app-col-name"><col class="app-col-status"><col class="app-col-connection"><col class="app-col-agent"><col class="app-col-actions"></colgroup><thead><tr><th scope="col">应用</th><th scope="col">运行状态</th><th scope="col">Agent 可用性</th><th scope="col">当前 Agent</th><th scope="col">操作</th></tr></thead><tbody>${filtered.length ? filtered.map(appRow).join("") : `<tr><td colspan="5" class="app-list-empty">${search ? "没有匹配的应用，试试其他关键词。" : "还没有添加应用，点击右上角「添加应用」开始。"}</td></tr>`}</tbody></table>`;
    listKey = nextList;
  }
  const app = apps.find(item => item.id === selected);
  updatePreviewKey(app);
  const nextDetail = JSON.stringify([app, busy]);
  if (detailKey !== nextDetail) {
    detailKey = nextDetail;
    const content = root.querySelector(".app-content")!;
    content.setAttribute("data-current-app", app?.id || "");
    content.innerHTML = app ? `<header class="detail-heading"><div class="app-identity">${appIcon(app, "app-avatar")}<div><h2>${escape(app.name)}</h2><p>${app.mode === "service" ? "后台服务" : "桌面应用"}</p></div></div></header>
      <section class="app-preview">${renderPreview(app)}</section><section class="app-agent-details">${agentDetails(app)}</section>
      ${app.runtime.status === "failed" ? '<p class="app-status-notice">应用启动或运行异常，可在连接设置中检查启动方式。</p>' : ""}
      ${localAppAvailability(app).ready ? `<button class="app-show-window" data-action="show" ${busy ? "disabled" : ""}>${taskIcon("desktop")}显示应用窗口</button>` : ""}`
      : `<section class="empty-state"><div class="empty-app-icon" aria-hidden="true">${taskIcon("desktop")}</div><h2>添加你的桌面应用</h2><p>从列表选择应用，查看画面和 Agent 状态。</p><button class="primary" data-action="add">${taskIcon("plus")}添加第一个应用</button></section>`;
  }
  refreshWorkspaceSwitcher(); void refreshPreview();
}
async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    if (!initialized) {
      apps = await api.list({ cached: true });
      initialized = true;
      if (!apps.some(app => app.id === selected)) selected = apps[0]?.id || "";
      render();
    }
    const next = await api.list(); apps = next;
    if (!apps.some(app => app.id === selected)) selected = apps[0]?.id || "";
    render();
  } finally { refreshing = false; }
}
async function perform(action: () => Promise<unknown>, success?: string): Promise<void> {
  if (busy) return;
  busy = true; render();
  try { await action(); if (success) message(success); }
  catch (error) { message(errorText(error), true); }
  finally {
    busy = false; await refresh().catch(error => message(errorText(error), true)); render();
  }
}
function errorText(error: unknown): string { return String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""); }

function closeMenu(): void {
  const menu = root.querySelector<HTMLElement>(".app-menu")!;
  menu.hidden = true; menu.replaceChildren(); menuId = "";
  root.querySelectorAll(".app-more").forEach(button => button.setAttribute("aria-expanded", "false"));
}
function openMenu(app: LocalAppView, bounds: DOMRect): void {
  if (menuId === app.id) { closeMenu(); return; }
  menuId = app.id;
  const menu = root.querySelector<HTMLElement>(".app-menu")!;
  menu.innerHTML = `<button role="menuitem" data-action="edit" data-app-id="${app.id}" ${app.managed ? 'disabled title="停止应用后可修改连接设置"' : ""}>连接设置</button>
    ${app.controls.restart ? `<button role="menuitem" data-action="restart" data-app-id="${app.id}">重启应用</button>` : ""}
    ${app.controls.stop ? `<button role="menuitem" data-action="stop" data-app-id="${app.id}">停止应用</button>` : ""}
    <button role="menuitem" class="danger" data-action="remove" data-app-id="${app.id}" ${app.managed ? 'disabled title="停止应用后可移除"' : ""}>移除应用</button>`;
  menu.hidden = false;
  menu.style.left = `${Math.max(8, Math.min(bounds.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(bounds.bottom + 5, innerHeight - menu.offsetHeight - 8))}px`;
  root.querySelector(`[data-app-id="${app.id}"].app-more`)?.setAttribute("aria-expanded", "true");
  menu.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
}
function showConnection(app: LocalAppView): void {
  const dialog = document.createElement("dialog"); dialog.className = "app-connection-dialog";
  dialog.setAttribute("aria-labelledby", "connection-dialog-title");
  dialog.innerHTML = `<h2 id="connection-dialog-title">连接 ${escape(app.name)}</h2><p>请先打开应用，并在连接设置中配置应用的连接方式。连接成功后，Agent 就能查看和操作应用。</p><p class="connection-result" role="status"></p><footer><button data-close>关闭</button><button data-settings ${app.managed ? 'disabled title="停止应用后可修改连接设置"' : ""}>连接设置</button><button class="primary" data-check>检查连接</button></footer>`;
  document.body.append(dialog);
  const close = () => { dialog.close(); dialog.remove(); };
  dialog.querySelector("[data-close]")!.addEventListener("click", close);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.querySelector("[data-settings]")!.addEventListener("click", () => { close(); showForm(app); });
  dialog.querySelector("[data-check]")!.addEventListener("click", async () => {
    const button = dialog.querySelector<HTMLButtonElement>("[data-check]")!; button.disabled = true;
    try { await api.connect(app.id); close(); await refresh(); message("应用已连接，可供 Agent 操作"); }
    catch (error) { const result = dialog.querySelector(".connection-result"); if (result) result.textContent = errorText(error); }
    finally { button.disabled = false; }
  });
  dialog.showModal();
}

root.addEventListener("input", event => {
  if ((event.target as HTMLElement).matches(".app-search")) { search = (event.target as HTMLInputElement).value; render(); }
});
root.addEventListener("click", event => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button");
  if (button?.disabled) return;
  const bounds = button?.getBoundingClientRect();
  const rowId = (event.target as Element).closest<HTMLElement>("[data-app-row]")?.dataset.appRow;
  const selection = button?.dataset.select || button?.dataset.appId || rowId;
  if (selection) {
    selected = selection; sessionStorage.setItem("local-app-selected", selected); render();
  }
  if (!button) return;
  const action = button.dataset.action;
  if (action !== "more") closeMenu();
  if (action === "add") { showForm(); return; }
  if (action === "refresh") { void perform(() => Promise.resolve(), "已检查运行状态"); return; }
  const app = apps.find(item => item.id === selected); if (!app) return;
  if (action === "more") { openMenu(app, bounds!); return; }
  if (action === "connect") { showConnection(app); return; }
  if (action === "show") { void perform(() => api.showWindow(app.id)); return; }
  if (action === "refresh-preview") { void refreshPreview(true); return; }
  if (action === "edit") { showForm(app); return; }
  if (action === "start" || action === "stop" || action === "restart") void perform(() => api[action](app.id));
  if (button.dataset.agentControl) void perform(() => api.agentControl(app.id, button.dataset.agentControl as "takeover" | "return" | "stop"));
  if (action === "remove") void (async () => {
    if (await confirmTaskAction(`移除「${app.name}」？`, "只移除本地应用列表中的配置，项目文件和应用数据会保留。")) await perform(() => api.remove(app.id), "应用已移除");
  })();
});
document.addEventListener("click", event => {
  if (!(event.target as Element).closest(".app-menu, .app-more")) closeMenu();
});
document.addEventListener("scroll", closeMenu, true);
window.addEventListener("resize", closeMenu);
document.addEventListener("keydown", event => {
  if (!menuId) return;
  const menu = root.querySelector<HTMLElement>(".app-menu")!;
  if (event.key === "Escape") {
    const button = root.querySelector<HTMLElement>(`[data-app-id="${menuId}"].app-more`);
    closeMenu(); button?.focus(); event.preventDefault();
  } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    event.preventDefault();
  }
});
onWorkspaceVisibilityChanged(() => {
  closeMenu(); previewGeneration++;
  if (!workspaceHidden()) { previewAt = 0; void refresh().catch(error => message(errorText(error), true)); }
});

function showForm(app?: LocalAppView): void {
  const previous = document.getElementById("local-app-dialog") as HTMLDialogElement | null;
  if (previous?.open) return;
  previous?.remove();
  const origin = document.activeElement as HTMLElement | null;
  const dialog = document.createElement("dialog"); dialog.id = "local-app-dialog"; dialog.setAttribute("aria-labelledby", "app-form-title");
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true; dialog.remove();
    if (origin?.isConnected) origin.focus();
  };
  // Hidden Electron windows can defer the native close event. Retire the form
  // immediately so the next edit cannot find a closed, stale dialog by id.
  const closeDialog = () => { dialog.close(); dispose(); };
  dialog.innerHTML = `<form class="app-form"><h2 id="app-form-title">${app ? "连接设置" : "添加应用"}</h2><p class="form-description">配置应用的启动方式和 Agent 连接。</p>
    <label>应用名称<input name="name" maxlength="100" required placeholder="例如：我的桌面笔记" value="${escape(app?.name)}" autofocus></label>
    <label>管理方式<select name="mode"><option value="launch" ${!app || app.mode === "launch" ? "selected" : ""}>从项目启动</option><option value="attach" ${app?.mode === "attach" ? "selected" : ""}>连接已有应用</option><option value="service" ${app?.mode === "service" ? "selected" : ""}>后台服务（独立启动）</option></select></label>
    <div data-launch-fields><label>项目文件夹<div class="field-row"><input name="cwd" placeholder="选择包含 package.json 的项目文件夹" value="${escape(app?.cwd)}"><button type="button" data-browse>选择…</button></div></label>
    <label><span class="command-label">启动命令<button type="button" data-electron-command>填入 Electron 命令</button></span><textarea name="command" rows="2" spellcheck="false" placeholder="npm run dev">${escape(app?.command || "npm run dev")}</textarea></label><p class="form-hint" data-command-hint></p></div>
    <div data-debug-fields><div class="form-grid"><label>界面调试端口<input name="cdpPort" type="number" min="1024" max="65535" placeholder="例如 9333" value="${app?.cdpPort ?? ""}"></label><label>主进程调试端口<input name="inspectPort" type="number" min="1024" max="65535" placeholder="例如 9230" value="${app?.inspectPort ?? ""}"></label></div>
    <p class="form-hint">端口用于检测连接，不会自动开启调试。启动命令可用 <code>{cdpPort}</code> 和 <code>{inspectPort}</code> 引用这里的端口。</p>
    <label>Agent 连接端口<input name="agentPort" type="number" min="1024" max="65535" placeholder="留空自动分配" value="${app?.agentPort ?? ""}"></label><p class="form-hint">供 agent-browser 使用，必须与界面和主进程调试端口不同。</p></div>
    <div data-service-fields><label>服务端口<input name="servicePort" type="number" min="1024" max="65535" value="${app?.servicePort ?? ""}" placeholder="例如 47632"></label><label>进程识别路径<input name="serviceProcess" value="${escape(app?.serviceProcess)}" placeholder="运行进程中的完整程序或脚本路径"></label><p class="form-hint">匹配进程和监听端口来判断服务状态；不会接管或停止已运行的服务。</p></div>
    <details data-environment><summary>环境变量</summary><label>每行 NAME=value<textarea name="environment" rows="3" spellcheck="false" placeholder="NODE_ENV=development">${escape(app?.environment)}</textarea></label><p class="form-hint">这些值会保存在本机应用配置中。</p></details>
    <details data-debug-help><summary>如何让开发脚本开启调试？</summary><p class="form-hint">直接运行 Electron 可使用上方的命令模板。若使用 electron-vite、Forge 等开发脚本，请通过项目的启动配置开启调试。界面调试也可以在主进程 ready 之前添加：</p><pre>app.commandLine.appendSwitch(
  'remote-debugging-port',
  process.env.PROFILEPILOT_CDP_PORT || '9333'
);</pre><p class="form-hint">主进程需要在 Electron 启动时传入 <code>--inspect=端口</code>。连接已有应用时，填写它实际使用的端口。</p></details>
    <p class="form-error" role="alert" hidden></p><footer class="form-footer"><button type="button" data-cancel>取消</button><button type="submit" class="primary">保存应用</button></footer></form>`;
  document.body.append(dialog);
  const form = dialog.querySelector<HTMLFormElement>("form")!;
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  const modeChanged = () => {
    const launch = field("mode").value !== "attach";
    const service = field("mode").value === "service";
    form.querySelector<HTMLElement>("[data-launch-fields]")!.hidden = !launch;
    form.querySelector<HTMLElement>("[data-environment]")!.hidden = !launch;
    field("cwd").required = launch; field("command").required = launch;
    form.querySelector<HTMLElement>("[data-debug-fields]")!.hidden = service;
    form.querySelector<HTMLElement>("[data-debug-help]")!.hidden = service;
    form.querySelector<HTMLElement>("[data-electron-command]")!.hidden = service;
    form.querySelector<HTMLElement>("[data-service-fields]")!.hidden = !service;
    field("servicePort").required = service; field("serviceProcess").required = service;
    for (const name of ["servicePort", "serviceProcess"]) field(name).disabled = !service;
    for (const name of ["cdpPort", "inspectPort", "agentPort"]) field(name).disabled = service;
    form.querySelector<HTMLElement>("[data-command-hint]")!.textContent = service ? "填写创建独立后台进程后退出的启动命令。" : "使用前台运行的开发命令。Windows 使用 cmd，macOS 使用登录 Shell；可填写 npm、pnpm 或完整可执行文件路径。";
  };
  field("mode").addEventListener("change", modeChanged); modeChanged();
  dialog.querySelector("[data-cancel]")!.addEventListener("click", closeDialog);
  dialog.querySelector("[data-browse]")!.addEventListener("click", () => {
    void api.pickDirectory().then(directory => { if (directory && dialog.isConnected) field("cwd").value = directory; }).catch(error => showError(error));
  });
  dialog.querySelector("[data-electron-command]")!.addEventListener("click", () => {
    field("cdpPort").value ||= "9333"; field("inspectPort").value ||= "9230";
    field("command").value = "npx electron --remote-debugging-port={cdpPort} --inspect={inspectPort} .";
  });
  const showError = (error: unknown) => { const element = form.querySelector<HTMLElement>(".form-error")!; element.hidden = false; element.textContent = errorText(error); };
  form.addEventListener("submit", event => {
    event.preventDefault();
    const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    if (submit.disabled) return;
    const input: LocalAppInput = {
      id: app?.id, name: field("name").value, mode: field("mode").value as LocalAppInput["mode"],
      cwd: field("cwd").value, command: field("command").value, environment: field("environment").value,
      cdpPort: field("cdpPort").value ? Number(field("cdpPort").value) : null,
      agentPort: field("agentPort").value ? Number(field("agentPort").value) : null,
      inspectPort: field("inspectPort").value ? Number(field("inspectPort").value) : null,
      servicePort: field("servicePort").value ? Number(field("servicePort").value) : null,
      serviceProcess: field("serviceProcess").value, logPath: app?.logPath
    };
    submit.disabled = true; submit.textContent = "正在保存…";
    void api.save(input).then(async id => {
      selected = id; sessionStorage.setItem("local-app-selected", id); closeDialog(); await refresh(); message("应用配置已保存");
    }).catch(showError).finally(() => { submit.disabled = false; submit.textContent = "保存应用"; });
  });
  dialog.addEventListener("cancel", event => { event.preventDefault(); closeDialog(); });
  dialog.addEventListener("close", dispose, { once: true });
  dialog.showModal();
}

void refresh().catch(error => {
  if (!initialized) root.querySelector(".app-content")!.innerHTML = '<p class="runtime-error" role="alert">本地应用列表读取失败，请重新打开工作区。</p>';
  message(errorText(error), true);
});
const timer = window.setInterval(() => { if (!document.hidden && window.workspacePane?.active !== false && !busy) void refresh().catch(error => message(errorText(error), true)); }, 2500);
window.addEventListener("beforeunload", () => clearInterval(timer));
