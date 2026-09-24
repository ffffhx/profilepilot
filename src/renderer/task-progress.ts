import type { BrowserTask, TaskSettings } from "../shared/tasks";
import { modelLabel, taskModelLabel, taskModelText } from "../shared/task-model";

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const number = (value: number): string => new Intl.NumberFormat("zh-CN").format(value);
const seconds = (value: number): string => `${(value / 1000).toFixed(1)} 秒`;
const names: Record<string, string> = { CLICK: "点击", TYPE_TEXT: "填写", SELECT: "选择", SCROLL_UP: "向上滚动", SCROLL_DOWN: "向下滚动", SCROLL_LEFT: "向左滚动", SCROLL_RIGHT: "向右滚动", WAIT: "等待页面", DONE: "核查完成情况", BLOCKED: "需要人工处理", REVIEW: "转交主模型", ready: "提供判断建议", uncertain: "判断不确定", unavailable: "服务不可用" };

export function renderJevProgress(task: BrowserTask): string {
  const copy = (value: string): string => escape(taskModelText(task, value));
  const usage = task.usage.jev; const decisions = task.jevDecisions || [];
  if (!usage && !task.observation?.jev) return "";
  const completed = usage?.completedCalls ?? usage?.calls ?? 0;
  const last = decisions.at(-1);
  const explanation = task.execution?.reason || last?.note || task.observation?.jev?.note;
  const metric = (label: string, value: string): string => `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`;
  return `<section class="panel jev-progress"><div class="panel-header"><h2>Jev 决策概览</h2>${last?.status === "running" ? '<span class="pill">判断中</span>' : ""}</div>
    ${explanation ? `<p class="decision-explanation">${copy(explanation)}</p>` : ""}
    ${usage ? `<dl class="decision-metrics">${metric("判断次数", `${number(usage.calls)} 次`)}${metric("直接操作", `${number(task.usage.jevActions || 0)} 次`)}${metric("平均响应", completed ? seconds(usage.elapsedMs / completed) : "等待响应")}${metric("输入用量", `${number(usage.inputTokens)} token`)}</dl>` : ""}
    <details id="jev-decision-details" class="details"><summary>查看每次判断与耗时说明</summary>
      <p class="muted">平均响应包含请求准备、网络、服务端处理和结果解析，不含浏览器操作。进行中和中断的调用不计入平均值。</p>
      ${decisions.length ? `<ul class="decision-log">${decisions.map(d => `<li><div class="decision-log-title"><strong>${copy(names[d.operation || ""] || (d.status === "interrupted" ? "判断已中断" : d.status === "running" ? "正在判断" : "转交主模型"))}</strong><span>${d.status === "running" ? "等待响应" : seconds(d.elapsedMs)}</span></div><small>${escape(new Date(d.at).toLocaleTimeString("zh-CN"))}${d.target ? ` · 元素 ${escape(d.target)}` : ""} · ${number(d.inputTokens)} token${d.confidence !== undefined ? ` · 置信度 ${Math.round(d.confidence * 100)}%` : ""}</small>${d.note || d.outcome ? `<p>${copy(d.note || names[d.outcome || ""] || d.outcome || "")}</p>` : ""}</li>`).join("")}</ul>` : '<p class="muted">旧任务仅保存了汇总数据，后续调用会记录逐次明细。</p>'}
      ${task.usage.helper ? `<p class="muted">${escape(taskModelLabel(task))} 辅助 ${number(task.usage.helper.calls)} 次 · ${number(task.usage.helper.inputTokens)} 输入 / ${number(task.usage.helper.outputTokens)} 输出 token</p>` : ""}
    </details></section>`;
}

export function renderExecutionStatus(task: BrowserTask): string {
  if (task.status !== "running" && task.status !== "queued") return "";
  const engine = task.execution?.engine === "jev" ? "Jev 正在执行" : task.execution?.engine === "model" ? `${taskModelLabel(task)} 正在执行` : "准备任务";
  return `<section class="execution-status" role="status" aria-live="polite"><span class="execution-dot" aria-hidden="true"></span><div><strong>${escape(engine)}</strong><p>${escape(taskModelText(task, task.execution?.activity || "等待可用浏览器"))}</p><small data-activity-age data-at="${escape(task.execution?.at || task.updatedAt)}">正在处理</small></div></section>`;
}

export function renderModelInfo(task: BrowserTask, settings: TaskSettings): string {
  const model = task.modelRuns?.at(-1);
  const configured = !model && ["queued", "paused", "waiting_user", "running"].includes(task.status);
  return `<section class="panel model-info"><h2>执行模型</h2>
    <small>${model ? "主模型 · 本任务最近使用" : configured ? "主模型 · 当前配置" : "主模型"}</small>
    <strong>${escape(model ? modelLabel(model.id) : configured ? modelLabel(settings.model) : "旧任务未记录模型名称")}</strong>
    ${model?.endpoint ? `<div class="url">${escape(model.endpoint)}</div>` : ""}
    ${configured ? '<small>旧记录未保存实际调用模型；继续执行时会记录。</small>' : ""}
    ${task.usage.jev ? `<p class="muted">页面判断：Jev${task.observation?.jev?.model ? ` · ${escape(task.observation.jev.model)}` : ""}</p>` : ""}
    ${(task.modelRuns?.length || 0) > 1 ? `<details><summary>模型变更记录</summary><ul>${task.modelRuns!.map(m => `<li>${escape(modelLabel(m.id))}<small>${escape(new Date(m.at).toLocaleString("zh-CN"))} · ${escape(m.endpoint)}</small></li>`).join("")}</ul></details>` : ""}</section>`;
}
