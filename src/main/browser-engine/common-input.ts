import { readFileSync } from "node:fs";
import path from "node:path";
import { EngineError } from "./arguments";
import { parseCommonBrowserAction } from "../../shared/browser-contract";

/** Resolve files in the caller's cwd, not the persistent engine's startup cwd. */
export function normalizeCommonInput(args: string[], cwd = process.cwd(), stdin = () => readFileSync(0, "utf8")): string[] {
  const verb = args[0];
  if (!["observe", "action"].includes(verb)) return args;
  let payload: string | undefined, output: string | undefined;
  const invalid = (reason: string): never => { throw new EngineError(reason, "BROWSER_INVALID_ARGUMENTS"); };
  for (let i = 1; i < args.length; i++) {
    const split = args[i].indexOf("=");
    const flag = split < 0 ? args[i] : args[i].slice(0, split);
    const value = () => {
      const v = split < 0 ? args[++i] : args[i].slice(split + 1);
      if (!v || v.startsWith("--")) invalid(`${flag} 需要值。`);
      return v;
    };
    if (["--params", "--params-file", "--params-stdin"].includes(flag)) {
      if (payload !== undefined) invalid("只选择一种 JSON 输入方式。");
      try { payload = flag === "--params-stdin" ? stdin() : flag === "--params-file" ? readFileSync(path.resolve(cwd, value()), "utf8") : value(); }
      catch { invalid("无法读取参数文件或标准输入，请检查路径和权限。"); }
    } else if (flag === "--output" && verb === "observe") output = path.resolve(cwd, value());
    else invalid(`不支持 ${verb} 参数 ${flag}。`);
  }
  if (verb === "action" && payload === undefined) invalid("action 需要 --params-file、--params-stdin 或 --params。");
  if ((payload?.length || 0) > 4 * 1024 * 1024) invalid("JSON 输入过大。");
  let input: any;
  try { input = JSON.parse((payload || "{}").replace(/^\uFEFF/, "")); } catch { invalid("参数必须是有效的 UTF-8 JSON。"); }
  if (verb === "action") input = parseCommonBrowserAction(input);
  else if (!input || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).some(key => key !== "screenshot") || (input.screenshot !== undefined && typeof input.screenshot !== "boolean")) invalid("observe 仅接受可选的布尔值 screenshot。");
  return [verb, "--params", JSON.stringify(input), ...(output ? ["--output", output] : [])];
}
