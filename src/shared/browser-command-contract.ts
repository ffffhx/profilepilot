import { browserContract } from "./browser-contract";

export type BrowserConnection = "extension" | "gateway";
interface CommandContract { usage: string; description: string; input?: unknown; example?: string; note?: string; }
const lifecycle = Object.fromEntries(["status", "handoff", "resume", "complete", "release"].map(command => [command, {
  usage: command, description: command === "status" ? "读取连接、任务和控制权。" : "保持原任务会话；resume 必须由用户明确交还控制后调用。"
}])) as Record<string, CommandContract>;
const common: Record<string, CommandContract> = {
  default: { usage: "default [--json]", description: "读取浏览器页面保存的默认 Profile；不会启动应用或授予控制权限。", note: "用户本次指定的目标和已有任务会话优先；默认目标不可用时停止，不选择其他 Profile。" },
  ...lifecycle,
  schema: { usage: "schema [COMMAND]", description: "本地输出当前连接的命令契约；不会连接或操作浏览器。" },
  capabilities: { usage: "capabilities [COMMAND]", description: "本地输出当前连接的能力契约；实际准备状态请运行 doctor。" },
  observe: { usage: "observe [--output PNG_PATH]", description: "读取当前页面及 version/ref。", input: browserContract.operations.observe, note: "可选截图失败时检查 partialResult / availability；不得使用旧图片。" },
  action: { usage: "action --params-file ACTION.json | action --params-stdin", description: "使用最近观察的 version/ref 操作；不会自动重放。", input: browserContract.operations.action, example: '{"kind":"click","version":"FROM_OBSERVE","ref":"e1"}' },
  open: { usage: "open URL", description: "在当前任务页打开 HTTP/HTTPS 地址。" },
  doctor: { usage: "doctor", description: "只读检查当前路由的连接与控制准备状态。", note: "扩展连接返回 connectionDiagnostics 历史证据和日志路径。离线时从扩展弹窗导出连接诊断；无法读取版本不表示需要更新，缺少日志不表示崩溃。" },
  readiness: { usage: "readiness", description: "只读检查当前路由的连接与控制准备状态。", note: "扩展离线或尚未上报时，版本与能力尚无法确认；不据此判定需要更新。" },
  cdp: { usage: "cdp METHOD --params-file PARAMS.json", description: "在已授权的目标内执行 CDP；先检查实际协议能力。", note: "不确定写操作结果时检查状态，不重放。" }
};
const extension: Record<string, CommandContract> = {
  ...common,
  tabs: { usage: "tabs", description: "列出当前 Profile 已有标签页。" },
  claim: { usage: "claim [--tab ID | --new-tab] [--controller NAME] [--task TEXT]", description: "为本次任务取得所选 Profile 的控制权。", note: "会话占用或用户接管时停止；不得换 Profile 绕过。" },
  newTab: { usage: "newTab [URL]", description: "在当前任务中创建标签页，可指定 HTTP/HTTPS 地址。" },
  switch: { usage: "switch TAB_ID", description: "切换到实际 tabs 返回的标签页编号。" },
  read: { usage: "read --params-file READ.json", description: "按 frame、文本查询和分页读取页面。", input: { frameId: "可选，使用观察返回的 frame id", query: "可选文本", cursor: "可选当前分页游标", limit: "可选控件条数", textLimit: "可选文本长度" } },
  screenshot: { usage: "screenshot [--output PNG_PATH]", description: "保存当前截图；独立截图不授权坐标操作。" },
  pointer: { usage: "pointer --params-file POINTER.json", description: "使用带稳定截图的最近 observe version 执行坐标操作。", input: { kind: "click | hover", version: "FROM_OBSERVE", x: "number", y: "number" } },
  "wait-control": { usage: "wait-control [--timeout MILLISECONDS]", description: "等待原任务的控制状态变化；不会自动 resume。" }
};
const gateway: Record<string, CommandContract> = {
  ...common,
  cdp: { usage: "cdp call METHOD [--target TARGET_ID] [--params JSON | --params-stdin]", description: "在当前授权 Gateway 目标内执行受限 CDP。", note: "运行 cdp capabilities 查看允许的协议域；不确定写操作结果时检查状态，不重放。" },
  snapshot: { usage: "snapshot [-i] [-c] [-d DEPTH] [-s SELECTOR]", description: "读取当前目标的元素引用；导航或新快照后引用需重新读取。" },
  screenshot: { usage: "screenshot [PNG_PATH] [--full] [--annotate]", description: "保存当前页面截图。" },
  tab: { usage: "tab list | tab new [URL] | tab close [ID] | tab ID", description: "管理当前授权连接中的标签页。" },
  get: { usage: "get text|html|value|count|box|styles SELECTOR | get attr SELECTOR ATTRIBUTE | get title|url", description: "读取当前目标的页面或元素属性。", example: "get attr '@e1' href" },
  click: { usage: "click SELECTOR [--new-tab]", description: "点击最近 snapshot 的引用或明确选择器。", example: "click '@e1'" },
  hover: { usage: "hover SELECTOR", description: "悬停于最近 snapshot 的引用或明确选择器。", example: "hover '@e1'" },
  fill: { usage: "fill SELECTOR TEXT", description: "替换输入框文本，允许空字符串。", example: "fill '@e1' '中文文本'" },
  eval: { usage: "eval JAVASCRIPT | eval --stdin", description: "在当前授权页面执行 JavaScript。" }
};
export function browserRouteCommands(connection: BrowserConnection): Record<string, CommandContract> { return connection === "extension" ? extension : gateway; }
export function browserCommandHelp(connection: BrowserConnection, command: string): string | undefined {
  const spec = browserRouteCommands(connection)[command];
  if (!spec) return;
  const prefix = connection === "extension" ? "ppilot browser --session TASK" : "ppilot browser --session TASK --cdp LOGICAL_PORT";
  return `${prefix} ${spec.usage}\n${spec.description}\n${spec.example ? `示例：${spec.example}\n` : ""}${spec.input ? `参数：${JSON.stringify(spec.input)}\n` : ""}${spec.note ? `${spec.note}\n` : ""}连接：${connection}。--json 可选。PowerShell 元素引用必须加引号，如 '@e1'。\n`;
}
export function extensionCommandHint(command: string): string | undefined {
  if (["get", "click", "fill", "hover", "snapshot", "tab"].includes(command)) return `当前使用 extension 连接，${command} 是 Gateway 命令。保持当前连接，使用 observe/read 读取 fast.candidates（含 href），使用 action --params-file ACTION.json 操作；运行 ppilot browser schema action 查看参数。`;
}
