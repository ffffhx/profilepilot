import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { PhoneAction, PhoneSelector } from "../../shared/phones";
import { phoneActionSchema, phoneSelectorSchema, isPhoneRead } from "./actions";

const timeout = z.number().int().min(0).max(30000);
const condition = z.enum(["visible", "absent"]).default("visible");
export const phoneStepSchema = z.union([
  phoneActionSchema,
  z.object({ kind: z.literal("wait"), selector: phoneSelectorSchema, condition, timeoutMs: timeout.default(5000) }).strict(),
  z.object({ kind: z.literal("assert"), selector: phoneSelectorSchema, condition }).strict(),
  z.object({ kind: z.literal("scrollUntil"), selector: phoneSelectorSchema, container: phoneSelectorSchema,
    direction: z.enum(["forward", "backward"]).default("forward"), maxScrolls: z.number().int().min(1).max(30).default(10),
    settleMs: z.number().int().min(100).max(2000).default(600) }).strict()
]);
export const phoneFlowSchema = z.object({
  version: z.literal(1), name: z.string().min(1).max(120).default("手机流程"),
  timeoutMs: z.number().int().min(1).max(300000).default(120000),
  steps: z.array(phoneStepSchema).min(1).max(100)
}).strict();
export type PhoneFlow = z.infer<typeof phoneFlowSchema>;
export interface PhoneStepReport { index: number; kind: string; ok: boolean; durationMs: number; error?: string; observations?: number; scrolls?: number; }
export interface PhoneFlowReport { ok: boolean; name: string; startedAt: string; durationMs: number; steps: PhoneStepReport[]; error?: string; failedStep?: number; }
export const phoneFlowNeedsControl = (flow: PhoneFlow): boolean => flow.steps.some(step => !["wait", "assert"].includes(step.kind) && !isPhoneRead(step.kind));

/** Only observations may repeat. An action with an uncertain result always stops the flow. */
export async function executePhoneFlow(flow: PhoneFlow, perform: (action: PhoneAction) => Promise<unknown>, runtime: {
  now?: () => number; delay?: (ms: number) => Promise<void>; signal?: AbortSignal;
} = {}): Promise<PhoneFlowReport> {
  const now = runtime.now || (() => performance.now());
  const delay = runtime.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const started = now(), deadline = started + flow.timeoutMs;
  const report: PhoneFlowReport = { ok: true, name: flow.name, startedAt: new Date().toISOString(), durationMs: 0, steps: [] };
  const check = () => {
    if (runtime.signal?.aborted) throw new Error("流程已取消，不会继续执行");
    if (now() >= deadline) throw new Error("流程达到总时限，已停止");
  };
  const send = async (action: PhoneAction) => { check(); const result = await perform(action); check(); return result; };
  for (const [index, step] of flow.steps.entries()) {
    const start = now();
    const entry: PhoneStepReport = { index: index + 1, kind: step.kind, ok: false, durationMs: 0 };
    report.steps.push(entry);
    const observe = async (selector: PhoneSelector, expected: "visible" | "absent"): Promise<boolean> => {
      const result = await send({ kind: "find", selector }) as { count?: unknown; matches?: unknown[] };
      if (!result || !Number.isInteger(result.count) || Number(result.count) < 0 || !Array.isArray(result.matches) || result.count !== result.matches.length) throw new Error("手机返回的定位结果无效，请更新配套 App");
      entry.observations = (entry.observations || 0) + 1;
      // A visible target must be unique. Absence can be checked against multiple matches.
      if (expected === "visible" && Number(result.count) > 1) throw new Error("定位条件匹配多个控件，请增加条件");
      return expected === "absent" ? result.count === 0 : result.count === 1;
    };
    const wait = async (selector: PhoneSelector, expected: "visible" | "absent", ms: number): Promise<boolean> => {
      const until = Math.min(deadline, now() + ms);
      do {
        if (await observe(selector, expected)) return true;
        if (now() >= until) return false;
        await delay(Math.min(200, until - now()));
        check();
      } while (true);
    };
    try {
      check();
      if (step.kind === "wait" || step.kind === "assert") {
        if (!await wait(step.selector, step.condition, step.kind === "assert" ? 0 : step.timeoutMs)) throw new Error(step.kind === "assert" ? "控件断言不成立" : "等待控件超时");
      } else if (step.kind === "scrollUntil") {
        let found = await observe(step.selector, "visible");
        for (let count = 0; !found && count < step.maxScrolls; count++) {
          const result = await send({ kind: "scroll", selector: step.container, direction: step.direction }) as { performed?: boolean };
          if (typeof result?.performed !== "boolean") throw new Error("手机返回的滚动结果无效");
          entry.scrolls = count + 1;
          found = await wait(step.selector, "visible", step.settleMs);
          if (!result.performed && !found) throw new Error("容器无法继续滚动，尚未找到目标");
        }
        if (!found) throw new Error("达到最大滚动次数，尚未找到目标");
      } else { await send(step); }
      entry.ok = true;
    } catch (error) {
      entry.error = (error as Error).message;
      report.ok = false; report.error = entry.error; report.failedStep = index + 1;
    }
    entry.durationMs = Math.round(now() - start);
    if (!report.ok) break;
  }
  report.durationMs = Math.round(now() - started);
  return report;
}
