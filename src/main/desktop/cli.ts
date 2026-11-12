import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { ProfilePilotManagementCommand, ProfilePilotManagementResponse } from '../profilepilot-management-protocol';
import { desktopCommandSchema, type DesktopCommand } from './service';
import { commandGuidance, handleControlCliDiscovery, type ControlCliCommands } from '../control-cli-contract';
import { desktopRouting } from '../control-routing';
import { desktopActionJsonSchema } from './schema';

export const desktopCommands: ControlCliCommands = {
  status: { summary: '只读查询平台、组件与当前占用', options: ['--json', '--session'], example: ['status'] },
  windows: { summary: '只读发现真实窗口 ID', options: ['--json', '--session'], example: ['windows'] },
  doctor: { summary: '只读检查指定窗口和跨入口占用', options: ['--json', '--window', '--session'], example: ['doctor'] },
  claim: { summary: '取得窗口控制；background 仅允许后台语义操作', options: ['--json', '--session', '--window', '--mode'], required: ['--session', '--window'], example: ['claim', '--session', 'TASK', '--window', 'WINDOW_ID_FROM_WINDOWS', '--mode', 'background'], notes: ['mode: interactive（默认）或 background；会话创建后不可更改。后台模式不切前台、不发送物理输入；使用目标应用时暂停，操作其他应用时继续。'] },
  select: { summary: '同一会话选择真实窗口', options: ['--json', '--session', '--window'], required: ['--session', '--window'], example: ['select', '--session', 'TASK', '--window', 'WINDOW_ID_FROM_WINDOWS'] },
  observe: { summary: '读取控件与新的观察版本', options: ['--json', '--session'], required: ['--session'], example: ['observe', '--session', 'TASK'] },
  screenshot: { summary: '保存截图和新观察版本', options: ['--json', '--session', '--output', '--image-only'], required: ['--session'], example: ['screenshot', '--session', 'TASK', '--output', './screen.png'] },
  wait: { summary: '只读等待精确匹配的控件', options: ['--json', '--session', '--name', '--role', '--automation-id', '--text', '--has-action', '--timeout-ms', '--interval-ms'], required: ['--session'], example: ['wait', '--session', 'TASK', '--name', '保存'], notes: ['至少一个匹配条件；timeout-ms 100–20000，interval-ms 100–2000；超时后重新观察。'] },
  action: { summary: '执行一次动作，等待并返回新观察', options: ['--json', '--session', '--params-file', '--params-stdin', '--request-id', '--observe', '--no-observe'], required: ['--session'], example: ['action', '--session', 'TASK', '--params-file', './action.json'],
    input: desktopActionJsonSchema(),
    notes: ['params-file 与 params-stdin 二选一；JSON 例：{"kind":"invoke","ref":"e1","version":"FROM_OBSERVE"}。', '每种 kind 仅接受相关字段；坐标须来自本次截图，ref 与 x/y 不能并用。', 'set_value 需 value（允许空串）；type_text 非空最多 512 UTF-16 单元；press_key 需 keys；drag 需 toX/toY；wheel 需非零 delta；scroll 需非 NoAmount(2) 方向。', '动作成功后默认等待 500ms 并获取新版本；--no-observe 跳过。观察失败不表示动作未执行，不能重放动作。'] },
  receipt: { summary: '只读查询动作回执，不重放', options: ['--json', '--session', '--request-id'], required: ['--session', '--request-id'], example: ['receipt', '--session', 'TASK', '--request-id', 'UUID_FROM_ACTION'] },
  handoff: { summary: '交给用户', options: ['--json', '--session'], required: ['--session'], example: ['handoff', '--session', 'TASK'] },
  resume: { summary: '仅在用户明确交还后恢复原会话', options: ['--json', '--session'], required: ['--session'], example: ['resume', '--session', 'TASK'] },
  complete: { summary: '完成会话', options: ['--json', '--session', '--require-active'], required: ['--session'], example: ['complete', '--session', 'TASK', '--require-active'] },
  release: { summary: '取消会话', options: ['--json', '--session'], required: ['--session'], example: ['release', '--session', 'TASK'] }
};

export const desktopHelp = `ppilot desktop · 本机 Windows 桌面控制
  status | windows [--json]                       状态 / 当前桌面窗口
  doctor [--window ID]                            只读检查前台、权限及跨入口占用
  claim --session TASK --window ID                独占控制桌面，选择实际窗口
        [--mode background|interactive]           后台语义 / 前台交互（默认），会话内不可更改
  select --session TASK --window ID               切换同一任务的目标窗口
  observe --session TASK                          读取 UI Automation 控件
  wait --session TASK --name NAME                 等待控件出现或状态文本变化
       [--role ROLE] [--automation-id ID] [--text TEXT] [--has-action ACTION]
       [--timeout-ms 10000] [--interval-ms 250]    精确匹配所给条件，只读轮询
  screenshot --session TASK [--output FILE]        截图并返回最新观察版本
             [--image-only]                      跳过 UIA 控件遍历，只取画面
  action --session TASK --params-file FILE        执行操作（也支持 --params-stdin）
         [--no-observe]                          默认等待 500ms 并回传新的 UIA observation
  receipt --session TASK --request-id UUID        只读查询已保留回执（会话结束后也可查）
  handoff | resume --session TASK                 交给用户 / 用户明确交还后恢复
  complete | release --session TASK               完成 / 取消控制
  complete --session TASK --require-active        仅在仍然控制中时完成；接管后保留暂停会话

所有命令支持 --json。需要 ProfilePilot 应用运行，无需 ClipRelay、MCP 或管理员权限。
有值参数也可写成 --name=VALUE；匹配以 -- 开头的文本请用 --text=--literal，空文本可用 --text=。布尔开关不接受 =VALUE。
windows 返回 enabled/minimized 状态及 ownerNativeHandle（Win32 所属窗口关系）；用于定位弹窗，不代表控制权限或必为模态窗口。
action JSON: {"version":"最新观察版本","ref":"e1","kind":"invoke"}
窗口状态：restore / minimize / maximize 只接受所选窗口根的 ref/version，并要求 WindowPattern 支持；restore 表示普通状态 Normal，不保证恢复此前最大化状态。
窗口状态成功需 UIA 与 Win32 独立回读一致；不保证前台焦点，也不授权沿用旧截图坐标。失败或结果未知时不自动重试。
操作：invoke、set_value(value)、toggle、select、expand、collapse、scroll(horizontal/vertical:0..4)、focus、click、double_click、move、drag(toX/toY)、wheel(deltaX/deltaY)、type_text(value)、press_key(keys: ["CTRL","A"])。
press_key 支持 A-Z、0-9、F1-F12，以及 CTRL/CONTROL、ALT、SHIFT、ENTER、TAB、ESC/ESCAPE、BACKSPACE、DELETE、LEFT、UP、RIGHT、DOWN、HOME、END、PAGEUP、PAGEDOWN、SPACE（不区分大小写）；同一组合键不能重复包含同一个键或其别名。
指针起点使用 ref 或 x/y；坐标输入及 drag 必须先 screenshot，x/y/toX/toY 是窗口原始物理像素，button 为 left/right/middle。
wheel 的 deltaX/deltaY 各限 -1200..1200，至少一个非零；120 表示一格，正 Y 向上，正 X 向右。
有 captureRect 时：x = captureRect.x + 图片像素X * captureRect.width / image.width，y 同理。
若 image.coordinateInputAvailable 为 false，请使用控件引用或 browser/electron 页面入口，不使用截图坐标。
每次操作消耗观察版本；action 默认回传下一版本，后续动作使用 observation.version。
type_text 每次最多 512 个 UTF-16 单元且不接受未配对代理项；长文本优先使用控件支持的 set_value（最多 16384），或分段并重新观察。
键盘逐字符组检查焦点仍不能保证应用异步处理期间永不改变焦点；中断后核对实际结果，不重放整段。
inputObservation 的 arming/pending 状态不授权输入；检测到外部输入或观察器中断会暂停，只有明确交还后才能 resume。
--observe 保留兼容；--no-observe 跳过自动观察。观察失败仍返回 actionOutcome:completed、observationStatus:unavailable 和 observationError，不能因此重放操作。
wait 至少提供 name/role/automation-id/text/has-action 之一；--text '' 等待成功读到的空文本，密码 name/text 不参与匹配。
wait 只匹配完整可读字段；检查 truncatedFields/textStatus，textSource 区分 Value 与 TextPattern；可读 Value 的 state.valueEvidence 为 unconfirmed 或 stateGaps 含 value_evidence 时不能用该引用输入。
--has-action 检查控件实际报告的能力（包括 text），不代表当前可输入；text 不是 action kind。
wait 超时上限 20000ms，返回 timedOut:true、requiresObservation:true（退出码 75）；可能没有最后观察。即使超时发生在两次读取之间，旧版本也不能继续操作，须重新 observe。
wait 不重放输入；超时观察仅供核查。接管或停止会立即取消等待。
--request-id UUID 可查询相同操作的回执，不得更改参数或观察开关。返回的旧 observation 不能当作新画面。
receipt 返回 pending/succeeded/failed，不触发输入或延长会话。回执丢失不表示动作未执行；应用重启或超过 256 条保留上限会丢失旧回执。
默认闲置 5 分钟结束。应用的桌面控制条可随时接管/停止；status.stopShortcutAvailable 为 true 时 Ctrl+Alt+Esc 也可停止。
暂停、超时或断线后先检查状态，不自动恢复或重复输入。macOS 暂不支持原生桌面控制。
退出码：0 成功，2 参数错误，69 服务不可用，75 控制权/旧观察/结果待核查，1 其他错误。
`;
type Request = (command: ProfilePilotManagementCommand) => Promise<ProfilePilotManagementResponse>;
export async function runDesktopCli(args: string[], request: Request, io: Pick<NodeJS.Process, 'stdout' | 'stderr'> = process, input: Readable = process.stdin, home = os.homedir()): Promise<number> {
  const write = (value: unknown) => io.stdout.write(JSON.stringify(value, null, args.includes('--json') ? undefined : 2) + '\n');
  try {
    if (handleControlCliDiscovery('desktop', args, desktopCommands, io)) return 0;
    if (!args.length || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') { io.stdout.write(desktopHelp); return 0; }
    const method = args[0];
    const options = new Map<string, string | true>();
    for (let i = 1; i < args.length; i++) {
      const equals = args[i].indexOf('='), key = equals < 0 ? args[i] : args[i].slice(0, equals);
      if (!['--session', '--window', '--mode', '--output', '--params-file', '--params-stdin', '--request-id', '--json', '--image-only', '--observe', '--no-observe', '--require-active', '--name', '--role', '--automation-id', '--text', '--has-action', '--timeout-ms', '--interval-ms'].includes(key) || options.has(key)) throw new Error('未知或重复参数：' + key);
      if (['--json', '--params-stdin', '--image-only', '--observe', '--no-observe', '--require-active'].includes(key)) {
        if (equals >= 0) throw new Error(key + ' 是布尔开关，不接受值。');
        options.set(key, true);
      } else {
        const value = equals < 0 ? args[++i] : args[i].slice(equals + 1);
        if (value === undefined || (value === '' && key !== '--text') || (equals < 0 && value.startsWith('--'))) throw new Error(key + ' 需要值。');
        options.set(key, value);
      }
    }
    if (!Object.hasOwn(desktopCommands, method)) throw new Error('未知桌面命令：' + method);
    const allowed = new Set(desktopCommands[method].options);
    for (const key of options.keys()) if (!allowed.has(key)) throw new Error(method + ' 不支持 ' + key);
    if (options.has('--observe') && options.has('--no-observe')) throw new Error('--observe 与 --no-observe 不能同时使用。');
    let params: unknown;
    if (method === 'action') {
      if (options.has('--params-file') === options.has('--params-stdin')) throw new Error('请选择 --params-file 或 --params-stdin。');
      let text = '';
      if (options.has('--params-file')) {
        const file = String(options.get('--params-file'));
        if ((await fs.stat(file)).size > 65536) throw new Error('操作文件超过 64 KiB。');
        text = await fs.readFile(file, 'utf8');
      } else {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of input) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 65536) throw new Error('操作参数超过 64 KiB。'); chunks.push(bytes); }
        text = Buffer.concat(chunks).toString('utf8');
      }
      params = JSON.parse(text.replace(/^\uFEFF/, ''));
    }
    const integerOption = (name: string) => {
      if (!options.has(name)) return undefined;
      const value = String(options.get(name));
      if (!/^\d+$/.test(value)) throw new Error(name + ' 需要整数毫秒。');
      return Number(value);
    };
    const condition = method === 'wait' ? Object.fromEntries([
      ['name', '--name'], ['role', '--role'], ['automationId', '--automation-id'], ['text', '--text'], ['hasAction', '--has-action']
    ].filter(([, flag]) => options.has(flag)).map(([field, flag]) => [field, options.get(flag)])) : undefined;
    const command: DesktopCommand = desktopCommandSchema.parse({ action: 'desktop', method, session: options.get('--session'), windowId: options.get('--window'), params, condition,
      mode: options.get('--mode'), timeoutMs: integerOption('--timeout-ms'), intervalMs: integerOption('--interval-ms'),
      requestId: method === 'action' ? options.get('--request-id') || randomUUID() : method === 'receipt' ? options.get('--request-id') : undefined,
      screenshotOnly: options.has('--image-only') || undefined, observeAfter: method === 'action' ? !options.has('--no-observe') : undefined,
      requireActive: options.has('--require-active') || undefined });
    if (!['status', 'windows', 'doctor'].includes(method) && !command.session) throw new Error('需要 --session 任务名。');
    if (['claim', 'select'].includes(method) && !command.windowId) throw new Error('需要 --window ID。');
    let response: ProfilePilotManagementResponse;
    try { response = await request(command); }
    catch (error) {
      const input = command.method === 'action';
      write({ ok: false, code: input ? 'DESKTOP_OUTCOME_UNKNOWN' : 'DESKTOP_CONNECTION_UNAVAILABLE',
        message: input ? '连接中断，操作结果待核查。请检查窗口和控制状态，不要重放输入。' : '无法连接 ProfilePilot，请确认桌面应用正在运行。', requestId: command.requestId });
      return input ? 75 : 69;
    }
    if (!response.ok) {
      const { code, message, details } = response.error; write({ ok: false, code, message, details, requestId: command.requestId });
      return /BAD_REQUEST|INVALID_ARGUMENTS/.test(code) ? 2 : /PLATFORM_UNAVAILABLE|HELPER_MISSING|SERVICE_UNAVAILABLE/.test(code) ? 69 : /BUSY|STALE|CHANGED|ENDED|CONTROL|CONFLICT|UNKNOWN|UNCONFIRMED|LOCKED|UNAVAILABLE|INTERRUPTED|RESPONSE_TOO_LARGE|SCREENSHOT_REQUIRED|FRESH_OBSERVATION_REQUIRED|INPUT_OBSERVER_PENDING|FOCUS_REQUIRED|OCCLUDED|USER_STOPPED|BACKGROUND_TARGET_ACTIVE/.test(code) ? 75 : 1;
    }
    const result = response.data as any;
    if (result?.image?.data) {
      const output = options.get('--output') ? path.resolve(String(options.get('--output'))) : path.join(home, '.profilepilot', 'desktop', 'artifacts', randomUUID() + '.jpg');
      if (!options.has('--output')) await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, Buffer.from(result.image.data, 'base64'), { flag: 'wx', mode: 0o600 });
      const { data, ...metadata } = result.image; result.image = { ...metadata, path: output };
    }
    write({ ok: true, result, requestId: command.requestId,
      ...(['status', 'doctor'].includes(method) ? { routing: desktopRouting(result, command.session, command.windowId) } : {}) }); return method === 'wait' && result?.timedOut ? 75 : 0;
  } catch (error) { write({ ok: false, code: 'DESKTOP_INVALID_ARGUMENTS', message: error instanceof Error ? error.message : String(error), guidance: commandGuidance('desktop', args[0], desktopCommands) }); return 2; }
}
