import type { TaskApi, TaskSnapshot, BrowserTask, TaskStatus, CreateTaskInput, JevProvider } from "../shared/tasks";
import { TERMINAL_TASKS, jevProviderFor } from "../shared/tasks";
import { zonedLocalToIso } from "../shared/task-time";
import type { AppState } from "./types";

declare global { interface Window { tasks: TaskApi; } }
const root = document.getElementById("task-app")!;
const api = window.tasks;
let data: TaskSnapshot;
let profiles: AppState | undefined;
let profilesError = false;
let view = new URLSearchParams(location.search).get("view") || "tasks";
let selected = new URLSearchParams(location.search).get("task") || "";
let search = "";
let filter = "all";
let editMaterial = "";
let editSchedule = "";
let editTemplate = "";
let formDraft: CreateTaskInput | undefined;
let selectedFiles: string[] = [];
let pending = false;
let toastTimer: number;
const statusNames: Record<TaskStatus, string> = { queued: "排队中", running: "执行中", waiting_user: "等待你处理", paused: "已暂停", completed: "已完成", partial: "部分完成", failed: "失败", cancelled: "已取消" };
const itemNames: Record<string, string> = { pending: "待处理", running: "处理中", waiting_user: "待补充", completed: "完成", skipped: "跳过", failed: "失败", uncertain: "结果未确认" };
const e = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const date = (value: string): string => new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const pill = (task: BrowserTask): string => `<span class="pill ${task.status}">${statusNames[task.status]}</span>`;
const elapsed = (task: BrowserTask): number => Math.round((task.usage.elapsedMs + (task.runningSince ? Math.max(0, Date.now() - Date.parse(task.runningSince)) : 0)) / 1000);
function toast(text: string, error = false): void { const node = document.getElementById("task-toast")!; node.textContent = text; node.className = error ? "error" : ""; clearTimeout(toastTimer); toastTimer = window.setTimeout(() => node.textContent = "", 7000); }
async function act(fn: () => Promise<unknown>): Promise<void> { if (pending) return; pending = true; try { await fn(); data = await api.snapshot(); render(); } catch (error) { toast(String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method.*?Error: /, ""), true); } finally { pending = false; } }
function profileOptions(selectedId = ""): string { return profiles ? profiles.profiles.filter((profile) => profile.source === "isolated" && !profile.agentAccessDisabled).map((profile) => `<option value="${e(profile.id)}" ${profile.id === selectedId ? "selected" : ""}>${e(profile.name)}</option>`).join("") : `<option value="" disabled>${profilesError ? "浏览器列表读取失败" : "正在读取浏览器列表…"}</option>`; }
function toolbar(title: string, subtitle: string, extra = ""): string { return `<div class="topline"><div><div class="eyebrow">ProfilePilot / ${e(subtitle)}</div><h1>${e(title)}</h1></div>${extra}</div>`; }
function nav(): string { return `<aside class="sidebar"><a class="brand" href="./tasks.html"><img src="./assets/profilepilot-mark.svg" alt=""><span>ProfilePilot</span></a>${[["tasks", "◈", "任务"], ["materials", "▤", "资料"], ["history", "◷", "历史"], ["templates", "▧", "任务模板"], ["schedules", "◴", "定时任务"], ["settings", "⚙", "设置"]].map(([key, icon, label]) => `<button class="nav-item ${view === key ? "active" : ""}" data-nav="${key}"><span aria-hidden="true">${icon}</span>${label}</button>`).join("")}<a class="nav-item" href="./index.html"><span aria-hidden="true">▣</span>浏览器</a><div class="sidebar-foot">你的浏览器，你的控制权。<br><br>任务与资料保存在本机。</div></aside>`; }
function formExtras(): string { return `<details class="details"><summary>资料、授权、批量项目与运行限制</summary><div class="field"><label>模板名称（保存模板时使用）</label><input name="templateName" placeholder="留空则使用任务描述"></div><div class="grid-two"><div><label>使用已保存的资料</label>${data.materials.length ? data.materials.map((material) => `<label><input type="checkbox" name="material" value="${e(material.id)}">${e(material.name)} · v${material.version}</label>`).join("") : '<small>尚未添加资料，可在“资料”中保存。</small>'}</div><div><label>选择附件库中的文件</label>${data.attachments.map(file => `<label><input type="checkbox" name="attachment" value="${e(file.id)}" ${selectedFiles.includes(file.id) ? "checked" : ""}>${e(file.name)}</label>`).join("") || "<small>可先添加附件。</small>"}<br><label for="authorization">操作授权范围</label><textarea id="authorization" name="authorization" placeholder="例如：填写后让我确认再提交"></textarea></div></div><div class="field"><label for="grant-origin">允许自动执行的网站来源（可选）</label><input id="grant-origin" name="grantOrigin" type="url" placeholder="https://example.com"><small>仅在你明确授权的网站和次数内自动提交，其他操作仍会询问。</small><div class="actions"><label><input type="checkbox" name="grantEffect" value="submit">允许提交 / 保存</label><label><input type="checkbox" name="grantEffect" value="send">允许发送</label><label><input type="checkbox" name="grantEffect" value="delete">允许删除</label></div><label>最多自动执行次数</label><input name="grantMax" type="number" min="1" max="500" value="10"><br><br><label for="items">批量项目（每行一项，可留空）</label><textarea id="items" name="items" placeholder="公司 / 岗位 / 链接，或逐项填写要求"></textarea></div><div class="grid-three"><div><label>时间上限（分钟）</label><input name="minutes" type="number" min="1" max="1440" value="30"></div><div><label>操作次数上限</label><input name="actions" type="number" min="1" max="10000" value="200"></div><div><label>SDK 估算费用上限（USD）</label><input name="budgetUsd" type="number" min="0.01" max="1000" step="0.01" value="5"></div></div></details>`; }
function composer(): string { return `<div class="compose"><div class="compose-intro"><div class="eyebrow">Your browser, ready to work</div><h1>把浏览器里的事情，交给我。</h1><p class="muted">填写表格、整理信息、处理后台工作。<br>使用你自己的账号，过程中随时接管。</p></div>${!data.settings.hasApiKey ? '<div class="notice">开始前需要配置模型服务。<button data-nav="settings">前往设置</button></div>' : ""}<form id="create-task" class="composer"><label for="prompt" class="subheading">告诉我你想完成什么</label><textarea id="prompt" name="prompt" required placeholder="打开公司的招聘官网，用我选择的简历申请岗位，填完后让我检查。"></textarea><div id="chosen-files">${selectedFiles.map((id) => `<span class="file-chip">${e(data.attachments.find((file) => file.id === id)?.name || id)}<button type="button" data-remove-file="${id}" aria-label="移除附件">×</button></span>`).join("")}</div><div class="compose-toolbar"><select name="profileId" aria-label="任务使用的浏览器" required><option value="">选择浏览器</option>${profileOptions()}</select><button type="button" data-action="attach">＋ 附件</button><button type="button" data-action="save-template">${editTemplate ? "更新模板" : "保存模板"}</button><button class="primary" type="submit">开始任务 ↗</button></div>${formExtras()}</form><div class="examples">${[
  ["填写申请", "用已有资料处理多页表单", "帮我打开招聘官网，使用选择的资料和简历填写申请，提交前让我确认。"],
  ["处理后台", "逐项录入，记录完成情况", "把附件表格中的资料逐项录入后台，缺少必填信息时问我，记录每项结果。"],
  ["比较商品", "按条件筛选，整理候选", "帮我比较符合预算和规格的商品，整理价格、规格和链接，购买前让我选择。"]
].map(([title, subtitle, prompt]) => `<button class="example" data-example="${e(prompt)}"><strong>${title} ↗</strong><small>${subtitle}</small></button>`).join("")}</div></div>`; }
function rows(tasks: BrowserTask[]): string { return tasks.length ? `<div class="task-rows">${tasks.map((task) => `<button class="task-row" data-task="${task.id}"><div class="task-row-copy"><strong>${e(task.title)}</strong><small>${e(task.profileName)} · ${date(task.updatedAt)}</small></div>${pill(task)}</button>`).join("")}</div>` : '<div class="empty">这里还没有任务。<br>从一个想完成的浏览器操作开始。</div>'; }
function taskDetail(task: BrowserTask): string {
  const active = !TERMINAL_TASKS.has(task.status);
  return `${toolbar(task.title, "Task workspace", '<button class="back" data-action="back">← 返回任务</button>')}<div class="topline"><div class="actions">${pill(task)}<span class="pill">${e(task.profileName)}</span>${task.needsReconciliation ? '<span class="pill partial">需要核查上次操作</span>' : ""}</div><div class="actions">${active ? `${["running", "queued"].includes(task.status) ? '<button data-control="pause">暂停</button>' : task.pending?.kind !== "confirmation" ? '<button class="primary" data-control="resume">继续任务</button>' : ""}<button data-control="takeover">接管浏览器</button><button class="danger" data-control="cancel">取消</button>` : '<button data-control="rerun">再次执行</button><button data-action="delete-task" class="danger">删除</button>'}<button data-action="save-task-template">保存为模板</button><button data-action="export-task">导出</button></div></div><div class="task-detail"><div><section class="panel"><div class="panel-header"><h2>任务进展</h2><small>${task.usage.actions} 次操作</small></div><div class="event-list" id="events">${task.events.map((event) => `<div class="event ${event.kind}">${e(event.text)}<time>${date(event.at)}</time></div>`).join("")}</div>${active ? '<form id="steer-task"><label for="steering">补充或修改要求</label><textarea name="steering" id="steering" placeholder="例如：只处理上海的岗位，已经完成的保留。"></textarea><div class="actions"><button type="submit">更新要求</button><small>更新时会先停止当前执行</small></div></form>' : ""}</section>${task.pending ? `<form id="reply-task" class="panel decision"><div class="eyebrow">${task.pending.kind === "confirmation" ? "Review before action" : "Your input is needed"}</div><h2>${e(task.pending.title)}</h2><p>${e(task.pending.details)}</p><label for="answer">补充说明或修改要求</label><textarea name="answer" id="answer" placeholder="可以补充信息，或说明需要修改的地方"></textarea><div class="actions"><button class="primary" name="decision" value="approve">${task.pending.kind === "confirmation" ? "确认这次操作" : task.pending.kind === "handoff" ? "交还并继续" : "发送并继续"}</button>${task.pending.kind === "confirmation" ? '<button name="decision" value="reject">不执行，重新处理</button>' : ""}</div></form>` : ""}${task.result ? `<section class="panel result"><div class="eyebrow">Task result</div><h2>${statusNames[task.status]}</h2><p>${e(task.result.summary)}</p>${task.result.evidence.length ? `<h3>页面依据</h3><ul>${task.result.evidence.map((item) => `<li>${e(item)}</li>`).join("")}</ul>` : ""}${task.result.remaining.length ? `<h3>待处理</h3><ul>${task.result.remaining.map((item) => `<li>${e(item)}</li>`).join("")}</ul>` : ""}</section>` : ""}${task.items.length ? `<section class="panel"><div class="panel-header"><h2>逐项结果</h2>${!active && task.items.some(item => item.status !== "completed") ? '<button data-action="retry-items">继续所选项</button>' : ""}</div><div class="item-list">${task.items.map((item) => `<div class="item">${!active && item.status !== "completed" ? `<input type="checkbox" name="retryItem" value="${item.id}" aria-label="继续 ${e(item.label)}">` : ""}<span class="pill">${itemNames[item.status]}</span><div>${e(item.label)}<p class="muted">${e(item.result || "")}</p>${item.evidence ? `<small>依据：${e(item.evidence)}</small>` : ""}</div></div>`).join("")}</div></section>` : ""}</div><aside><section class="panel"><div class="panel-header"><h2>浏览器现场</h2><button data-action="focus-browser">打开窗口 ↗</button></div>${task.observation?.screenshotDataUrl ? `<img class="preview" src="${e(task.observation.screenshotDataUrl)}" alt="任务最近一次观察的页面截图">` : '<div class="preview-placeholder">执行时按需获取页面截图<br>可随时打开真实浏览器查看</div>'}<div class="url">${e(task.observation?.url || "尚未观察页面")}</div><small>${task.observation ? `观察时间：${date(task.observation.at)} · ${e(task.observation.account)}` : "预览是最近一次观察，不是实时画面"}</small></section>${task.plan.length ? `<section class="panel"><h2>执行步骤</h2><ol class="plan">${task.plan.map((step) => `<li>${e(step)}</li>`).join("")}</ol></section>` : ""}${jevProgress(task)}<section class="panel"><h2>运行情况</h2><div class="grid-two"><div><small>累计耗时</small><span class="metric" data-elapsed>${elapsed(task)}s</span></div><div><small>SDK 估算费用</small><span class="metric">$${task.usage.costUsd.toFixed(3)}</span></div></div><p class="muted">上限 ${task.limits.minutes} 分钟 · ${task.limits.actions} 次操作 · $${task.limits.budgetUsd}</p><small>兼容服务的实际账单以服务商为准。</small><br><small>${task.usage.inputTokens} 输入（含缓存） / ${task.usage.outputTokens} 输出 token</small></section>${task.outputs?.length ? `<section class="panel"><h2>下载的文件</h2>${task.outputs.map(file => `<button data-output-file="${file.id}">${e(file.name)} ↗</button>`).join("")}</section>` : ""}<details class="panel"><summary>执行记录与资料版本</summary><p class="muted">${task.materials.map((item) => `${e(item.name)} v${item.version}`).join("、") || "未选择保存的资料"}</p>${task.receipts.map((receipt) => `<p class="muted">${date(receipt.at)} · ${e(receipt.action.summary)}<br>${e(receipt.status)}${receipt.status === "uncertain" ? " · 操作结果未确认" : ""}</p>`).join("")}</details></aside></div>`;
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
    <p class="muted">每个任务最多判断 100 次；不确定或不可用时由主模型继续。Jev 与文本辅助调用的费用不计入 SDK 估算费用上限，实际费用请查看服务商账单。</p>
    <div class="actions"><button class="primary" type="submit">保存 Jev 设置</button><button type="button" data-action="test-jev">测试 Jev 连接</button><button type="button" data-action="clear-jev-key" class="danger">删除 Jev 密钥</button></div>
    <div class="actions"><button type="button" data-action="jev-billing">充值 / 查看余额 ↗</button><button type="button" data-action="jev-keys">创建 API Key ↗</button></div></form>`;
}
function jevProgress(task: BrowserTask): string {
  const decision = task.observation?.jev; const usage = task.usage.jev;
  if (!decision && !usage) return "";
  const pages: Record<string, string> = { login: "登录", captcha: "验证码", form: "表单", records: "记录 / 回执", content: "内容", error: "异常", unknown: "未知" };
  const next: Record<string, string> = { inspect: "继续观察", fill: "准备填写", verify: "核查结果", ask_user: "补充信息", handoff: "人工接管", review: "进一步判断" };
  return `<section class="panel"><h2>Jev 执行记录</h2>${decision?.answers ? `<p>${e(pages[decision.answers.page.choice] || decision.answers.page.choice)} · ${e(next[decision.answers.next.choice] || decision.answers.next.choice)}</p>` : ""}<small>${e(decision?.note || "")}</small>${usage ? `<p class="muted">${usage.calls} 次判断 · ${task.usage.jevActions || 0} 次直接操作 · ${usage.inputTokens} 输入 token<br>平均判断耗时 ${Math.round(usage.elapsedMs / Math.max(1, usage.calls))} ms</p>` : ""}${task.usage.helper ? `<p class="muted">主模型辅助 ${task.usage.helper.calls} 次 · ${task.usage.helper.inputTokens} 输入 / ${task.usage.helper.outputTokens} 输出 token</p>` : ""}<small>实际费用见对应服务商账单。</small></section>`;
}
function settings(): string { const s = data.settings; return `${toolbar("设置", "Agent & privacy")}<div class="settings-wrap"><form id="settings-form"><section class="panel"><h2>模型服务</h2><p class="muted">使用 API 密钥连接。任务所需的网页、资料和附件信息会发送给你配置的模型服务。</p><div class="field"><label for="model">模型名称</label><input id="model" name="model" value="${e(s.model)}" required></div><div class="field"><label for="baseUrl">API 地址</label><input id="baseUrl" name="baseUrl" value="${e(s.baseUrl)}" required type="url"></div><div class="field"><label for="authMode">鉴权方式</label><select id="authMode" name="authMode"><option value="" ${!s.authMode ? "selected" : ""}>自动选择</option><option value="apiKey" ${s.authMode === "apiKey" ? "selected" : ""}>API Key（x-api-key）</option><option value="bearer" ${s.authMode === "bearer" ? "selected" : ""}>Bearer Token</option></select></div><div class="field"><label for="apiKey">API 密钥 · ${s.hasApiKey ? "已由系统安全存储保护，留空保留" : "尚未配置"}</label><input id="apiKey" name="apiKey" type="password" autocomplete="new-password" placeholder="输入密钥后保存"></div><div class="actions"><button class="primary">保存设置</button><button type="button" data-action="test-connection">测试连接</button><button type="button" data-action="clear-key" class="danger">删除密钥</button></div></section><section class="panel"><h2>运行与记录</h2><div class="grid-two"><div class="field"><label>不同 Profile 的并发任务数</label><input name="maxConcurrent" type="number" min="1" max="6" value="${s.maxConcurrent}"></div><div class="field"><label>已结束任务保留天数</label><input name="retentionDays" type="number" min="1" max="3650" value="${s.retentionDays}"></div></div><label><input name="saveScreenshots" type="checkbox" ${s.saveScreenshots ? "checked" : ""}>按需保存页面截图（可能包含个人信息）</label><label><input name="notifications" type="checkbox" ${s.notifications ? "checked" : ""}>需要处理或任务结束时发送桌面通知</label></section></form>${jevSettings()}<section class="panel"><h2>诊断导出</h2><p class="muted">仅导出任务状态、时间、用量及动作类型，不包含密钥、对话、网页内容、个人资料或附件路径。</p><button data-action="export-diagnostics">导出脱敏诊断</button></section></div>`; }
function schedules(): string { return `${toolbar("定时任务", "Schedules")}<div class="notice">仅在本机应用运行时执行。错过计划会标记未执行，不会自动补交。执行时间按所选时区显示。</div><div class="grid-two"><form id="schedule-form" class="panel"><h2>${editSchedule ? "编辑计划" : "安排任务"}</h2><div class="field"><label>任务名称</label><input name="name" required></div><div class="field"><label>操作要求</label><textarea name="prompt" required></textarea></div><div class="field"><label>使用浏览器</label><select name="profileId" required><option value="">选择浏览器</option>${profileOptions()}</select></div><div class="field"><label>执行时间（按下方时区）</label><input name="at" type="datetime-local" required></div><div class="grid-two"><div class="field"><label>时区</label><input name="timezone" value="${e(Intl.DateTimeFormat().resolvedOptions().timeZone)}" required></div><div class="field"><label>重复</label><select name="repeat"><option value="once">仅一次</option><option value="daily">每天</option></select></div></div>${formExtras()}<button class="primary">保存计划</button>${editSchedule ? '<button type="button" data-action="clear-schedule">取消编辑</button>' : ""}</form><div>${data.schedules.map((schedule) => `<section class="panel"><div class="panel-header"><h2>${e(schedule.name)}</h2><span class="pill">${schedule.enabled ? "已启用" : "已停用"}</span></div><p>${e(schedule.task.prompt)}</p><p class="muted">${e(new Date(schedule.at).toLocaleString("zh-CN", { timeZone: schedule.timezone }))} · ${e(schedule.timezone)}<br>${schedule.repeat === "daily" ? "每天" : "仅一次"}</p>${schedule.missedAt ? '<p class="notice">错过计划，未执行</p>' : ""}${schedule.lastTaskId ? `<button data-task="${schedule.lastTaskId}">查看上次结果</button>` : ""}<div class="actions"><button data-edit-schedule="${schedule.id}">编辑</button><button data-toggle-schedule="${schedule.id}">${schedule.enabled ? "暂停计划" : "重新启用"}</button><button data-delete-schedule="${schedule.id}" class="danger">删除</button></div></section>`).join("") || '<div class="empty">还没有安排定时任务。</div>'}</div></div>`; }
function render(preserve = true): void {
  if (!data) return;
  const saved = new Map<string, { value: string; checked: boolean }>();
  const openDetails = [...root.querySelectorAll("details")].map((node) => node.open);
  const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const focusId = active?.id; const start = active?.selectionStart; const end = active?.selectionEnd;
  if (preserve) root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input[name]:not([name=attachment]),textarea[name],select[name]").forEach((input) => saved.set(`${input.form?.id}:${input.name}:${input.type === "checkbox" ? input.value : ""}`, { value: input.value, checked: (input as HTMLInputElement).checked }));
  let content = "";
  const task = selected && data.tasks.find((task) => task.id === selected);
  if (task && ["tasks", "history"].includes(view)) content = taskDetail(task);
  else if (view === "tasks") content = `${toolbar("任务工作台", "Browser assistant", `<span class="pill">${data.tasks.filter((task) => task.status === "running").length} 个任务执行中</span>`)}${composer()}${data.tasks.some((task) => !TERMINAL_TASKS.has(task.status)) ? `<section><h2>正在进行</h2>${rows(data.tasks.filter((task) => !TERMINAL_TASKS.has(task.status)))}</section>` : ""}`;
  else if (view === "materials") content = materials();
  else if (view === "settings") content = settings();
  else if (view === "templates") content = templates();
  else if (view === "schedules") content = schedules();
  else content = `${toolbar("任务历史", "History")}<div class="topline history-filter"><input id="history-search" class="search" aria-label="搜索任务" placeholder="搜索任务、结果、浏览器…" value="${e(search)}"><select id="history-filter" class="search" aria-label="任务状态"><option value="all">所有状态</option>${Object.entries(statusNames).map(([key, label]) => `<option value="${key}" ${filter === key ? "selected" : ""}>${label}</option>`).join("")}</select></div>${rows(data.tasks.filter((task) => (filter === "all" || task.status === filter) && `${task.title} ${task.profileName} ${task.result?.summary || ""}`.toLowerCase().includes(search.toLowerCase())))}`;
  root.innerHTML = `<div class="app-frame">${nav()}<main class="workspace">${content}</main></div>`;
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
    root.querySelectorAll("details").forEach((node, i) => { if (openDetails[i]) node.open = true; });
    if (focusId) { const input = document.getElementById(focusId) as HTMLInputElement; input?.focus(); if (typeof start === "number" && typeof end === "number") { try { input.setSelectionRange(start, end); } catch {} } }
  }
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
root.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLElement>("button,a"); if (!button) return;
  const d = button.dataset;
  if (d.nav) { view = d.nav; selected = ""; render(false); return; }
  if (d.task) { selected = d.task; if (!["tasks", "history"].includes(view)) view = "tasks"; render(false); return; }
  if (d.example) { const textarea = root.querySelector<HTMLTextAreaElement>("[name=prompt]"); if (textarea) { textarea.value = d.example; textarea.focus(); } return; }
  if (d.removeFile) { selectedFiles = selectedFiles.filter((id) => id !== d.removeFile); render(); return; }
  if (d.useTemplate) { const template = data.templates.find(item => item.id === d.useTemplate)!; formDraft = template.task; editTemplate = template.id; selectedFiles = template.task.attachmentIds || []; view = "tasks"; selected = ""; render(false); return; }
  if (d.editMaterial) { editMaterial = d.editMaterial; render(false); return; }
  if (d.editSchedule) { editSchedule = d.editSchedule; selectedFiles = data.schedules.find(item => item.id === editSchedule)?.task.attachmentIds || []; render(false); return; }
  if (!Object.keys(d).some((key) => ["control", "deleteTemplate", "deleteMaterial", "deleteFile", "openFile", "outputFile", "deleteSchedule", "toggleSchedule", "action"].includes(key))) return;
  void act(async () => {
    if (d.control) await api.control(selected, d.control as any);
    if (d.deleteTemplate) { await api.deleteTemplate(d.deleteTemplate); if (editTemplate === d.deleteTemplate) { editTemplate = ""; formDraft = undefined; } }
    if (d.deleteMaterial) await api.deleteMaterial(d.deleteMaterial);
    if (d.deleteFile) await api.deleteAttachment(d.deleteFile);
    if (d.openFile) await api.openArtifact(d.openFile);
    if (d.outputFile) await api.openArtifact(d.outputFile, selected);
    if (d.deleteSchedule) await api.deleteSchedule(d.deleteSchedule);
    if (d.toggleSchedule) { const schedule = data.schedules.find((item) => item.id === d.toggleSchedule)!; await api.saveSchedule({ ...schedule, enabled: !schedule.enabled }); }
    switch (d.action) {
      case "retry-items": { const ids = [...root.querySelectorAll<HTMLInputElement>("[name=retryItem]:checked")].map(input => input.value); const task = await api.retryItems(selected, ids); selected = task.id; view = "tasks"; break; }
      case "save-template": { const form = root.querySelector<HTMLFormElement>("#create-task")!; const task = formInput(form); const name = String(new FormData(form).get("templateName") || task.prompt.slice(0, 48)); const saved = await api.saveTemplate({ id: editTemplate || undefined, name, task }); editTemplate = saved.id; formDraft = saved.task; toast("模板已保存，可在任务模板中重复使用。"); break; }
      case "save-task-template": { const task = data.tasks.find(task => task.id === selected)!; await api.saveTemplate({ name: task.title, task: { prompt: task.prompt, profileId: task.profileId, authorization: task.authorization, materialIds: task.materials.map(item => item.id), attachmentIds: task.attachments.map(item => item.id), items: task.items.map(item => item.label), limits: task.limits, grant: task.grant } }); toast("已保存为任务模板。"); break; }
      case "attach": { const files = await api.importAttachments(); selectedFiles.push(...files.map((file) => file.id)); break; }
      case "import-library": await api.importAttachments(); break;
      case "back": selected = ""; break;
      case "clear-schedule": editSchedule = ""; selectedFiles = []; render(false); break;
      case "clear-material": editMaterial = ""; render(false); break;
      case "focus-browser": await window.profileManager.focusProfile(data.tasks.find((task) => task.id === selected)!.profileId); break;
      case "test-jev": toast("正在测试 Jev 连接…"); toast(await api.testJevConnection()); break;
      case "clear-jev-key": await api.saveJevSettings({ enabled: false, apiKey: "" }); data = await api.snapshot(); render(false); toast("Jev 密钥已删除。"); break;
      case "jev-keys": await api.openJevConsole("keys"); break;
      case "jev-billing": await api.openJevConsole("billing"); break;
      case "test-connection": toast("正在测试模型连接…"); toast(await api.testConnection()); break;
      case "clear-key": await api.saveSettings({ ...data.settings, apiKey: "" }); break;
      case "delete-task": await api.deleteTask(selected); selected = ""; break;
      case "export-task": { const result = await api.exportData("task", selected); if (result) toast(`已导出：${result}`); break; }
      case "export-materials": { const result = await api.exportData("materials"); if (result) toast(`已导出：${result}`); break; }
      case "export-diagnostics": { const result = await api.exportData("diagnostics"); if (result) toast(`已导出脱敏诊断：${result}`); break; }
    }
  });
});
root.addEventListener("submit", (event) => {
  event.preventDefault(); const form = event.target as HTMLFormElement; const values = new FormData(form);
  void act(async () => {
    if (form.id === "create-task") { const task = await api.create(formInput(form)); selected = task.id; selectedFiles = []; formDraft = undefined; editTemplate = ""; }
    if (form.id === "reply-task") { const task = data.tasks.find((task) => task.id === selected)!; const approve = (event as SubmitEvent).submitter?.getAttribute("value") !== "reject"; await api.reply(task.id, task.pending!.id, String(values.get("answer") || ""), approve); }
    if (form.id === "material-form") { await api.saveMaterial({ id: editMaterial || undefined, name: String(values.get("name")), scope: String(values.get("scope")), content: String(values.get("content")) }); editMaterial = ""; toast("资料已保存。"); }
    if (form.id === "jev-settings-form") {
      const key = String(values.get("jevApiKey") || "").trim();
      (form.elements.namedItem("jevApiKey") as HTMLInputElement).value = "";
      await api.saveJevSettings({ enabled: values.has("jevEnabled"), provider: String(values.get("jevProvider")) as JevProvider, mode: String(values.get("jevMode")) as "driver" | "advisory", ...(key ? { apiKey: key } : {}) });
      toast("Jev 设置已保存。");
    }
    if (form.id === "settings-form") { await api.saveSettings({ model: String(values.get("model")), baseUrl: String(values.get("baseUrl")), authMode: (String(values.get("authMode") || "") || undefined) as "apiKey" | "bearer" | undefined, apiKey: values.get("apiKey") ? String(values.get("apiKey")) : undefined, maxConcurrent: Number(values.get("maxConcurrent")), retentionDays: Number(values.get("retentionDays")), saveScreenshots: values.has("saveScreenshots"), notifications: values.has("notifications") }); (form.elements.namedItem("apiKey") as HTMLInputElement).value = ""; toast("设置已保存。"); }
    if (form.id === "schedule-form") { await api.saveSchedule({ id: editSchedule || undefined, name: String(values.get("name")), task: formInput(form), at: zonedLocalToIso(String(values.get("at")), String(values.get("timezone"))), timezone: String(values.get("timezone")), repeat: String(values.get("repeat")) as "once" | "daily", enabled: true }); editSchedule = ""; selectedFiles = []; render(false); toast("计划已保存。"); }
    if (form.id === "steer-task") {
      const text = String(values.get("steering") || "").trim(); if (!text) return;
      const task = data.tasks.find((task) => task.id === selected)!;
      await api.control(task.id, "steer", text);
      toast("补充要求已保存，将用于后续执行。");
    }
  });
});
root.addEventListener("input", (event) => { const input = event.target as HTMLInputElement; if (input.id === "history-search") { search = input.value; render(); } });
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
api.onChanged((snapshot) => { data = snapshot; render(); });
window.profileManager.onStateChanged((state) => { profiles = state; render(); });
window.setInterval(() => {
  const node = root.querySelector("[data-elapsed]"); const task = data?.tasks.find(task => task.id === selected);
  if (node && task) node.textContent = `${elapsed(task)}s`;
}, 1000);
