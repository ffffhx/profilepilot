import type { BrowserTask, JevDecisionRecord } from "../../shared/tasks";

export function beginJevCall(task: BrowserTask, mode: JevDecisionRecord["mode"]): JevDecisionRecord {
  const usage = task.usage.jev ||= { calls: 0, completedCalls: 0, inputTokens: 0, elapsedMs: 0 };
  usage.completedCalls ??= usage.calls;
  usage.calls++;
  const record: JevDecisionRecord = { at: new Date().toISOString(), mode, status: "running", elapsedMs: 0, inputTokens: 0 };
  (task.jevDecisions ||= []).push(record);
  task.jevDecisions = task.jevDecisions.slice(-100);
  return record;
}

export function finishJevCall(task: BrowserTask, record: JevDecisionRecord, result?: Partial<JevDecisionRecord>): void {
  if (record.status !== "running") return;
  if (!result) {
    Object.assign(record, { status: "interrupted", elapsedMs: Math.max(0, Date.now() - Date.parse(record.at)), note: "判断已中断，未计入平均响应时间。" });
    return;
  }
  Object.assign(record, result, { status: "completed" });
  const usage = task.usage.jev!;
  usage.completedCalls = (usage.completedCalls || 0) + 1;
  usage.inputTokens += record.inputTokens;
  usage.elapsedMs += record.elapsedMs;
}
