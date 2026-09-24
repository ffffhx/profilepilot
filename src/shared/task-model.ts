import type { BrowserTask, TaskSettings } from "./tasks";

export function modelLabel(id: string): string {
  const name = id.split("/").at(-1) || id;
  const brand = /^kimi(?:[-_:]|$)/i.test(name) ? "Kimi" : /^claude(?:[-_:]|$)/i.test(name) ? "Claude"
    : /^(gpt[-_]|o[134](?:[-_]|$))/i.test(name) ? "OpenAI" : /^gemini[-_]/i.test(name) ? "Gemini"
    : /^deepseek[-_]/i.test(name) ? "DeepSeek" : /^qwen/i.test(name) ? "Qwen" : /^grok[-_]/i.test(name) ? "Grok" : "";
  return brand ? `${brand} · ${id}` : id;
}
export function taskModelLabel(task: BrowserTask): string {
  const model = task.modelRuns?.at(-1);
  return model ? modelLabel(model.id) : "主模型";
}
export function taskModelText(task: BrowserTask, value: string): string {
  return value.replace(/主模型/g, taskModelLabel(task));
}
export function recordTaskModel(task: BrowserTask, settings: TaskSettings): void {
  // Store only the configured model and service origin, never credentials or URL parameters.
  let endpoint = "";
  try { endpoint = new URL(settings.baseUrl).origin; } catch { /* legacy configuration */ }
  const previous = task.modelRuns?.at(-1);
  if (previous?.id === settings.model && previous.endpoint === endpoint) return;
  (task.modelRuns ||= []).push({ id: settings.model, endpoint, at: new Date().toISOString() });
}
