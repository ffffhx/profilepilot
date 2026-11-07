import { readFileSync, appendFileSync, writeSync } from "node:fs";
import path from "node:path";
import { ENGINE_VERSION, engineHelp, parseEngineCommand } from "./arguments";
import { sendEngineCommand, serveEngine } from "./service";
import { normalizeCommonInput } from "./common-input";
import { controlRecovery } from "../../shared/control-recovery";
import { COMMON_BROWSER_ACTIONS } from "../../shared/browser-contract";

// An optional parent-only metadata pipe preserves inherited stdout and TTY
// behavior. Unsupported launchers simply omit it; diagnostics never fail input.
function traceReceipt(response: { success?: boolean; requestId?: string; code?: string; recovery?: unknown }, args: string[] = []): void {
  if (process.env.PROFILEPILOT_CONTROL_TRACE_FD !== "3") return;
  try {
    const kind = args[0] === "action" ? JSON.parse(args[2]).kind : args[0];
    const actionKind = (COMMON_BROWSER_ACTIONS as readonly string[]).includes(kind) ? kind : undefined;
    writeSync(3, JSON.stringify({ ok: response.success, requestId: response.requestId,
      code: response.code, recovery: response.recovery, actionKind }) + "\n");
  } catch { /* Parent channel is best effort. */ }
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  if (args[0] === "--engine-service") { await serveEngine(args[1], args[2]); return 0; }
  const command = parseEngineCommand(args);
  command.args = normalizeCommonInput(command.args);
  if (command.args[0] === "version") { process.stdout.write(`ProfilePilot TypeScript browser engine ${ENGINE_VERSION}\n`); return 0; }
  if (["help", "skills"].includes(command.args[0])) { process.stdout.write(engineHelp); return 0; }
  if (command.args[0] === "eval") {
    if (command.args[1] === "--stdin") command.args = ["eval", readFileSync(0, "utf8")];
    else if (["-b", "--base64"].includes(command.args[1])) command.args = ["eval", Buffer.from(command.args[2] || "", "base64").toString("utf8")];
  }
  if (command.args[0] === "batch" && command.args.includes("--stdin")) {
    command.args = ["batch", "--commands-json", readFileSync(0, "utf8"), ...(command.args.includes("--bail") ? ["--bail"] : [])];
  }
  const response = await sendEngineCommand(command);
  traceReceipt(response, command.args);
  if (["observe", "action"].includes(command.args[0])) process.stdout.write(JSON.stringify(response.success
    ? { ok: true, result: response.data, requestId: response.requestId }
    : { ok: false, code: response.code, message: response.error, recovery: response.recovery, requestId: response.requestId, partialResult: response.partialResult }) + "\n");
  else if (command.json || !response.success) process.stdout.write(JSON.stringify(response) + "\n");
  else {
    const data = response.data as any;
    const value = data?.snapshot ?? data?.text ?? data?.title ?? data?.url ?? data?.path ?? data?.result ?? data;
    process.stdout.write((typeof value === "string" ? value : JSON.stringify(value)) + "\n");
  }
  return response.success ? (response.data as any)?.failed ? 1 : 0 : response.code === "BROWSER_INVALID_ARGUMENTS" ? 64 : 1;
}
if (require.main === module) {
  void main().then(code => { process.exitCode = code; }).catch(error => {
    const code = error.code || "BROWSER_ENGINE_ERROR";
    const result = { ok: false, success: false, code, message: error.message || String(error), error: error.message || String(error), recovery: controlRecovery(code) };
    traceReceipt(result);
    if (process.argv[2] === "--engine-service") {
      try { appendFileSync(path.join(process.argv[3], `${process.argv[4]}.engine.log`), JSON.stringify(result) + "\n", { mode: 0o600 }); } catch {}
    }
    process.stderr.write(JSON.stringify(result) + "\n");
    process.exitCode = error.code === "BROWSER_INVALID_ARGUMENTS" ? 64 : 1;
  });
}
