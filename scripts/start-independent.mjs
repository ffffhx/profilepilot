import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const DEFAULT_CONFIRMATION_MS = 8_000;
const POLL_INTERVAL_MS = 200;
const WINDOWS_ENVIRONMENT_PREFIXES = ["CPM_", "PROFILEPILOT_"];
const WINDOWS_ENVIRONMENT_NAMES = new Set([
  "CHROME_APP_NAME",
  "CHROME_BINARY",
  "CHROME_PATH",
  "CHROMIUM_BIN",
  "GOOGLE_CHROME_BIN",
  "NODE_ENV"
]);
const SENSITIVE_ENVIRONMENT_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)/i;

export function quoteWindowsArgument(value) {
  const input = String(value);
  if (input.length > 0 && !/[\s"]/u.test(input)) return input;
  let output = '"';
  let backslashes = 0;
  for (const character of input) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      output += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    output += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  output += "\\".repeat(backslashes * 2) + '"';
  return output;
}

export function independentEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name, value]) =>
      typeof value === "string" &&
      !SENSITIVE_ENVIRONMENT_NAME.test(name) &&
      (WINDOWS_ENVIRONMENT_NAMES.has(name) || WINDOWS_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix)))
    )
  );
}

function powershellString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function decodeExpression(value) {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powershellString(Buffer.from(String(value), "utf8").toString("base64"))}))`;
}

export function buildWindowsBootstrap({ executable, repoRoot, resultPath, environment = process.env, background = false }) {
  const assignments = Object.entries(independentEnvironment(environment))
    .map(([name, value]) => `$env:${name} = ${decodeExpression(value)}`)
    .join("\n");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$executable = ${decodeExpression(executable)}`,
    `$repoRoot = ${decodeExpression(repoRoot)}`,
    `$electronArguments = ${decodeExpression([repoRoot, ...(background ? ["--background"] : [])].map(quoteWindowsArgument).join(" "))}`,
    `$resultPath = ${decodeExpression(resultPath)}`,
    "try {",
    assignments ? assignments.split("\n").map((line) => `  ${line}`).join("\n") : "",
    `  $started = Start-Process -FilePath $executable -ArgumentList $electronArguments -WorkingDirectory $repoRoot${background ? " -WindowStyle Hidden" : ""} -PassThru`,
    "  $payload = @{ ok = $true; pid = $started.Id } | ConvertTo-Json -Compress",
    "} catch {",
    "  $payload = @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress",
    "}",
    "[IO.File]::WriteAllText($resultPath, $payload, [Text.UTF8Encoding]::new($false))"
  ].filter(Boolean).join("\n");
}

export function buildWindowsCimInvocation({ bootstrapScript, powershellPath }) {
  const commandLine = [
    powershellPath,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodePowerShell(bootstrapScript)
  ].map(quoteWindowsArgument).join(" ");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$startup = New-CimInstance -ClassName Win32_ProcessStartup -Namespace root/cimv2 -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
    `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${decodeExpression(commandLine)}; ProcessStartupInformation = $startup }`,
    "$result | Select-Object ReturnValue, ProcessId | ConvertTo-Json -Compress"
  ].join("\n");
  return {
    executable: powershellPath,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)]
  };
}

export function buildPosixInvocation({ executable, repoRoot, background = false }) {
  return {
    executable,
    args: [repoRoot, ...(background ? ["--background"] : [])],
    options: {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      env: process.env
    }
  };
}

async function waitForResult(resultPath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(resultPath)) {
      const content = readFileSync(resultPath, "utf8");
      if (content.trim()) return JSON.parse(content);
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error("Windows 独立启动器未在限定时间内返回 Electron PID。请检查 WMI/CIM 服务是否可用。");
}

async function confirmProcess(pid, confirmationMs = DEFAULT_CONFIRMATION_MS) {
  const deadline = Date.now() + confirmationMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) throw new Error(`ProfilePilot 独立进程 ${pid} 在启动确认期间提前退出。`);
    await delay(POLL_INTERVAL_MS);
  }
  if (!isProcessAlive(pid)) throw new Error(`ProfilePilot 独立进程 ${pid} 未能保持运行。`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runningProfilePilot(repoRoot) {
  const cliPath = path.join(repoRoot, "dist", "main", "profilepilot-cli.cjs");
  if (!existsSync(cliPath)) return null;
  const checked = spawnSync(process.execPath, [cliPath, "status", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000
  });
  if (checked.status !== 0) return null;
  try {
    const parsed = JSON.parse(String(checked.stdout || "{}"));
    const pid = Number(parsed?.data?.pid);
    return parsed?.ok && Number.isSafeInteger(pid) && isProcessAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function launchOnWindows(executable, repoRoot, background) {
  const powershellPath = path.join(process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const resultPath = path.join(os.tmpdir(), `profilepilot-independent-${process.pid}-${randomUUID()}.json`);
  try {
    const bootstrapScript = buildWindowsBootstrap({ executable, repoRoot, resultPath, background });
    const invocation = buildWindowsCimInvocation({ bootstrapScript, powershellPath });
    const launched = spawnSync(invocation.executable, invocation.args, {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000
    });
    if (launched.error) throw launched.error;
    if (launched.status !== 0) {
      throw new Error(`WMI/CIM 启动失败：${String(launched.stderr || launched.stdout || `exit ${launched.status}`).trim()}`);
    }
    const cim = JSON.parse(String(launched.stdout || "{}").trim());
    if (Number(cim.ReturnValue) !== 0 || !Number.isSafeInteger(Number(cim.ProcessId))) {
      throw new Error(`WMI/CIM 未能创建独立启动器：${String(launched.stdout).trim()}`);
    }
    const result = await waitForResult(resultPath);
    if (!result?.ok || !Number.isSafeInteger(Number(result.pid))) {
      throw new Error(`独立启动器未能启动 ProfilePilot：${result?.error || "未知错误"}`);
    }
    const pid = Number(result.pid);
    await confirmProcess(pid);
    return { pid, method: "windows-wmi-bootstrap" };
  } finally {
    rmSync(resultPath, { force: true });
  }
}

async function launchOnPosix(executable, repoRoot, background) {
  const invocation = buildPosixInvocation({ executable, repoRoot, background });
  const child = spawn(invocation.executable, invocation.args, invocation.options);
  child.unref();
  if (!Number.isSafeInteger(child.pid)) throw new Error("独立启动器没有返回 Electron PID。");
  await confirmProcess(child.pid);
  return { pid: child.pid, method: process.platform === "darwin" ? "darwin-detached-session" : "posix-detached-session" };
}

export async function main() {
  const background = process.argv.includes("--background");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const executable = process.platform === "win32"
    ? path.join(repoRoot, "node_modules", "electron", "dist", "electron.exe")
    : process.platform === "darwin"
      ? path.join(repoRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron")
      : path.join(repoRoot, "node_modules", "electron", "dist", "electron");
  if (!existsSync(executable)) throw new Error(`找不到 Electron 可执行文件：${executable}`);
  const existingPid = runningProfilePilot(repoRoot);
  if (existingPid) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      platform: process.platform,
      executable,
      pid: existingPid,
      method: "already-running"
    }, null, 2)}\n`);
    return;
  }
  const launched = process.platform === "win32"
    ? await launchOnWindows(executable, repoRoot, background)
    : await launchOnPosix(executable, repoRoot, background);
  process.stdout.write(`${JSON.stringify({ ok: true, platform: process.platform, executable, background, ...launched }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[ProfilePilot] 独立启动失败：${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
