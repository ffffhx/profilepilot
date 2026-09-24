import { taskBudgetNote } from "./task-budget";
import type { BrowserTask, TaskResult, TaskSettings } from "../shared/tasks";
import { taskIcon as icon } from "./task-icons";
import { renderModelInfo, renderJevProgress } from "./task-progress";
import { renderTaskEvents } from "./task-events";
import { taskComposer } from "./task-composer";
import { renderTaskText } from "./task-links";

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const date = (value: string): string => new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

export function historyActions(): string {
  return `<details class="history-menu" id="history-menu"><summary aria-label="更多任务操作" title="更多任务操作">•••</summary><div class="history-menu-items"><button data-action="edit-task">编辑为新任务</button><button data-action="save-task-template">保存为模板</button><button data-action="export-task">导出任务</button><button data-action="delete-task" class="danger">删除任务</button></div></details>`;
}

const resultList = (title: string, items?: string[]): string => items?.length ? `<h3>${title}</h3><ul>${items.map(item => `<li>${renderTaskText(item)}</li>`).join("")}</ul>` : "";
const userMessage = (text: string): string => `<article class="history-request" aria-label="用户消息"><p>${renderTaskText(text)}</p></article>`;

function previousMessages(task: BrowserTask): string {
  // Results are archived into events when the same task is resumed. Keep those
  // turns readable in the conversation instead of hiding replies in diagnostics.
  return task.events.map((event, index) => {
    if (event.kind === "user") return index === 0 && event.text === task.prompt ? "" : userMessage(event.text);
    if (event.kind !== "assistant" || !event.text.startsWith("上次执行结果：")) return "";
    try {
      const result: TaskResult = JSON.parse(event.text.slice("上次执行结果：".length));
      if (typeof result.summary !== "string" || !Array.isArray(result.evidence) || !Array.isArray(result.remaining)) return "";
      return `<article class="history-answer" aria-label="之前的回复"><div class="history-agent"><img src="./assets/profilepilot-mark.svg" alt=""><strong>Agent</strong></div><div class="history-answer-body"><p>${renderTaskText(result.summary)}</p>${resultList("页面依据", result.evidence)}${resultList("待处理", result.remaining)}</div></article>`;
    } catch { return ""; }
  }).join("");
}

export function taskResultMessage(task: BrowserTask, status: string): string {
  const result = task.result;
  const summary = result?.summary || (task.status === "completed" ? "任务已结束，未保存结果摘要。你可以展开执行过程查看记录。" : "任务已停止，尚无完整核实结果。再次执行前，请先核查已经完成的操作。");
  return `<article class="history-answer" aria-label="任务结果"><div class="history-agent"><img src="./assets/profilepilot-mark.svg" alt=""><strong>Agent</strong><span>${escape(status)}</span></div><div class="history-answer-body"><p>${renderTaskText(summary)}</p>${resultList("页面依据", result?.evidence)}${resultList("待处理", result?.remaining)}${task.needsReconciliation ? '<p class="history-reconcile">再次执行前，需要核查上次操作的结果。</p>' : ""}</div></article>`;
}

export function taskHistory(task: BrowserTask, settings: TaskSettings, status: string, itemNames: Record<string, string>): string {
  return `<div class="history-thread">
    <div class="history-context"><span class="task-status-dot ${task.status}"></span><span>${status}</span><span class="history-context-divider">·</span><span>${escape(task.profileName)}</span><time>${date(task.updatedAt)}</time></div>
    <article class="history-request" aria-label="任务要求"><p>${renderTaskText(task.prompt)}</p></article>
    ${previousMessages(task)}
    <details class="history-process" id="history-process"><summary>${icon("chevron")}<span>查看执行过程</span><small>${task.usage.actions} 次操作 · ${Math.round(task.usage.elapsedMs / 1000)} 秒</small></summary><div class="history-events">${renderTaskEvents(task.events) || '<p class="muted">没有保存执行记录。</p>'}</div></details>
    ${taskResultMessage(task, status)}
    ${task.items.length ? `<section class="history-items"><div class="panel-header"><h2>逐项结果</h2>${task.items.some(item => item.status !== "completed") ? '<button data-action="retry-items">继续所选项</button>' : ""}</div>${task.items.map(item => `<div class="item">${item.status !== "completed" ? `<input type="checkbox" name="retryItem" value="${escape(item.id)}" aria-label="继续 ${escape(item.label)}">` : ""}<span class="pill">${itemNames[item.status]}</span><div>${escape(item.label)}<p class="muted">${renderTaskText(item.result)}</p>${item.evidence ? `<small>依据：${renderTaskText(item.evidence)}</small>` : ""}</div></div>`).join("")}</section>` : ""}
    ${task.outputs?.length ? `<section class="history-files" aria-label="下载的文件">${task.outputs.map(file => `<button data-output-file="${escape(file.id)}">${icon("paperclip")}${escape(file.name)} ↗</button>`).join("")}</section>` : ""}
    <details class="history-details" id="history-details"><summary>任务详情 ${icon("chevron")}</summary><div class="history-details-body">${renderModelInfo(task, settings)}${task.plan.length ? `<section><h2>执行步骤</h2><ol class="plan">${task.plan.map(step => `<li>${escape(step)}</li>`).join("")}</ol></section>` : ""}${renderJevProgress(task)}<section><h2>运行情况</h2><p class="muted">${Math.round(task.usage.elapsedMs / 1000)} 秒 · ${task.usage.actions} 次操作 · 主模型估算 $${task.usage.costUsd.toFixed(3)}</p><small>${task.usage.inputTokens} 输入 / ${task.usage.outputTokens} 输出 token。${escape(taskBudgetNote(task))}</small></section><section><h2>执行记录与资料版本</h2><p class="muted">${task.materials.map(item => `${escape(item.name)} v${item.version}`).join("、") || "未选择保存的资料"}</p>${task.receipts.map(receipt => `<p class="muted">${date(receipt.at)} · ${escape(receipt.action.summary)}<br>${({ started: "已请求执行", executed: "动作已执行", uncertain: "结果未确认" })[receipt.status]}</p>`).join("")}</section></div></details>
  </div><footer class="history-footer">${taskComposer()}</footer>`;
}
