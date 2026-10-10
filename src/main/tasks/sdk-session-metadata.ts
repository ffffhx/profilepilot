import { fork } from "node:child_process";
import path from "node:path";

/** Each task has its own CLAUDE_CONFIG_DIR. A short-lived helper prevents SDK
 * metadata calls from changing the desktop's global environment or touching
 * another task's session. It only uses local SDK file APIs, never inference. */
export async function renameSdkSession(directory: string, sessionId: string, title: string): Promise<void> {
  if (!/^[\w-]+$/.test(sessionId)) throw new Error("SDK 会话编号格式不正确。");
  const child = fork(path.join(__dirname, "sdk-session-metadata-worker.js"), [], {
    cwd: directory, execArgv: [], ...{ windowsHide: true }, stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|Path|PATHEXT|SystemRoot|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/.test(key))),
      ELECTRON_RUN_AS_NODE: "1", CLAUDE_CONFIG_DIR: directory }
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => finish(new Error("保存 SDK 会话标题超时，请刷新后检查结果。")), 10000);
    child.once("error", finish);
    child.once("exit", () => finish(new Error("SDK 会话标题未保存，请重试。")));
    child.once("message", (result: any) => finish(result?.ok ? undefined : new Error(result?.error || "保存 SDK 会话标题失败。")));
    child.send({ sessionId, title, directory }, error => { if (error) finish(error); });
  });
}
