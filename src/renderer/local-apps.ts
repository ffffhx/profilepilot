import type { LocalAppInput, LocalAppView, LocalAppsApi } from "../shared/local-apps";
import { workspaceSwitcher, refreshWorkspaceSwitcher } from "./workspace-switcher";
import { taskIcon } from "./task-icons";
import { confirmTaskAction } from "./task-confirm";

declare global { interface Window { localApps: LocalAppsApi; } }
const api = window.localApps;
const root = document.getElementById("local-apps")!;
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
let apps: LocalAppView[] = [];
let selected = sessionStorage.getItem("local-app-selected") || "";
let search = "";
let busy = false;
let refreshing = false;
let detailKey = "";
let listKey = "";
let messageTimer: number;

root.innerHTML = `<div class="app-shell"><aside class="app-sidebar">${workspaceSwitcher("local-apps")}<p class="sidebar-caption">开发项目与本机后台服务</p><input class="app-search" type="search" aria-label="搜索应用" placeholder="搜索应用"><nav class="app-list" aria-label="本地应用列表"></nav><footer>应用与开发进程集中在这里。<br>浏览器账号仍在「浏览器」工作区。</footer></aside><main class="app-main"><header class="app-topbar"><h1>本地应用</h1><button class="primary" data-action="add">${taskIcon("plus")}添加应用</button></header><div class="app-content" aria-live="off"><p role="status">正在读取本地应用…</p></div></main></div>`;

function message(text: string, error = false): void {
  clearTimeout(messageTimer);
  const element = document.getElementById("app-message")!;
  element.textContent = text; element.hidden = false; element.dataset.error = String(error);
  element.setAttribute("role", error ? "alert" : "status");
  messageTimer = window.setTimeout(() => { element.hidden = true; }, error ? 12_000 : 4000);
}
function status(app: LocalAppView): string {
  if (app.mode === "attach") return app.runtime.status === "running" ? "已连接" : "等待连接";
  return ({ running: "运行中", starting: "启动中", stopping: "停止中", stopped: "已停止", failed: "启动或运行异常" })[app.runtime.status];
}
function active(app: LocalAppView): boolean { return ["running", "starting", "stopping"].includes(app.runtime.status); }
function render(): void {
  const filtered = apps.filter(app => `${app.name} ${app.cwd}`.toLowerCase().includes(search.toLowerCase()));
  const nextList = JSON.stringify([filtered.map(app => [app.id, app.name, app.mode, app.runtime.status]), selected]);
  if (listKey !== nextList) {
    root.querySelector(".app-list")!.innerHTML = filtered.length ? filtered.map(app => `<button data-select="${app.id}" aria-current="${selected === app.id}"><span class="status-dot ${app.runtime.status}" aria-hidden="true"></span><span class="app-label"><strong>${escape(app.name)}</strong><small>${status(app)} · ${{ launch: "项目启动", attach: "连接已有应用", service: "后台服务" }[app.mode]}</small></span></button>`).join("") : `<p>${search ? "没有匹配的应用" : "还没有添加应用"}</p>`;
    listKey = nextList;
  }
  const app = apps.find(item => item.id === selected);
  const nextDetail = JSON.stringify([app, busy]);
  if (detailKey === nextDetail) return;
  detailKey = nextDetail;
  const content = root.querySelector(".app-content")!;
  if (app?.mode === "service") { content.innerHTML = serviceDetails(app); refreshWorkspaceSwitcher(); return; }
  if (!app) {
    content.innerHTML = `<section class="empty-state"><div class="empty-terminal" aria-hidden="true"><div class="terminal-bar">●●●</div><span>›</span> npm run dev<br><span>●</span> Electron ready</div><h2>给本地项目一个入口</h2><p>把正在开发的 Electron 应用放在一起。<br>启动项目，随时进入界面与主进程调试。</p><button class="primary" data-action="add">${taskIcon("plus")}添加第一个应用</button></section>`;
    return;
  }
  const locked = busy ? "disabled" : "";
  const running = active(app);
  content.innerHTML = `<div class="detail-heading"><div><h2>${escape(app.name)}</h2><p>${escape(app.cwd || "通过本机调试端口连接")}</p></div><span class="badge"><span class="status-dot ${app.runtime.status}"></span>${status(app)}</span></div>
    <div class="app-actions">${app.mode === "launch" ? `<button class="primary" data-action="${running ? "restart" : "start"}" ${locked}>${busy ? "正在处理…" : running ? "重启应用" : "启动应用"}</button><button data-action="stop" ${!running || busy ? "disabled" : ""}>停止</button>` : `<button class="primary" data-action="refresh" ${locked}>检查连接</button>`}<button data-action="edit" ${busy || (app.mode === "launch" && running) ? "disabled" : ""} ${app.mode === "launch" && running ? 'title="停止应用后可编辑启动配置"' : ""}>编辑配置</button>${app.cwd ? `<button data-action="folder" ${locked}>${taskIcon("folder")}项目文件夹</button>` : ""}<button class="danger delete-app" data-action="remove" ${busy || (app.mode === "launch" && running) ? "disabled" : ""}>移除</button></div>
    ${app.runtime.error ? `<p class="runtime-error" role="alert">${escape(app.runtime.error)}</p>` : ""}
    ${app.mode === "launch" ? `<pre class="command-line"><span>›</span>${escape(app.command.replaceAll("{cdpPort}", String(app.cdpPort ?? "")).replaceAll("{inspectPort}", String(app.inspectPort ?? "")))}</pre>` : ""}
    <div class="connection-grid">${connection(app, "renderer")}${connection(app, "main")}</div>
    ${agentConnection(app)}
    <section class="app-section"><header class="section-header"><h3>调试目标</h3><small>${app.debug.targets.length} 个已连接</small></header>${app.debug.targets.length ? app.debug.targets.map(target => `<div class="target-row"><div class="target-label"><strong>${escape(target.title)}</strong><small>${target.kind === "main" ? "主进程" : "界面"} · ${escape(target.url)}</small></div><button data-action="debug" data-kind="${target.kind}" data-target="${escape(target.id)}" ${locked}>打开调试器</button></div>`).join("") : `<p class="section-note">${running || app.mode === "attach" ? "等待调试端口就绪。若应用已打开，请确认启动命令或应用代码中已启用远程调试。" : "启动应用后，可在这里选择窗口或主进程进入调试。"}</p>`}</section>
    ${app.mode === "launch" ? '<p class="lifecycle-note">退出 ProfilePilot 后应用继续运行。停止或重启会结束该启动命令及其子进程。</p>' : '<p class="lifecycle-note">此应用由外部管理。移除条目不会停止应用。</p>'}`;
  refreshWorkspaceSwitcher();
}
function agentConnection(app: LocalAppView): string {
  if (!app.cdpPort) return "";
  const agent = app.agent;
  const state = !agent?.connected ? "等待应用连接" : agent.sessionId ? agent.ownership === "user" ? "你正在操作" : "Agent 正在操作" : "可供 Agent 连接";
  const command = app.agentPort ? `agent-browser --cdp ${app.agentPort} snapshot -i` : "";
  return `<section class="app-section agent-connection"><header class="section-header"><h3>Agent 自动化</h3><small data-agent-status>${state}</small></header>
    <p class="section-note">通过受保护的连接操作应用界面，保持后台运行。同一应用只允许一个 Agent 会话，你可以随时接管。</p>
    ${command ? `<div class="agent-command"><code>${command}</code><button data-action="copy-agent" ${busy ? "disabled" : ""}>复制连接命令</button></div>` : '<p class="section-note">正在分配 Agent 连接端口…</p>'}
    ${agent?.error ? `<p class="runtime-error">${escape(agent.error)}</p>` : ""}
    ${agent?.sessionId ? `<p class="section-note">当前会话：${escape(agent.sessionId)}</p><div class="app-actions"><button data-agent-control="${agent.ownership === "user" ? "return" : "takeover"}" ${busy ? "disabled" : ""}>${agent.ownership === "user" ? "交还 Agent" : "接管应用"}</button><button class="danger" data-agent-control="stop" ${busy ? "disabled" : ""}>结束 Agent 会话</button></div>` : ""}
    <small class="section-note">Agent 请使用此连接命令；上方调试地址供手动 DevTools 使用。打开调试器会先接管当前 Agent 会话。</small></section>`;
}
function serviceDetails(app: LocalAppView): string {
  const running = active(app);
  const disabled = busy ? "disabled" : "";
  return `<div class="detail-heading"><div><h2>${escape(app.name)}</h2><p>${escape(app.cwd)}</p></div><span class="badge"><span class="status-dot ${app.runtime.status}"></span>${status(app)}</span></div>
    <div class="app-actions">${running ? `<button class="primary" data-action="refresh" ${disabled}>检查服务状态</button>` : `<button class="primary" data-action="start" ${disabled}>${busy ? "正在启动…" : "启动服务"}</button>`}<button data-action="edit" ${disabled}>编辑配置</button><button data-action="folder" ${disabled}>${taskIcon("folder")}应用文件夹</button><button class="danger delete-app" data-action="remove" ${disabled}>移除</button></div>
    ${app.runtime.error ? `<p class="runtime-error" role="alert">${escape(app.runtime.error)}</p>` : ""}
    <section class="app-section"><header class="section-header"><h3>后台服务</h3><small>${app.runtime.pid ? `PID ${app.runtime.pid}` : "未发现运行进程"}</small></header><div class="target-row"><div class="target-label"><strong>本机服务端口 ${app.servicePort}</strong><small>${escape(app.serviceProcess)}</small></div><span class="badge">${running ? "进程与监听端口已匹配" : "等待服务启动"}</span></div><p class="section-note">服务独立运行，退出 ProfilePilot 后继续工作。需要停止时，请使用应用自己的托盘菜单或服务管理入口。</p></section>
    <pre class="command-line"><span>›</span>${escape(app.command)}</pre>`;
}
function connection(app: LocalAppView, kind: "renderer" | "main"): string {
  const port = kind === "main" ? app.inspectPort : app.cdpPort;
  const connected = app.debug[kind];
  return `<section class="connection"><header><h3>${kind === "main" ? "主进程调试" : "界面调试"}</h3><span class="${connected ? "connected" : ""}">${!port ? "未配置" : connected ? "已连接" : "未连接"}</span></header>${port ? `<button class="copy-endpoint" data-action="copy" data-port="${port}">复制地址</button><code>127.0.0.1:${port}</code>` : "<code>—</code>"}<p>${kind === "main" ? "断点、IPC 与应用逻辑" : "元素、控制台与网络请求"}</p></section>`;
}
async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
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
  finally { busy = false; await refresh().catch(error => message(errorText(error), true)); render(); }
}
function errorText(error: unknown): string { return String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""); }

root.addEventListener("input", event => {
  if ((event.target as HTMLElement).matches(".app-search")) { search = (event.target as HTMLInputElement).value; render(); }
});
root.addEventListener("click", event => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button");
  if (!button || button.disabled) return;
  if (button.dataset.select) {
    selected = button.dataset.select; sessionStorage.setItem("local-app-selected", selected); render();
    return;
  }
  const action = button.dataset.action;
  if (action === "add") { showForm(); return; }
  const app = apps.find(item => item.id === selected); if (!app) return;
  if (action === "edit") { showForm(app); return; }
  if (action === "start" || action === "stop" || action === "restart") void perform(() => api[action](app.id));
  if (action === "refresh") void perform(() => Promise.resolve(), app.mode === "service" ? "已检查服务状态" : "已检查调试连接");
  if (action === "folder") void perform(() => api.openDirectory(app.id));
  if (action === "copy") void navigator.clipboard.writeText(`http://127.0.0.1:${button.dataset.port}`).then(() => message("调试地址已复制"), error => message(errorText(error), true));
  if (action === "debug") void perform(() => api.openDebugger(app.id, button.dataset.kind as "renderer" | "main", button.dataset.target!));
  if (action === "copy-agent" && app.agentPort) void navigator.clipboard.writeText(`agent-browser --cdp ${app.agentPort} snapshot -i`).then(() => message("Agent 连接命令已复制"), error => message(errorText(error), true));
  if (button.dataset.agentControl) void perform(() => api.agentControl(app.id, button.dataset.agentControl as "takeover" | "return" | "stop"));
  if (action === "remove") void (async () => {
    if (await confirmTaskAction(`移除「${app.name}」？`, "只移除本地应用列表中的配置，项目文件和应用数据会保留。")) await perform(() => api.remove(app.id), "应用已移除");
  })();
});

function showForm(app?: LocalAppView): void {
  if (document.getElementById("local-app-dialog")) return;
  const origin = document.activeElement as HTMLElement | null;
  const dialog = document.createElement("dialog"); dialog.id = "local-app-dialog"; dialog.setAttribute("aria-labelledby", "app-form-title");
  dialog.innerHTML = `<form class="app-form"><h2 id="app-form-title">${app ? "编辑应用" : "添加本地应用"}</h2><p class="form-description">保存开发项目或后台服务的启动方式。</p>
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
  dialog.querySelector("[data-cancel]")!.addEventListener("click", () => dialog.close());
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
      selected = id; sessionStorage.setItem("local-app-selected", id); dialog.close(); await refresh(); message("应用配置已保存");
    }).catch(showError).finally(() => { submit.disabled = false; submit.textContent = "保存应用"; });
  });
  dialog.addEventListener("close", () => { dialog.remove(); if (origin?.isConnected) origin.focus(); }, { once: true });
  dialog.showModal();
}

void refresh().catch(error => {
  root.querySelector(".app-content")!.innerHTML = '<p class="runtime-error" role="alert">本地应用列表读取失败，请重新打开工作区。</p>';
  message(errorText(error), true);
});
const timer = window.setInterval(() => { if (!document.hidden && !busy) void refresh().catch(error => message(errorText(error), true)); }, 2500);
window.addEventListener("beforeunload", () => clearInterval(timer));
