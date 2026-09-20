import { setTimeout as delay } from "node:timers/promises";
import type { BrowserAction, BrowserObservation, BrowserTask, TaskSettings } from "../../shared/tasks";
import { jevProviderFor } from "../../shared/tasks";
import { chooseJevAction } from "./jev-actions";
import { taskHelper, type FieldValues, type Completion } from "./task-helper";

export interface DriverContext {
  task: BrowserTask; settings: TaskSettings; apiKey: string; jevKey: string; signal: AbortSignal;
  current(): boolean;
  observe(): Promise<BrowserObservation>;
  tool(name: string, args: unknown): Promise<any>;
  event(text: string): void;
  publish(): void;
  choose?: typeof chooseJevAction;
  helper?: typeof taskHelper;
}
export async function runJevDriver(ctx: DriverContext): Promise<string | undefined> {
  const { task, signal } = ctx;
  let waits = 0, unchanged = 0, previous = "", fieldCache: { key: string; result: FieldValues } | undefined;
  const active = (): boolean => { signal.throwIfAborted(); return task.status === "running" && ctx.current(); };
  const helper = async (kind: "fields" | "verify", observation: BrowserObservation) => {
    const usage = task.usage.helper ||= { calls: 0, inputTokens: 0, outputTokens: 0, elapsedMs: 0 };
    if (usage.calls >= 12) throw new Error("辅助调用已达到上限，交由完整 Agent 处理。");
    usage.calls++; ctx.publish();
    const result = await (ctx.helper || taskHelper)(ctx.apiKey, ctx.settings, task, observation, kind, signal);
    usage.inputTokens += result.inputTokens; usage.outputTokens += result.outputTokens; usage.elapsedMs += result.elapsedMs; ctx.publish();
    if (!active()) throw new Error("任务配置已变化，停止当前判断。");
    return result.result;
  };
  if (task.needsReconciliation || task.items.length || task.attachments.length) return "任务需要核查已有记录、读取附件或管理批量项目，交由完整 Agent 处理。";
  ctx.event("Jev 正在选择页面动作；填写内容和完成核查按需调用主模型。");
  // Only bootstrap a URL explicitly supplied by the user, and only on the first run.
  if (!task.receipts.length) {
    const url = task.prompt.match(/https?:\/\/[^\s<>"“”]+/)?.[0]?.replace(/[，。；）)]+$/, "");
    if (url) { await ctx.tool("browser_action", { kind: "open", value: url, effect: "read", summary: "打开任务指定页面" }); if (!active()) return; }
  }
  for (let step = 0; step < 100 && active(); step++) {
    if ((task.usage.jev?.calls || 0) >= 100) return "Jev 已达到本任务 100 次判断上限，交由主模型继续。";
    const observation = await ctx.observe();
    if (!active()) return;
    if (!observation.fast) return "当前浏览器不支持快速页面观察，交由主模型继续。";
    unchanged = observation.fingerprint === previous ? unchanged + 1 : 0; previous = observation.fingerprint;
    if (unchanged >= 3) return "页面连续多次没有变化，交由主模型检查原因。";
    const usage = task.usage.jev ||= { calls: 0, inputTokens: 0, elapsedMs: 0 };
    usage.calls++; ctx.publish();
    const decision = await (ctx.choose || chooseJevAction)(ctx.jevKey, task, observation, { provider: jevProviderFor(ctx.settings), signal });
    usage.inputTokens += decision.inputTokens; usage.elapsedMs += decision.elapsedMs; ctx.publish();
    if (!active()) return;
    if (decision.operation === "REVIEW" || (!decision.operation && !task.usage.jevActions)) return decision.note || "Jev 将复杂判断交给主模型继续处理。";
    // Uncertainty after making progress gets one bounded completion check first.
    // This cannot authorize another action and avoids starting a full SDK just
    // to read a receipt already on screen. Failed verification still delegates.
    const op = decision.operation || "DONE";
    const candidate = observation.fast.candidates.find(c => c.ref === decision.target);
    if (op === "BLOCKED") { await ctx.tool("handoff", { reason: "当前步骤需要你检查", details: "页面可能需要登录、验证或补充信息；处理后可交还浏览器继续。" }); return; }
    if (op === "WAIT") { if (++waits > 3) return "页面等待过久，交由主模型检查。"; await delay(400, undefined, { signal }); continue; }
    waits = 0;
    if (op === "DONE") {
      // Independent fresh observation + generative verification, never trust DONE alone.
      const latest = await ctx.observe();
      let result: Completion;
      try { result = await helper("verify", latest) as Completion; } catch (error) { signal.throwIfAborted(); return (error as Error).message; }
      if (!active()) return;
      if (!result.complete || result.remaining.length || !result.evidence.length || !result.evidence.every(e => latest.snapshot.includes(e))) return "主模型尚未确认全部完成，继续检查剩余要求。";
      const finished = await ctx.tool("finish", { status: "completed", summary: result.summary, evidence: result.evidence, remaining: [] });
      return finished.isError ? "完成依据未通过检查，交由主模型继续核查。" : undefined;
    }
    const action: BrowserAction = { kind: op === "CLICK" ? "click" : op === "TYPE_TEXT" ? "fill" : op === "SELECT" ? "select" : "scroll", version: observation.version, effect: op === "TYPE_TEXT" || op === "SELECT" ? "edit" : "read", summary: "" };
    if (action.kind === "scroll") { action.value = op === "SCROLL_UP" ? "up" : "down"; action.summary = op === "SCROLL_UP" ? "向上查看页面" : "向下查看页面"; }
    else {
      if (!candidate) return "Jev 选择的元素已失效，交由主模型重新观察。";
      action.ref = candidate.ref;
      action.summary = `${action.kind === "click" ? "点击" : action.kind === "select" ? "选择" : "填写"}：${candidate.label || candidate.ref}`;
      if (action.kind === "fill" || action.kind === "select") {
        const cacheKey = JSON.stringify([observation.url, observation.fast.document, observation.fast.candidates.map(({ value, checked, ...c }) => c)]);
        try {
          if (fieldCache?.key !== cacheKey) fieldCache = { key: cacheKey, result: await helper("fields", observation) as FieldValues };
        } catch (error) { signal.throwIfAborted(); return (error as Error).message; }
        if (!active()) return;
        const field = fieldCache.result.fields.find(f => f.ref === candidate.ref);
        if (!field) { await ctx.tool("ask_user", { question: fieldCache.result.question || `请补充“${candidate.label}”需要填写的内容。` }); return; }
        action.value = field.text;
        if (candidate.value === action.value) return "所选字段已经填写，交由主模型检查下一步。";
      }
    }
    if (!active()) return;
    const result = await ctx.tool("browser_action", action);
    if (!active()) return;
    if (result.isError) { ctx.event("页面已变化，重新读取后再选择动作。"); continue; }
    task.usage.jevActions = (task.usage.jevActions || 0) + 1; ctx.publish();
    await delay(80, undefined, { signal });
  }
  return task.status === "running" ? "Jev 执行循环已结束，交由主模型继续。" : undefined;
}
