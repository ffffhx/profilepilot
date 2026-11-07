import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { packageName } from "./inspection";
import { deviceShell } from "./adb";
import { streamAdb } from "./adb-cli-stream";
import type { ProfilePilotManagementCommand, ProfilePilotManagementResponse } from "../profilepilot-management-protocol";
import { readPhoneParams } from "./cli-input";
import { phoneAppParamsSchema } from "./cli-contract";
import { phoneErrorResult, phoneExitCode, phoneResponseError, phoneFailure } from "./errors";

export async function phoneAppCli(flags: Map<string, string>, request: (command: ProfilePilotManagementCommand) => Promise<ProfilePilotManagementResponse>, io: Pick<NodeJS.Process, "stdout" | "stderr">, stdin: Readable = process.stdin): Promise<number> {
  const id = flags.get("--device");
  if (!id) throw new Error("app 需要 --device。");
  const input = phoneAppParamsSchema.parse(await readPhoneParams(flags, 32768, stdin));
  packageName(input.packageName);
  const call = async <T>(method: string, params: unknown): Promise<T> => {
    const response = await request({ action: "phone", method, params });
    if (!response.ok) throw phoneResponseError(response); return response.data as T;
  };
  let lease: string | undefined, generation = 0, timer: NodeJS.Timeout | undefined, pulsing: Promise<void> | undefined, pulseError: Error | undefined;
  const artifacts: { remote: string; path: string; sha256: string; bytes: number }[] = [], evidence: { args: string[]; code: number; stdout: string; stderr: string }[] = [];
  const execute = async (args: string[]) => {
    if (pulseError) throw pulseError;
    const stdout: Buffer[] = [], stderr: Buffer[] = []; let bytes = 0;
    const capture = (into: Buffer[]) => ({ write(value: string | Buffer) { const chunk = Buffer.from(value); bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error("应用命令输出过大。"); into.push(chunk); return true; } });
    const code = await streamAdb(args, lease!, generation, request, { stdout: capture(stdout), stderr: capture(stderr) }, { timeoutMs: 600000 });
    const result = { args, code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }; evidence.push(result);
    if (code !== 0 || /(?:^|\n)(?:Error:|Failure\s*\[|Exception)/.test(result.stdout)) throw new Error(`Android 命令未成功（${code}）：${result.stderr || result.stdout}`);
    return result.stdout;
  };
  let failed = false;
  try {
    const owner = await call<{ lease: string; device: { transport?: string; state: { generation: number } } }>("wrapper-start", {
      id, mode: input.operation === "export" ? "view" : "control", backend: flags.get("--backend") || "app", controller: flags.get("--controller") || "ProfilePilot CLI", task: `应用 ${input.operation}: ${input.packageName}`
    }); lease = owner.lease;
    if (!owner.device?.state || !Number.isInteger(owner.device.state.generation)) throw phoneFailure("PHONE_RESPONSE_MISSING", "手机未返回有效控制会话；应用操作尚未提交。");
    generation = owner.device.state.generation;
    timer = setInterval(() => {
      if (pulsing || pulseError) return;
      pulsing = call("wrapper-pulse", { lease }).then(() => {}).catch(error => { pulseError = error; }).finally(() => { pulsing = undefined; });
    }, 1000);
    if (owner.device.transport === "internet") {
      if (input.operation !== "launch") throw phoneFailure("PHONE_OPERATION_UNSUPPORTED", "外网应用命令支持 launch；停止、卸载等操作请使用受控的手机系统界面。");
      await call("wrapper-internet-launch", { lease, generation, packageName: input.packageName });
    } else if (input.operation === "launch") {
      const resolution = await execute(["shell", "cmd", "package", "resolve-activity", "--brief", input.packageName]);
      const component = resolution.split(/\r?\n/).map(s => s.trim()).filter(s => /^[\w.]+\/[\w.$]+$/.test(s)).at(-1);
      if (!component || component.split("/")[0] !== input.packageName) throw phoneFailure("PHONE_APP_NOT_READY", "没有找到此应用的启动 Activity；未提交启动操作。");
      await execute(["shell", deviceShell(["am", "start", "-W", "-n", component])]);
    } else if (input.operation === "stop") await execute(["shell", "am", "force-stop", input.packageName]);
    else if (input.operation === "uninstall") await execute(["uninstall", ...(input.keepData ? ["-k"] : []), input.packageName]);
    else {
      const output = await execute(["shell", "pm", "path", input.packageName]);
      const lines = output.split(/\r?\n/).filter(Boolean);
      if (!lines.length || lines.some(line => !/^package:\/[^\x00-\x1f]+\.apk$/.test(line))) throw phoneFailure("PHONE_APP_NOT_READY", "无法确认完整 APK 路径；未创建导出目录。");
      const paths = lines.map(line => line.slice(8)), names = paths.map(remote => path.posix.basename(remote));
      if (names.some(name => /[<>:"\\|?*]/.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
          || new Set(names.map(name => name.toLowerCase())).size !== names.length) throw phoneFailure("PHONE_APP_NOT_READY", "APK 文件名不适合此导出目录或发生名称冲突；未开始导出。");
      const directory = path.resolve(input.outputDir);
      try { await fs.mkdir(directory); } // Exclusive: preserve an existing acquisition.
      catch { throw phoneFailure("PHONE_INVALID_REQUEST", "导出目录已存在或不可创建；未开始导出，请提供新目录。"); }
      for (let n = 0; n < paths.length; n++) {
        const local = path.join(directory, names[n]);
        await execute(["pull", paths[n], local]);
        const handle = await fs.open(local, "r");
        try {
          const hash = createHash("sha256"); let bytes = 0;
          for await (const chunk of handle.createReadStream({ autoClose: false })) { hash.update(chunk); bytes += chunk.length; }
          artifacts.push({ remote: paths[n], path: local, sha256: hash.digest("hex"), bytes });
        } finally { await handle.close(); }
      }
    }
    io.stdout.write(JSON.stringify({ ok: true, id, ...input, artifacts, evidence }, null, 2) + "\n"); return 0;
  } catch (error) {
    failed = true;
    const failure = phoneErrorResult(error, true);
    io.stdout.write(JSON.stringify({ ...failure, id, ...input, artifacts, evidence, coverage: artifacts.length ? "partial" : "none" }, null, 2) + "\n"); return phoneExitCode(failure.recovery);
  } finally {
    clearInterval(timer); await pulsing;
    if (lease) { try { await call("wrapper-stop", { lease }); } catch (error) { if (!failed) throw error; } }
  }
}
