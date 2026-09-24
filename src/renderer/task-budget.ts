import type { BrowserTask } from "../shared/tasks";

export function taskBudgetNote(task: BrowserTask): string {
  const basis = task.costAccounting?.version.startsWith("deepseek-")
    ? "DeepSeek 按公布单价估算，新调用使用本轮开始时的峰谷价格。"
    : "按 SDK 返回的费用估算。";
  const cached = task.cachedInputTokens;
  const cache = typeof cached === "number" && task.usage.inputTokens > 0 && cached <= task.usage.inputTokens
    ? ` 缓存命中 ${((cached / task.usage.inputTokens) * 100).toFixed(1)}%（输入已包含缓存）。`
    : "";
  return `${basis}预算仅覆盖主模型执行，不含 Jev 和文本辅助调用；实际费用以服务商账单为准。${cache}`;
}
