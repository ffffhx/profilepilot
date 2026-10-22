export const BROWSER_CONTRACT_VERSION = 1;
export const COMMON_BROWSER_ACTIONS = ["click", "hover", "fill", "select", "check", "uncheck", "press", "scroll", "upload"] as const;
export interface CommonBrowserAction {
  kind: typeof COMMON_BROWSER_ACTIONS[number]; version: string; ref?: string; value?: string; files?: string[];
}
export function parseCommonBrowserAction(value: unknown): CommonBrowserAction {
  const p = value as CommonBrowserAction;
  const invalid = (message: string): never => { throw Object.assign(new Error(message), { code: "BROWSER_INVALID_ARGUMENTS" }); };
  if (!p || typeof p !== "object" || Array.isArray(p)) invalid("action 参数必须是 JSON 对象。");
  if (!(COMMON_BROWSER_ACTIONS as readonly string[]).includes(p.kind)) invalid(`action.kind 必须为 ${COMMON_BROWSER_ACTIONS.join("、")}。`);
  if (typeof p.version !== "string" || !p.version || p.version.length > 200) invalid("action 需要最近 observe 返回的 version；不要从失败结果提取引用。");
  if (p.ref !== undefined && (typeof p.ref !== "string" || !/^@?(?:e\d+|f\d+e\d+)$/.test(p.ref))) invalid("ref 必须是本次 observe 返回的元素引用。");
  if (!["press", "scroll"].includes(p.kind) && !p.ref) invalid(`${p.kind} 需要 ref。`);
  if (["fill", "select", "press"].includes(p.kind) && typeof p.value !== "string") invalid(`${p.kind} 需要字符串 value（fill 允许空字符串）。`);
  if (p.kind === "scroll" && p.value !== undefined && !["up", "down", "left", "right"].includes(p.value)) invalid("scroll.value 必须为 up/down/left/right。");
  if (p.kind === "upload" && (!Array.isArray(p.files) || !p.files.length || p.files.length > 64 || p.files.some(f => typeof f !== "string" || !f || f.includes("\0")))) invalid("upload 需要 1–64 个明确选择的本地绝对文件路径 files。");
  return { kind: p.kind, version: p.version, ...(p.ref !== undefined ? { ref: p.ref } : {}), ...(p.value !== undefined ? { value: p.value } : {}), ...(p.files ? { files: [...p.files] } : {}) };
}

export const browserContract = {
  version: BROWSER_CONTRACT_VERSION,
  operations: {
    observe: { result: ["version", "at", "url", "snapshot", "fast.candidates", "availability"], input: { screenshot: "boolean (optional)" }, output: "--output PNG_PATH (optional)" },
    action: { required: ["kind", "version"], kinds: COMMON_BROWSER_ACTIONS, parameters: { ref: "observation element reference", value: "text/value/key/direction", files: "absolute paths for upload" } },
    screenshot: { result: ["path or image data", "capturedAt"], coordinateObservation: false }
  },
  rules: { input: "UTF-8 JSON via --params-file/--params-stdin/--params", consumeVersionAfterAction: true, automaticReplay: false, automaticResume: false },
  examples: [
    { kind: "fill", version: "FROM_OBSERVE", ref: "e1", value: "中文文本" },
    { kind: "upload", version: "FROM_OBSERVE", ref: "e2", files: ["ABSOLUTE_FILE_PATH"] }
  ]
} as const;
export const commonBrowserHelp = `Common contract v${BROWSER_CONTRACT_VERSION} (extension / Gateway / Electron):
  capabilities | schema                    Local command/capability contract
  observe [--output PATH]                   JSON DOM, version, refs and availability
  action --params-file ACTION.json          ${COMMON_BROWSER_ACTIONS.join(" | ")}
  action --params-stdin                     UTF-8 JSON; no shell escaping of values
Every action carries the current observe version. Reobserve after each action.
PowerShell legacy commands must quote refs, e.g. click '@e3'; prefer JSON files.
Native CDP and existing route-specific commands remain available.
`;
