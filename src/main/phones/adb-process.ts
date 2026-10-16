import { spawn } from "node:child_process";

export interface AdbProcessOptions { stdout(data: Buffer): void; stderr(data: Buffer): void; cwd?: string; }
export interface AdbProcess {
  done: Promise<{ code: number; signal: string | null }>;
  write(data: Buffer): Promise<void>;
  end(): void;
  abort(): void;
}
/** No host shell or text decoding: Unicode argv and binary streams survive on
 * Windows and macOS. The desktop owns this child and its cancellation. */
export function spawnAdb(executable: string, args: string[], options: AdbProcessOptions): AdbProcess {
  const child = spawn(executable, args, { cwd: options.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", options.stdout); child.stderr.on("data", options.stderr);
  child.stdin.on("error", () => { /* write callbacks and process exit report errors */ });
  let escalation: NodeJS.Timeout | undefined;
  const done = new Promise<{ code: number; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { clearTimeout(escalation); resolve({ code: code ?? 130, signal }); });
  });
  return {
    done,
    write: data => new Promise((resolve, reject) => child.stdin.write(data, error => error ? reject(error) : resolve())),
    end: () => child.stdin.end(),
    abort: () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      escalation = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 1000);
      escalation.unref();
    }
  };
}
