import { spawn, spawnSync, type ExecFileSyncOptionsWithStringEncoding, type SpawnOptions } from "node:child_process";
import path from "node:path";
import { windowsPowerShellExecutable } from "./windows-platform";

export interface PortableCommandInvocation {
  executable: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export function portableCommandInvocation(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): PortableCommandInvocation {
  if (process.platform !== "win32") {
    return { executable, args };
  }
  const extension = path.extname(executable).toLowerCase();
  if (extension === ".js" || extension === ".cjs" || extension === ".mjs") {
    return { executable: process.execPath, args: [executable, ...args] };
  }
  if (extension === ".ps1") {
    return {
      executable: windowsPowerShellExecutable(env),
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", executable, ...args]
    };
  }
  if (extension === ".cmd" || extension === ".bat") {
    const commandLine = [executable, ...args].map(quoteWindowsBatchArgument).join(" ");
    return {
      executable: env.ComSpec || env.COMSPEC || path.join(env.SystemRoot || env.SYSTEMROOT || process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
      args: ["/d", "/s", "/c", `"${commandLine}"`],
      windowsVerbatimArguments: true
    };
  }
  return { executable, args };
}

export function spawnPortableCommand(
  executable: string,
  args: string[],
  options: SpawnOptions = {}
): ReturnType<typeof spawn> {
  const sourceEnv = options.env || process.env;
  const invocation = portableCommandInvocation(executable, args, sourceEnv);
  return spawn(invocation.executable, invocation.args, {
    ...options,
    env: portableCommandEnvironment(executable, sourceEnv),
    windowsVerbatimArguments: invocation.windowsVerbatimArguments
  });
}

export function execPortableCommandSync(
  executable: string,
  args: string[],
  options: ExecFileSyncOptionsWithStringEncoding
): string {
  const sourceEnv = options.env || process.env;
  const invocation = portableCommandInvocation(executable, args, sourceEnv);
  const result = spawnSync(invocation.executable, invocation.args, {
    ...options,
    env: portableCommandEnvironment(executable, sourceEnv),
    windowsVerbatimArguments: invocation.windowsVerbatimArguments
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = typeof result.stderr === "string" ? result.stderr.trim() : "";
    const error = new Error(detail || `命令退出码 ${result.status ?? "未知"}`) as Error & { status?: number | null };
    error.status = result.status;
    throw error;
  }
  return result.stdout || "";
}

function portableCommandEnvironment(executable: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (
    process.platform === "win32" &&
    Boolean(process.versions.electron) &&
    [".js", ".cjs", ".mjs"].includes(path.extname(executable).toLowerCase())
  ) {
    return { ...env, ELECTRON_RUN_AS_NODE: "1" };
  }
  return env;
}

function quoteWindowsBatchArgument(value: string): string {
  // cmd.exe parses metacharacters before handing arguments to a .cmd/.bat file,
  // including characters inside the outer /c command string.
  const escaped = value
    .replace(/"/g, '""')
    .replace(/([&|<>^])/g, "^$1");
  return `"${escaped}"`;
}
