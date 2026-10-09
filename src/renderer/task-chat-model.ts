import type { BrowserTask, TaskEvent, TaskStream } from "../shared/tasks";
import { TERMINAL_TASKS } from "../shared/tasks";
import { priorResult } from "./task-interaction-model";
import { matchingAnswer, resumedAnswerAliases } from "./task-rich-view";

export interface ChatRow {
  id: string;
  role: "user" | "assistant";
  text: string;
  domId: string;
  sourceId?: string;
  streaming?: boolean;
  events?: TaskEvent[];
  supplement?: string;
  final?: boolean;
  aliasId?: string;
}
const resultText = (result: NonNullable<BrowserTask["result"]>) =>
  [result.summary, result.evidence.length ? `### 依据\n${result.evidence.map(s => `- ${s}`).join("\n")}` : "",
    result.remaining.length ? `### 待处理\n${result.remaining.map(s => `- ${s}`).join("\n")}` : ""].filter(Boolean).join("\n\n");

/** One identity from the first delta through persistence, including stopped runs. */
export function taskChatRows(task: BrowserTask, stream?: TaskStream): ChatRow[] {
  const rows: ChatRow[] = [{ id: "prompt", role: "user", text: task.prompt, domId: "task-prompt", sourceId: "prompt" }];
  const answer = matchingAnswer(task), aliases = resumedAnswerAliases(task);
  let events: TaskEvent[] = [];
  const flush = () => {
    if (events.length) rows.push({ id: `tools-${events[0].id}`, domId: `tools-${events[0].id}`, role: "assistant", text: "", events });
    events = [];
  };
  for (const [index, event] of task.events.entries()) {
    if (aliases.skipped.has(event.id) || index === 0 && event.kind === "user" && event.text === task.prompt) continue;
    if (event.kind !== "user" && event.kind !== "assistant") { events.push(event); continue; }
    flush();
    const result = priorResult(event.text), final = event.id === answer, alias = aliases.bySource.get(event.id);
    rows.push({ id: event.streamId ? `stream-${event.streamId}` : event.id, domId: `event-${event.id}`, sourceId: event.id,
      role: event.kind, text: result ? resultText(result) : event.text, final,
      supplement: final && task.result ? resultText({ ...task.result, summary: "" }) : alias?.extra,
      aliasId: alias?.event.id });
  }
  flush();
  if (stream?.text && !task.events.some(event => event.streamId === stream.id)) rows.push({
    id: `stream-${stream.id}`, domId: "task-stream", role: "assistant", text: stream.text, streaming: true
  });
  if (task.result && !answer) rows.push({ id: "result", domId: "task-result", role: "assistant", sourceId: "result", text: resultText(task.result), final: true });
  else if (!task.result && TERMINAL_TASKS.has(task.status) && !stream?.text) rows.push({
    id: "result-status", domId: "task-result", role: "assistant",
    text: task.status === "completed" ? "任务已结束，未保存结果摘要。可展开执行过程查看记录。" : "任务已停止，已有内容已保留。继续前请核查已经完成的操作。"
  });
  return rows;
}

/** Reuse historical message objects across frequent snapshots and streaming ticks. */
export class ChatRowCache {
  private entries = new Map<string, { signature: string; row: ChatRow }>();
  update(rows: ChatRow[]): ChatRow[] {
    const next = new Map<string, { signature: string; row: ChatRow }>();
    const result = rows.map(row => {
      const signature = JSON.stringify(row), old = this.entries.get(row.id);
      const entry = old?.signature === signature ? old : { signature, row };
      next.set(row.id, entry); return entry.row;
    });
    this.entries = next;
    return result;
  }
}
