import { DEVICE_ONLY_PROFILE_ID, type TaskApi } from "../shared/tasks";
import type { ReviewFeedback, ReviewFinding, ReviewKind, ReviewReport, ReviewSnapshot } from "../shared/review";
import { escapeTaskHtml as e } from "./task-rich-text";

const sourceNames = { trace: "工具调用", profilepilot: "ProfilePilot 任务", codex: "本机 Codex（可选）", claude: "本机 Claude Code（可选）" };
const feedbackNames = { pending: "待处理", accepted: "已采纳", dismissed: "不适用", existing: "已有方案" };
const date = (value: string, timezone: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));

function fallbackWorkflowPrompt(finding: ReviewFinding): string {
  const wf = finding.workflow!;
  return [
    finding.title,
    `适用场景：${wf.when}`,
    wf.inputs.length ? `所需输入：\n${wf.inputs.map(row => `- ${row}`).join("\n")}` : "",
    `执行步骤：\n${wf.steps.map((row, index) => `${index + 1}. ${row}`).join("\n")}`,
    wf.exceptions.length ? `例外处理：\n${wf.exceptions.map(row => `- ${row}`).join("\n")}` : "",
    `完成标准：${wf.done}`
  ].filter(Boolean).join("\n\n");
}

export function mountReviewSettings(container: HTMLElement): void {
  const api = (window as unknown as { tasks: TaskApi }).tasks;
  const section = document.createElement("section");
  section.id = "usage-reviews"; section.setAttribute("aria-labelledby", "review-heading");
  section.innerHTML = `<h2 id="review-heading">使用复盘</h2><div class="setting-card review-panel">
    <div class="setting-row"><div class="setting-copy"><h3 id="review-enabled-label">每日复盘，每周整理</h3><p>从工具记录和对话里发现改进机会，留下可复用的工作流草稿。</p></div>
    <div class="setting-control"><span id="review-enabled-status">读取中…</span><button type="button" id="review-enabled" class="setting-switch" role="switch" aria-checked="false" aria-labelledby="review-enabled-label" disabled></button></div></div>
    <p id="review-model" class="review-muted"></p>
    <details class="review-options"><summary>时间与记录来源</summary><form id="review-settings-form">
      <div class="review-fields"><label>每日时间<input name="time" type="time" required value="21:00"></label><label>时区<input name="timezone" type="text" required maxlength="100" placeholder="Asia/Shanghai"></label>
      <label>每周整理<select name="weeklyDay">${["周日", "周一", "周二", "周三", "周四", "周五", "周六"].map((day, i) => `<option value="${i}">${day}</option>`).join("")}</select></label></div>
      <fieldset><legend>分析这些记录</legend><div class="review-sources">${Object.entries(sourceNames).map(([source, name]) => `<label><input type="checkbox" name="source-${source}" ${["trace", "profilepilot"].includes(source) ? "checked" : ""}>${name}</label>`).join("")}</div></fieldset>
      <p class="review-muted">默认仅分析 ProfilePilot 工具调用与任务记录；本机 Codex 与 Claude Code 会话默认关闭，勾选后才会读取有限片段并经密钥/连接串脱敏后分析。云端聊天、附件和截图不在范围内。</p>
      <button type="submit" class="review-button">保存安排</button>
    </form></details>
    <div class="review-actions"><button type="button" class="review-button" data-review-run="daily">复盘最近一天</button><button type="button" class="review-button" data-review-run="weekly">整理最近一周</button><button type="button" class="review-text-button" id="review-refresh">刷新</button></div>
    <p id="review-notice" role="status" aria-live="polite"></p>
    <div class="review-history" hidden><label for="review-report-select">查看报告</label><select id="review-report-select"></select></div>
    <div id="review-report" aria-live="polite"><p class="review-empty">还没有复盘。可先运行一次，看看这些记录能带来哪些建议。</p></div>
  </div>`;
  container.insertBefore(section, container.children[1] || null);
  const find = <T extends HTMLElement>(selector: string) => section.querySelector<T>(selector)!;
  const form = find<HTMLFormElement>("form");
  const notice = find<HTMLParagraphElement>("#review-notice");
  const reportArea = find<HTMLDivElement>("#review-report");
  const select = find<HTMLSelectElement>("#review-report-select");
  let snapshot: ReviewSnapshot | undefined, report: ReviewReport | undefined, busy = false, dirty = false, loading = false;
  let reportGeneration = 0;
  let renderedReportId = "";
  const noteDrafts = new Map<string, string>();
  const openDetails = new Map<string, boolean>();
  const message = (text: string, error = false) => { notice.textContent = text; notice.dataset.error = String(error); };
  const failure = (error: unknown) => message(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : String(error), true);
  const fields = () => ({ time: (form.elements.namedItem("time") as HTMLInputElement).value, timezone: (form.elements.namedItem("timezone") as HTMLInputElement).value.trim(),
    weeklyDay: Number((form.elements.namedItem("weeklyDay") as HTMLSelectElement).value),
    sources: Object.fromEntries(Object.keys(sourceNames).map(source => [source, (form.elements.namedItem(`source-${source}`) as HTMLInputElement).checked])) as ReviewSnapshot["settings"]["sources"] });
  function drawState(): void {
    if (!snapshot) return;
    const enabled = snapshot.settings.enabled;
    find("#review-enabled").setAttribute("aria-checked", String(enabled));
    find("#review-enabled-status").textContent = enabled ? "已开启" : "已关闭";
    find("#review-model").textContent = snapshot.configured ? `使用 Agent 模型 ${snapshot.model}。分析会产生模型用量；建议和草稿保存在本机。` : "尚未配置模型：请在 Agent 的模型设置中配置服务和密钥，再运行复盘。";
    if (!dirty) {
      for (const key of ["time", "timezone", "weeklyDay"] as const) (form.elements.namedItem(key) as HTMLInputElement).value = String(snapshot.settings[key]);
      for (const key of Object.keys(sourceNames) as Array<keyof typeof sourceNames>) (form.elements.namedItem(`source-${key}`) as HTMLInputElement).checked = snapshot.settings.sources[key];
    }
    section.querySelectorAll<HTMLButtonElement>("#review-enabled, [data-review-run], form button, [data-review-feedback], [data-review-export], [data-review-template]").forEach(button => { button.disabled = busy || snapshot!.running; });
    find<HTMLElement>(".review-history").hidden = !snapshot.reports.length;
    const selected = select.value || report?.id || snapshot.reports[0]?.id;
    select.innerHTML = snapshot.reports.map(row => `<option value="${e(row.id)}">${row.kind === "daily" ? "每日复盘" : "每周整理"} · ${e(date(row.until, snapshot!.settings.timezone))}${row.status === "running" ? " · 进行中" : row.status === "failed" ? " · 未完成" : ""}</option>`).join("");
    if (snapshot.reports.some(row => row.id === selected)) select.value = selected!;
    if (snapshot.error && !busy) message(snapshot.error, true);
  }
  function drawReport(): void {
    if (!report || !snapshot) return;
    if (renderedReportId) {
      reportArea.querySelectorAll<HTMLInputElement>("[data-feedback-note]").forEach(input => noteDrafts.set(`${renderedReportId}:${input.dataset.feedbackNote}`, input.value));
      reportArea.querySelectorAll<HTMLDetailsElement>("details[data-detail]").forEach(detail => openDetails.set(`${renderedReportId}:${detail.dataset.detail}`, detail.open));
    }
    renderedReportId = report.id;
    if (report.status !== "complete") {
      reportArea.innerHTML = `<p class="review-empty">${e(report.summary)}</p>`; return;
    }
    const timezone = snapshot.settings.timezone;
    reportArea.innerHTML = `<article><header class="review-report-header"><h3>${report.kind === "daily" ? "每日复盘" : "每周整理"}</h3><p>${e(date(report.from, timezone))} — ${e(date(report.until, timezone))} · ${e(timezone)}</p></header>
      <p class="review-summary">${e(report.summary)}</p>
      <details class="review-coverage" data-detail="coverage"><summary>记录范围与局限</summary><ul>${report.coverage.map(row => `<li><strong>${sourceNames[row.source]}</strong> · ${row.records} 条记录，${row.sessions} 个关联会话${row.partial ? " · 部分覆盖" : ""}<p>${e(row.note)}</p></li>`).join("")}</ul>
      ${report.usage ? `<p class="review-muted">本次模型用量：输入 ${report.usage.inputTokens.toLocaleString()}，输出 ${report.usage.outputTokens.toLocaleString()} tokens（已计入 Agent → Token 消耗）。</p>` : ""}</details>
      ${report.suppressed ? `<p class="review-muted">已合并或省略 ${report.suppressed} 条重复、已处理的建议。</p>` : ""}
      ${report.findings.length ? report.findings.map(finding => {
        const feedback = snapshot!.feedback.find(item => item.key === finding.key), status = feedback?.value || "pending";
        const workflow = finding.workflow;
        return `<section class="review-finding" data-finding="${e(finding.id)}"><h4>${e(finding.title)}</h4><p class="review-muted">${finding.kind === "tool" ? "工具建议" : "工作流候选"} · ${finding.confidence === "high" ? "证据较充分" : finding.confidence === "medium" ? "待继续验证" : "初步发现"} · ${feedbackNames[status]}</p>
          <dl><dt>观察</dt><dd>${e(finding.observation)}</dd><dt>建议</dt><dd>${e(finding.suggestion)}</dd><dt>验证</dt><dd>${e(finding.verification)}</dd></dl>
          ${workflow ? `<details data-detail="workflow-${e(finding.id)}"><summary>查看工作流草稿</summary><p><strong>适用场景：</strong>${e(workflow.when)}</p><p><strong>输入：</strong>${e(workflow.inputs.join("；"))}</p><ol>${workflow.steps.map(step => `<li>${e(step)}</li>`).join("")}</ol><p><strong>例外：</strong>${e(workflow.exceptions.join("；") || "尚待补充")}</p><p><strong>完成标准：</strong>${e(workflow.done)}</p><div class="review-actions"><button type="button" class="review-button" data-review-export="${e(finding.id)}">保存工作流草稿</button><button type="button" class="review-button" data-review-template="${e(finding.id)}">保存为任务模板</button></div><p class="review-muted">可保存为本地 Markdown 文档，或一键转为可复用的 Agent 任务模板。</p></details>` : ""}
          <details data-detail="evidence-${e(finding.id)}"><summary>查看 ${finding.evidenceIds.length} 条来源记录</summary>${report!.evidence.filter(row => finding.evidenceIds.includes(row.id)).map(row => `<blockquote><p>${e(row.text)}</p><footer>${e(sourceNames[row.source])} · ${e(date(row.at, timezone))}<br>${e(row.location)}</footer></blockquote>`).join("")}</details>
          <label class="review-feedback-note">反馈备注（可选）<input type="text" maxlength="1000" data-feedback-note="${e(finding.id)}" value="${e(noteDrafts.get(`${report!.id}:${finding.id}`) ?? feedback?.note ?? "")}" placeholder="例如：已有处理方案，或下次验证的结果"></label>
          <div class="review-feedback" role="group" aria-label="对建议的反馈">${(["accepted", "dismissed", "existing", "pending"] as const).map(value => `<button type="button" class="review-button" data-review-feedback="${value}" data-finding-id="${e(finding.id)}" aria-pressed="${status === value}">${value === "accepted" ? "采纳" : value === "pending" ? "待处理" : feedbackNames[value]}</button>`).join("")}</div></section>`;
      }).join("") : '<p class="review-empty">没有新增建议。已有反馈会用于后续整理，无需为了日报凑出改动。</p>'}</article>`;
    reportArea.querySelectorAll<HTMLDetailsElement>("details[data-detail]").forEach(detail => { detail.open = openDetails.get(`${report!.id}:${detail.dataset.detail}`) || false; });
    drawState();
  }
  async function loadReport(id: string): Promise<void> {
    if (!id) return;
    const generation = ++reportGeneration;
    const next = await api.reviewReport(id);
    if (generation !== reportGeneration) return;
    report = next; drawReport();
  }
  async function refresh(): Promise<void> {
    if (loading || busy) return;
    loading = true;
    try {
      const wasRunning = snapshot?.running;
      snapshot = await api.reviewSnapshot(); drawState();
      if (!report || report.status !== "complete" || wasRunning && !snapshot.running) await loadReport(select.value);
    } catch (error) { failure(error); }
    finally { loading = false; }
  }
  async function perform(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    const focused = document.activeElement as HTMLElement | null;
    const focusSelector = focused?.dataset.reviewFeedback ? `[data-review-feedback="${focused.dataset.reviewFeedback}"][data-finding-id="${focused.dataset.findingId}"]`
      : focused?.dataset.reviewExport ? `[data-review-export="${focused.dataset.reviewExport}"]`
      : focused?.dataset.reviewTemplate ? `[data-review-template="${focused.dataset.reviewTemplate}"]`
        : focused?.dataset.feedbackNote ? `[data-feedback-note="${focused.dataset.feedbackNote}"]` : undefined;
    const selection = focused instanceof HTMLInputElement ? [focused.selectionStart, focused.selectionEnd] : undefined;
    busy = true; drawState();
    try { await action(); } catch (error) { failure(error); }
    finally {
      busy = false; drawState();
      // Do not steal focus if the user moved to another field while waiting.
      if (document.activeElement === document.body || document.activeElement === focused || !document.activeElement) {
        const next = focusSelector ? section.querySelector<HTMLElement>(focusSelector) : focused?.isConnected ? focused : null;
        next?.focus({ preventScroll: true });
        if (next instanceof HTMLInputElement && selection?.[0] != null && selection[1] != null) next.setSelectionRange(selection[0], selection[1]);
      }
    }
  }
  form.addEventListener("input", () => { dirty = true; });
  form.addEventListener("submit", event => {
    event.preventDefault(); void perform(async () => { snapshot = await api.reviewConfigure(fields()); dirty = false; message("复盘安排已保存。"); });
  });
  find("#review-enabled").addEventListener("click", () => void perform(async () => {
    if (!snapshot) return;
    snapshot = await api.reviewConfigure({ ...fields(), enabled: !snapshot.settings.enabled }); dirty = false;
    message(snapshot.settings.enabled ? "已开启自动复盘。到期时在后台运行，错过后会在下次启动补跑。" : "已关闭自动复盘，已有报告仍可查看。");
  }));
  find("#review-refresh").addEventListener("click", () => { message(""); void refresh(); });
  select.addEventListener("change", () => { void loadReport(select.value).catch(failure); });
  section.addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button"); if (!button) return;
    if (button.dataset.reviewRun) void perform(async () => {
      message("正在整理记录并分析，通常需要一两分钟…");
      report = await api.reviewRun(button.dataset.reviewRun as ReviewKind);
      snapshot = await api.reviewSnapshot(); select.value = ""; drawState(); select.value = report.id; drawReport();
      message("复盘已完成。");
    });
    if (button.dataset.reviewFeedback && report) void perform(async () => {
      const id = button.dataset.findingId!;
      const note = find<HTMLInputElement>(`[data-feedback-note="${id}"]`).value;
      snapshot = await api.reviewFeedback(report!.id, id, button.dataset.reviewFeedback as ReviewFeedback, note); drawReport();
      message("反馈已保存，下次复盘会参考。采纳建议不会自动修改代码或指引。");
    });
    if (button.dataset.reviewExport && report) void perform(async () => {
      const exported = await api.reviewExportWorkflow(report!.id, button.dataset.reviewExport!);
      message(`工作流草稿已保存：${exported.path}`);
    });
    if (button.dataset.reviewTemplate && report) void perform(async () => {
      const findingId = button.dataset.reviewTemplate!;
      const finding = report!.findings.find(item => item.id === findingId);
      if (!finding?.workflow) throw new Error("该建议没有工作流草稿。");
      const saveReviewTemplate = api.reviewSaveWorkflowTemplate || api.reviewSaveAsTemplate;
      const saved = typeof saveReviewTemplate === "function"
        ? await saveReviewTemplate.call(api, report!.id, findingId)
        : await api.saveTemplate({ name: finding.title.slice(0, 100), task: { prompt: fallbackWorkflowPrompt(finding), profileId: DEVICE_ONLY_PROFILE_ID } });
      message(`已保存为任务模板「${saved.name}」，可在 Agent → 任务模板中直接使用。`);
    });
  });
  const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
  void refresh();
}
