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
  open: { usage: "open URL", description: "在当前任务页打开 HTTP/HTTPS、chrome-extension:// 或 chrome:// 地址。" },
  doctor: { usage: "doctor", description: "只读检查当前路由的连接与控制准备状态。", note: "扩展连接返回 connectionDiagnostics 历史证据和日志路径。离线时从扩展弹窗导出连接诊断；无法读取版本不表示需要更新，缺少日志不表示崩溃。" },
  readiness: { usage: "readiness", description: "只读检查当前路由的连接与控制准备状态。", note: "扩展离线或尚未上报时，版本与能力尚无法确认；不据此判定需要更新。" },
  cdp: { usage: "cdp METHOD --params-file PARAMS.json", description: "在已授权的目标内执行 CDP；先检查实际协议能力。", note: "不确定写操作结果时检查状态，不重放。" }
};
const extension: Record<string, CommandContract> = {
  ...common,
  install: { usage: "install [--json]", description: "macOS：为本机 Chrome Default 准备并打开持久安装，等待 Chrome 记录安装且扩展在线。首次加载及配对由用户确认。" },
  tabs: { usage: "tabs", description: "列出当前 Profile 已有标签页。" },
  claim: { usage: "claim [--tab ID | --new-tab] [--controller NAME] [--task TEXT]", description: "为本次任务取得所选 Profile 指定或新建标签页的控制权。", note: "支持多会话在同一 Profile 并发使用不同标签页；同一标签页已被占用或 Profile 处于用户接管状态时停止，不得换 Profile 绕过。" },
  newTab: { usage: "newTab [URL]", description: "在当前任务中创建标签页，可指定 HTTP/HTTPS、chrome-extension:// 或 chrome:// 地址。" },
  switch: { usage: "switch TAB_ID", description: "切换到实际 tabs 返回的标签页编号。" },
  read: { usage: "read --params-file READ.json", description: "按 frame、文本查询和分页读取页面。", input: { frameId: "可选，使用观察返回的 frame id", query: "可选文本", cursor: "可选当前分页游标", limit: "可选控件条数", textLimit: "可选文本长度" } },
  screenshot: { usage: "screenshot [--output PNG_PATH]", description: "保存当前截图；独立截图不授权坐标操作。" },
  pointer: { usage: "pointer --params-file POINTER.json", description: "使用带稳定截图的最近 observe version 执行坐标操作。", input: { kind: "click | hover", version: "FROM_OBSERVE", x: "number", y: "number" } },
  "wait-control": { usage: "wait-control [--timeout MILLISECONDS]", description: "等待原任务的控制状态变化；不会自动 resume。" }
};
const gateway: Record<string, CommandContract> = {
  ...common,
  cdp: { usage: "cdp call METHOD [--target TARGET_ID] [--params JSON | --params-stdin]", description: "在当前授权 Gateway 目标内执行受限 CDP。", note: "运行 cdp capabilities 查看允许的协议域；不确定写操作结果时检查状态，不重放。" },
  snapshot: { usage: "snapshot [-i] [-c] [--delta] [-d DEPTH] [-s SELECTOR]", description: "读取当前目标的结构化元素引用；-i 保留含可交互后代的地标/容器结构，--delta 返回与上一次快照的紧凑差异。" },
  screenshot: { usage: "screenshot [PNG_PATH] [--full] [--annotate]", description: "保存当前页面截图；--annotate 使用 CSP 安全的 Shadow DOM + adoptedStyleSheets 标注引用。" },
  read: {
    usage: "read [--query TEXT] [--cursor N] [--limit N] [--text-limit N] | read --params-file READ.json",
    description: "按查询条件、控件分页与文本上限读取当前授权页面或 frame。",
    input: { query: "可选过滤关键词", cursor: "可选分页起始游标（整数）", limit: "可选控件条数上限（默认 50）", textLimit: "可选正文字符数上限（默认 16000）" }
  },
  pointer: {
    usage: "pointer <click|dblclick|move|down|up|wheel|drag> X Y [END_X END_Y] | pointer --params-file POINTER.json",
    description: "在当前授权页面按视口坐标执行指针动作。",
    input: { kind: "click | dblclick | move | down | up | wheel | drag", x: "number", y: "number", toX: "number (drag)", toY: "number (drag)", deltaX: "number (wheel)", deltaY: "number (wheel)", button: "left | right | middle (optional)" }
  },
  dialog: {
    usage: "dialog [status] | dialog accept [PROMPT_TEXT] | dialog dismiss",
    description: "查看最近/挂起的原生 JS 弹窗（alert/confirm/prompt/beforeunload），或显式接受/关闭挂起弹窗。",
    input: { action: "status | accept | dismiss", promptText: "可选 prompt 输入文本" }
  },
  network: {
    usage: "network requests [--filter URL --type fetch,xhr --method POST --status 4xx --failed --since N --limit N] | network request ID [--offset N --text-limit N --no-body] | network clear | network route URL [--abort|--body TEXT] | network unroute [URL] | network routes | network har start|stop [PATH]",
    description: "在当前授权目标内查询网络请求、录制 HAR 或设置请求拦截规则。",
    input: { action: "requests | request | clear | route | unroute | routes | har" }
  },
  debug: {
    usage: "debug [start|status|stop] [--domains Network,Runtime,Log,Performance]",
    description: "管理当前授权标签页的调试采集生命周期（暂停/切换时自动解除 Fetch 与新 iframe 断点拦截）。",
    input: { action: "start | status | stop", domains: "Network | Runtime | Log | Performance" }
  },
  profiler: {
    usage: "profiler start | profiler stop [PATH]",
    description: "采集当前授权目标的 CDP 性能火焰图 JSON（与 trace 性能采集同源）。",
    input: { action: "start | stop", path: "可选输出文件路径" }
  },
  console: {
    usage: "console [--filter TEXT] [--level LEVEL] [--since CURSOR] [--limit N] [--details] [--clear]",
    description: "分页读取当前授权目标的控制台日志。",
    input: { filter: "可选文本过滤", level: "可选日志级别", since: "可选增量游标", limit: "可选条数上限", clear: "boolean" }
  },
  errors: {
    usage: "errors [--filter TEXT] [--since CURSOR] [--limit N] [--clear]",
    description: "分页读取当前授权目标的未捕获异常与错误日志。",
    input: { filter: "可选文本过滤", since: "可选增量游标", limit: "可选条数上限", clear: "boolean" }
  },
  trace: {
    usage: "trace start | trace stop [ZIP_PATH]",
    description: "录制或保存 Playwright/CDP 执行轨迹。",
    input: { action: "start | stop", path: "可选输出路径" }
  },
  tab: { usage: "tab list | tab new [URL] | tab close [ID] | tab ID", description: "管理当前授权连接中的标签页。" },
  get: { usage: "get text|html|value|count|box|styles SELECTOR | get attr SELECTOR ATTRIBUTE | get title|url", description: "读取当前目标的页面或元素属性。", example: "get attr '@e1' href" },
  click: { usage: "click SELECTOR [--new-tab]", description: "点击最近 snapshot 的引用或明确选择器。", example: "click '@e1'" },
  hover: { usage: "hover SELECTOR", description: "悬停于最近 snapshot 的引用或明确选择器。", example: "hover '@e1'" },
  fill: { usage: "fill SELECTOR TEXT", description: "替换输入框文本，允许空字符串。", example: "fill '@e1' '中文文本'" },
  eval: { usage: "eval JAVASCRIPT | eval --stdin", description: "在当前授权页面执行 JavaScript。" }
};
export const commandSchema: Record<BrowserConnection, Record<string, CommandContract>> = {
  extension,
  gateway
};
export function getCommandSchema(connection: BrowserConnection, command?: string): CommandContract | Record<string, CommandContract> | undefined {
  const table = commandSchema[connection];
  return command ? table[command] : table;
}
export function browserRouteCommands(connection: BrowserConnection): Record<string, CommandContract> { return commandSchema[connection]; }
export function browserCommandHelp(connection: BrowserConnection, command: string): string | undefined {
  const spec = browserRouteCommands(connection)[command];
  if (!spec) return;
  const prefix = command === "install" ? "ppilot browser" : connection === "extension" ? "ppilot browser --session TASK" : "ppilot browser --session TASK --cdp LOGICAL_PORT";
  return `${prefix} ${spec.usage}\n${spec.description}\n${spec.example ? `示例：${spec.example}\n` : ""}${spec.input ? `参数：${JSON.stringify(spec.input)}\n` : ""}${spec.note ? `${spec.note}\n` : ""}连接：${connection}。--json 可选。PowerShell 元素引用必须加引号，如 '@e1'。\n`;
}
export function extensionCommandHint(command: string): string | undefined {
  if (["get", "click", "fill", "hover", "snapshot", "tab"].includes(command)) return `当前使用 extension 连接，${command} 是 Gateway 命令。保持当前连接，使用 observe/read 读取 fast.candidates（含 href），使用 action --params-file ACTION.json 操作；运行 ppilot browser schema action 查看参数。`;
}
