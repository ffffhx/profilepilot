import type { BrowserTask, TaskEvent, TaskResult } from "../shared/tasks";
import { renderTaskEvents } from "./task-events";
import { taskMarkdown, escapeTaskHtml as e } from "./task-rich-text";
import { priorResult } from "./task-interaction-model";
import { TERMINAL_TASKS } from "../shared/tasks";

function resultDetails(result: TaskResult): string {
  return `${result.evidence.length ? `<h3>依据</h3>${taskMarkdown(result.evidence.map(item => `- ${item}`).join("\n"))}` : ""}${result.remaining.length ? `<h3>待处理</h3>${taskMarkdown(result.remaining.map(item => `- ${item}`).join("\n"))}` : ""}`;
}
export function richResult(result: TaskResult): string {
  return `<div class="task-markdown">${taskMarkdown(result.summary)}${resultDetails(result)}</div>`;
}
function comparableAnswer(text: string): string { return text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim(); }
export function matchingAnswer(task: BrowserTask): string {
  if (task.result?.kind !== "answer") return "";
  const latest = [...task.events].reverse().find(event => event.kind === "user" || event.kind === "assistant");
  if (latest?.kind !== "assistant") return "";
  const summary = task.result.summary.replace(/^已回答[:：]\s*/, "");
  return comparableAnswer(summary) === comparableAnswer(latest.text) ? latest.id : "";
}
export function resumedAnswerAliases(task: BrowserTask): { bySource: Map<string, { event: TaskEvent; extra: string }>; skipped: Set<string> } {
  const bySource = new Map<string, { event: TaskEvent; extra: string }>(), skipped = new Set<string>();
  const events = task.events;
  for (let index = 0; index < events.length - 3; index++) {
    const source = events[index], replay = events[index + 1];
    if (source.kind !== "assistant" || replay.kind !== "assistant") continue;
    let next = index + 2;
    if (events[next]?.kind !== "user") continue;
    while (events[next]?.kind === "user") next++;
    if (events[next]?.kind !== "system" || !events[next].text.startsWith("继续对话；")) continue;
    const replayAt = Date.parse(replay.at), userAt = Date.parse(events[index + 2].at);
    if (!Number.isFinite(replayAt) || !Number.isFinite(userAt) || Math.abs(userAt - replayAt) > 5000) continue;
    const original = comparableAnswer(source.text), recorded = comparableAnswer(replay.text);
    if (!original) continue;
    const prefixed = /^已回答[:：]/.test(recorded);
    const body = prefixed ? recorded.replace(/^已回答[:：]\s*/, "") : recorded;
    const extra = body === original ? "" : body.startsWith(`${original}\n`) ? body.slice(original.length + 1) : undefined;
    if (extra === undefined || extra && !/^(依据：|待完成：)/.test(extra)) continue;
    // The service marks pure answers with 已回答. Exact unprefixed records are
    // retained only for old local answer fixtures with no external actions.
    if (!prefixed && (extra || task.receipts.length || task.usage.actions)) continue;
    bySource.set(source.id, { event: replay, extra }); skipped.add(replay.id);
  }
  return { bySource, skipped };
}
export function richTranscript(task: BrowserTask): string {
  let out = `<article class="history-request" id="task-prompt" data-message-id="prompt"><div class="task-markdown">${taskMarkdown(task.prompt)}</div><button type="button" data-copy-message="prompt">复制</button></article>`;
  const answerEventId = matchingAnswer(task);
  const aliases = resumedAnswerAliases(task);
  let tools: TaskEvent[] = [];
  const flush = () => {
    if (!tools.length) return;
    const errors = tools.filter(event => event.kind === "error").length;
    out += `<details class="tool-group task-process-group" id="tools-${e(tools[0].id)}"><summary>执行过程 · ${tools.length} 条记录${errors ? ` · ${errors} 个错误` : ""}</summary><div class="tool-group-body">${tools.map(event => `<div id="event-${e(event.id)}">${renderTaskEvents([event])}</div>`).join("")}</div></details>`;
    tools = [];
  };
  for (const [index, event] of task.events.entries()) {
    if (aliases.skipped.has(event.id)) continue;
    if (index === 0 && event.kind === "user" && event.text === task.prompt) continue;
    if (event.kind !== "user" && event.kind !== "assistant") { tools.push(event); continue; }
    flush(); const result = priorResult(event.text), alias = aliases.bySource.get(event.id), finalAnswer = event.kind === "assistant" && event.id === answerEventId;
    out += `<article id="event-${e(event.id)}" class="${event.kind === "user" ? "history-request" : "history-answer"}${finalAnswer ? " task-final-answer" : ""}" data-message-id="${e(event.id)}"><div class="history-agent">${event.kind === "user" ? "你" : finalAnswer || alias ? "Agent · 已回答" : "Agent"}</div>${result ? richResult(result) : `<div class="task-markdown">${taskMarkdown(event.text)}</div>`}${finalAnswer ? `<div id="task-result" class="task-result-supplement" data-message-id="result" aria-label="任务结果">${task.result && (task.result.evidence.length || task.result.remaining.length) ? `<div class="task-markdown">${resultDetails(task.result)}</div>` : '<span class="sr-only">此回复已保存为任务结果。</span>'}</div>` : ""}${alias ? `<div id="event-${e(alias.event.id)}" class="history-result-alias" data-message-id="${e(alias.event.id)}"><span class="sr-only">上次结果与上方回复一致。</span>${alias.extra ? `<div class="task-markdown">${taskMarkdown(alias.extra)}</div>` : ""}</div>` : ""}<div class="actions"><button type="button" data-copy-message="${e(event.id)}" aria-label="复制${event.kind === "user" ? "用户消息" : "Agent 回复"}">复制</button>${event.kind === "user" ? `<button type="button" data-edit-message="${e(event.id)}">载入输入框编辑</button>` : `<button type="button" data-quote-message="${e(event.id)}">引用回复</button>`}${finalAnswer ? '<button type="button" data-copy-message="result" aria-label="复制最终结果">复制结果</button>' : ""}${alias ? `<button type="button" data-copy-message="${e(alias.event.id)}">复制上次结果</button><button type="button" data-quote-message="${e(alias.event.id)}">引用上次结果</button>` : ""}</div></article>`;
  }
  flush();
  if (task.result && !answerEventId) out += `<article class="history-answer" id="task-result" data-message-id="result"><div class="history-agent">Agent · ${task.status === "completed" ? "已完成" : "执行结果"}</div>${richResult(task.result)}<button type="button" data-copy-message="result">复制结果</button></article>`;
  else if (!task.result && TERMINAL_TASKS.has(task.status)) out += `<article class="history-answer task-state" id="task-result">${task.status === "completed" ? "任务已结束，未保存结果摘要。可以展开执行过程查看记录。" : "任务已停止，尚无完整核实结果。继续执行前请先核查已经完成的操作。"}</article>`;
  return out;
}
export function readableTask(task: BrowserTask): string {
  const lines = [`# ${task.title}`, `浏览器：${task.profileName}`, `状态：${task.status}`, "", "## 最初要求", task.prompt];
  for (const event of task.events) {
    const result = priorResult(event.text);
    if (event.kind === "user" || event.kind === "assistant") lines.push("", `## ${event.kind === "user" ? "用户" : "Agent"}`, result ? [result.summary, ...result.evidence, ...result.remaining].join("\n\n") : event.text);
  }
  if (task.result) lines.push("", "## 结果", task.result.summary, "", ...task.result.evidence.map(item => `- ${item}`), ...task.result.remaining.map(item => `- 待处理：${item}`));
  if (task.items.length) lines.push("", "## 逐项结果", ...task.items.map(item => `- ${item.label} (${item.status})：${item.result || ""}${item.evidence ? `；依据：${item.evidence}` : ""}`));
  return lines.join("\n");
}
