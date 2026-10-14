import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requestWindowsProcessClose } from "../windows-platform";

const execute = promisify(execFile);

// Request the application's normal quit path, allowing it to save or cancel.
// Never fall back to taskkill, SIGKILL, or forceTerminate on this path.
export async function requestAppQuit(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  if (process.platform === "win32") return requestWindowsProcessClose([pid]);
  if (process.platform !== "darwin") return false;
  try {
    const { stdout } = await execute("/usr/bin/osascript", ["-l", "JavaScript", "-e",
      `ObjC.import('AppKit'); var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); app.isNil() ? false : Boolean(app.terminate);`
    ], { timeout: 4000 });
    return stdout.trim() === "true";
  } catch { return false; }
}
