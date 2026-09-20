import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
export function loadConfiguredTaskProvider(options = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    if (options.includeJev) env.PP_TASK_PROVIDER_INCLUDE_JEV = "1";
    else delete env.PP_TASK_PROVIDER_INCLUDE_JEV;
    const child = spawn(require("electron"), [fileURLToPath(new URL("./task-provider-vault.cjs", import.meta.url))], { env, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let settled = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error("Local credential helper timed out.")); }, 15000);
    child.once("message", message => { settled = true; clearTimeout(timer); message.error ? reject(new Error(message.error)) : resolve(message); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); if (!settled) reject(new Error("Local credential helper exited without a result.")); });
  });
}
