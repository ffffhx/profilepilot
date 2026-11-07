import path from "node:path";
import type { PhoneDevice } from "../../shared/phones";
import type { ProfilePilotManagementCommand, ProfilePilotManagementResponse } from "../profilepilot-management-protocol";
import { inspectApk } from "./apk";
import { phoneFailure, phoneResponseError } from "./errors";

export async function installPhoneApkCli(flags: Map<string, string>, request: (command: ProfilePilotManagementCommand) => Promise<ProfilePilotManagementResponse>) {
  const id = flags.get("--device"), file = flags.get("--apk");
  if (!id || !file) throw new Error("install 需要 --device 和 --apk。");
  const apk = path.resolve(file), checked = await inspectApk(apk);
  const call = async <T>(method: string, params: unknown): Promise<T> => {
    const response = await request({ action: "phone", method, params });
    if (!response.ok) throw phoneResponseError(response);
    return response.data as T;
  };
  let lease: string | undefined, timer: NodeJS.Timeout | undefined, pulsing: Promise<void> | undefined;
  let cancelled = false, pulseError: Error | undefined;
  let failed = false;
  const cancel = () => { cancelled = true; };
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    const owner = await call<{ lease: string; device: PhoneDevice }>("wrapper-start", {
      id, mode: "control", controller: flags.get("--controller") || "ProfilePilot CLI", task: `安装 APK：${path.basename(apk)}`.slice(0, 500)
    });
    lease = owner.lease;
    const state = owner.device.state;
    if (!state) throw phoneFailure("PHONE_RESPONSE_MISSING", "手机未返回控制会话；安装尚未提交。");
    timer = setInterval(() => {
      if (pulsing || pulseError || cancelled) return;
      pulsing = call("wrapper-pulse", { lease }).then(() => {}).catch(error => { pulseError = error; }).finally(() => { pulsing = undefined; });
    }, 1000);
    if (cancelled) throw phoneFailure("PHONE_CANCELLED", "安装已取消。", "not-executed");
    await call("wrapper-install", { lease, generation: state.generation, apk, sha256: checked.sha256 });
    while (true) {
      if (cancelled) throw phoneFailure("PHONE_EXECUTION_UNCERTAIN", "安装跟踪已中断，请核对手机上的安装结果；不会自动重试。", "unknown");
      const result = await call<{ status: string; jobId?: string; error?: string; code?: string; recovery?: unknown; sha256: string; bytes: number }>("wrapper-install-status", { lease });
      if (result.status === "installed") return { id, installed: true, apk, sha256: result.sha256, bytes: result.bytes };
      if (result.status === "awaiting-user") return { id, installed: false, awaitingUserConfirmation: true, jobId: result.jobId, apk, sha256: result.sha256, bytes: result.bytes,
        nextStep: "请在手机 Android 安装界面确认。控制会话已结束；用 phone internet install-status --device ID --job JOB_ID 查询结果，不要重复安装。" };
      if (pulseError) throw phoneFailure((pulseError as { code?: string }).code || "PHONE_EXECUTION_UNCERTAIN", "安装跟踪已中断，请核对手机上的安装结果；不会自动重试。", "unknown");
      if (result.status !== "running") throw Object.assign(phoneFailure(result.code || "PHONE_EXECUTION_UNCERTAIN", result.error || "安装已停止，请核对手机上的结果；不会自动重试。", "unknown"), result.recovery ? { details: { recovery: result.recovery } } : {});
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  } catch (error) { failed = true; throw error;
  } finally {
    clearInterval(timer);
    try { await pulsing; if (lease) { try { await call("wrapper-stop", { lease }); } catch (error) { if (!failed) throw error; } } }
    finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  }
}
