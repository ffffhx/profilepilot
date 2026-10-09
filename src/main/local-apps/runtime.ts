import type { LocalAppConfig, LocalAppRuntime, LocalAppView } from "../../shared/local-apps";
import { idleRuntime } from "./protocol";

export type DebugState = "connected" | "offline" | "unknown";

// Current evidence decides liveness. Discovering an external app never grants
// stop/restart control; only its authenticated supervisor grants that ownership.
export function resolveAppRuntime(config: LocalAppConfig, worker: LocalAppRuntime, process: LocalAppRuntime, debug: DebugState[]): Pick<LocalAppView, "runtime" | "managed" | "controls"> {
  const managed = config.mode === "launch" && ["starting", "running", "stopping"].includes(worker.status);
  let runtime: LocalAppRuntime;
  if (managed && ["starting", "stopping"].includes(worker.status)) runtime = worker;
  else if (process.status === "running" || debug.includes("connected")) {
    runtime = { ...idleRuntime(), ...process, status: "running", error: "", statusDetail: undefined };
    if (managed) runtime = { ...runtime, pid: worker.pid, startedAt: worker.startedAt };
    else runtime.statusDetail = "应用已在外部运行。可检查连接；停止或重启请使用应用自己的入口。";
  } else if (["starting", "running", "stopping"].includes(worker.status)) {
    runtime = { ...worker, serviceReady: process.serviceReady };
  } else if (process.status === "unknown" || worker.status === "unknown" || debug.includes("unknown")) {
    runtime = { ...idleRuntime(), status: "unknown", statusDetail: process.statusDetail || worker.statusDetail || "调试连接暂时无法确认，请稍后检查应用状态。" };
  } else if (worker.status === "failed") runtime = worker;
  else runtime = idleRuntime();
  if (runtime.status === "running" && config.mode !== "service" && debug.length && !debug.includes("connected")) {
    runtime.statusDetail = managed ? "应用进程正在运行，调试连接尚未就绪。" : "应用已在外部运行，调试连接尚未就绪。停止或重启请使用应用自己的入口。";
  }
  return {
    runtime, managed,
    controls: {
      start: config.mode !== "attach" && ["stopped", "failed"].includes(runtime.status),
      stop: managed && ["starting", "running"].includes(worker.status),
      restart: managed && worker.status === "running"
    }
  };
}
