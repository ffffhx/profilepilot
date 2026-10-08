import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PhoneAction, PhoneActionResult, PhoneDevice } from "../../shared/phones";
import type { ProfilePilotManagementCommand, ProfilePilotManagementResponse } from "../profilepilot-management-protocol";
import { executePhoneFlow, phoneFlowNeedsControl, phoneFlowSchema, type PhoneFlowReport } from "./flow";

type Request = (command: ProfilePilotManagementCommand) => Promise<ProfilePilotManagementResponse>;
export async function runPhoneFlowCli(flags: Map<string, string>, request: Request): Promise<unknown> {
  const id = flags.get("--device"), file = flags.get("--file");
  if (!id || !file) throw new Error("run 需要 --device 和 --file。");
  if ((await fs.stat(file)).size > 262144) throw new Error("流程文件超过 256 KiB。");
  const flow = phoneFlowSchema.parse(JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "")));
  const mode = flags.get("--mode") || (phoneFlowNeedsControl(flow) ? "control" : "view");
  if (!["view", "control"].includes(mode)) throw new Error("模式必须为 view 或 control。");
  if (mode === "view" && phoneFlowNeedsControl(flow)) throw new Error("仅查看流程不能包含输入或滚动操作。");
  const directory = flags.get("--output-dir") ? path.resolve(flags.get("--output-dir")!, `run-${Date.now()}-${randomUUID()}`) : undefined;
  if (directory) await fs.mkdir(directory, { recursive: true });
  const call = async <T>(method: string, params: unknown): Promise<T> => {
    const response = await request({ action: "phone", method, params });
    if (!response.ok) throw new Error(response.error?.message || "手机操作失败，流程已停止");
    return response.data as T;
  };
  let lease: string | undefined, device: PhoneDevice | undefined, timer: NodeJS.Timeout | undefined;
  let pulseInFlight: Promise<void> | undefined, pulseError: Error | undefined;
  let report: (PhoneFlowReport & { outputDir?: string; evidenceError?: string; cleanupError?: string }) | undefined;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    const owner = await call<{ lease: string; device: PhoneDevice }>("wrapper-start", { id, mode, controller: flags.get("--controller") || "ProfilePilot CLI", task: flags.get("--task") || flow.name });
    lease = owner.lease; device = owner.device;
    const expected = device.state;
    if (!expected) throw new Error("手机未返回控制会话");
    const checkState = (state: PhoneDevice["state"]) => {
      if (pulseError) throw pulseError;
      if (abort.signal.aborted) throw new Error("流程已取消");
      if (!state || state.instanceId !== expected.instanceId || state.sessionId !== expected.sessionId || state.generation !== expected.generation
          || !["viewing", "controlling", "executing"].includes(state.phase)) throw new Error("手机已暂停、结束或会话已改变，流程不会自动恢复");
    };
    checkState(expected);
    timer = setInterval(() => {
      if (pulseInFlight || pulseError) return;
      pulseInFlight = call<PhoneDevice>("wrapper-pulse", { lease }).then(value => checkState(value.state))
        .catch(error => { pulseError = error; }).finally(() => { pulseInFlight = undefined; });
    }, 1500);
    timer.unref();
    const perform = async (action: PhoneAction): Promise<unknown> => {
      checkState(expected);
      const response = await call<PhoneActionResult>("wrapper-action", { lease, generation: expected.generation, requestId: randomUUID(), action });
      checkState(response.state);
      return response.result;
    };
    report = { ...await executePhoneFlow(flow, perform, { signal: abort.signal }), outputDir: directory };
    // Evidence is opt-in and only captured while this exact session still owns control.
    // No retry, native-ADB fallback, or fresh session after an uncertain action.
    if (!report.ok && directory) {
      try {
        const current = await call<PhoneDevice>("wrapper-state", { lease }); checkState(current.state);
        if (current.companion !== "ready" || current.connection !== "device") throw new Error("连接未就绪，未采集失败画面");
        const snapshot = await perform({ kind: "snapshot" });
        await fs.writeFile(path.join(directory, "failure-snapshot.json"), JSON.stringify(snapshot, null, 2));
        const shot = await perform({ kind: "screenshot", format: "png" }) as { mime?: string; base64?: string };
        if (shot?.mime !== "image/png" || typeof shot.base64 !== "string") throw new Error("截图结果无效");
        await fs.writeFile(path.join(directory, "failure.png"), Buffer.from(shot.base64, "base64"));
      } catch (error) { report.evidenceError = (error as Error).message; }
    }
  } finally {
    clearInterval(timer);
    try {
      await pulseInFlight;
      if (lease) {
        try { await call("wrapper-stop", { lease }); }
        catch (error) {
          if (report) { report.ok = false; report.cleanupError = (error as Error).message; }
          else throw error;
        }
      }
    } finally {
      process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    }
    if (report && directory) await fs.writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  }
  return report;
}
