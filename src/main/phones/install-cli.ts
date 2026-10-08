import path from "node:path";
import type { PhoneDevice } from "../../shared/phones";
import type { ProfilePilotManagementCommand, ProfilePilotManagementResponse } from "../profilepilot-management-protocol";
import { inspectApk } from "./apk";

export async function installPhoneApkCli(flags: Map<string, string>, request: (command: ProfilePilotManagementCommand) => Promise<ProfilePilotManagementResponse>) {
  const id = flags.get("--device"), file = flags.get("--apk");
  if (!id || !file) throw new Error("install 需要 --device 和 --apk。");
  const apk = path.resolve(file), checked = await inspectApk(apk);
  const call = async <T>(method: string, params: unknown): Promise<T> => {
    const response = await request({ action: "phone", method, params });
    if (!response.ok) throw new Error(response.error?.message || "安装失败，请检查手机状态。");
    return response.data as T;
  };
  let lease: string | undefined, timer: NodeJS.Timeout | undefined, pulsing: Promise<void> | undefined;
  let cancelled = false, pulseError: Error | undefined;
  const cancel = () => { cancelled = true; };
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    const owner = await call<{ lease: string; device: PhoneDevice }>("wrapper-start", {
      id, mode: "control", controller: flags.get("--controller") || "ProfilePilot CLI", task: `安装 APK：${path.basename(apk)}`.slice(0, 500)
    });
    lease = owner.lease;
    const state = owner.device.state;
    if (!state) throw new Error("手机未返回控制会话。");
    timer = setInterval(() => {
      if (pulsing || pulseError || cancelled) return;
      pulsing = call("wrapper-pulse", { lease }).then(() => {}).catch(error => { pulseError = error; }).finally(() => { pulsing = undefined; });
    }, 1000);
    if (cancelled) throw new Error("安装已取消。");
    await call("wrapper-install", { lease, generation: state.generation, apk, sha256: checked.sha256 });
    while (true) {
      if (cancelled || pulseError) throw new Error("安装跟踪已中断，请核对手机上的安装结果；不会自动重试。");
      const result = await call<{ status: string; error?: string; sha256: string; bytes: number }>("wrapper-install-status", { lease });
      if (result.status === "installed") return { id, installed: true, apk, sha256: result.sha256, bytes: result.bytes };
      if (result.status !== "running") throw new Error(result.error || "安装已停止，请核对手机上的结果；不会自动重试。");
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  } finally {
    clearInterval(timer);
    try { await pulsing; if (lease) await call("wrapper-stop", { lease }); }
    finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  }
}
