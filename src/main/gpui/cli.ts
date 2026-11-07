import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProfilePilotManagementCommand, ProfilePilotManagementResponse } from '../profilepilot-management-protocol';
import { gpuiCommandSchema, gpuiAllowedTools } from './service';
import { z } from 'zod';
import { commandGuidance, handleControlCliDiscovery, type ControlCliCommands } from '../control-cli-contract';
import { gpuiRouting } from '../control-routing';

export const gpuiCommands: ControlCliCommands = {
  list: { summary: '只读发现已接入调试桥的 GPUI 实例', options: ['--json'], example: ['list'] },
  status: { summary: '只读查看后端和保留会话', options: ['--json'], example: ['status'] },
  doctor: { summary: '只读检查目标实例、后端和控制权', options: ['--json', '--target', '--session'], example: ['doctor'] },
  configure: { summary: '配置实际 gpui-mcp 后端路径', options: ['--json', '--backend'], required: ['--backend'], example: ['configure', '--backend', 'ABSOLUTE_BACKEND_PATH'], notes: ['Windows 使用 .exe，macOS 使用本机可执行文件；不照抄另一平台路径。'] },
  claim: { summary: '选择已发现的真实实例', options: ['--json', '--target', '--session'], required: ['--target', '--session'], example: ['claim', '--target', 'TARGET_ID_FROM_LIST', '--session', 'TASK'] },
  snapshot: { summary: '读取元素树与新 observation', options: ['--json', '--session'], required: ['--session'], example: ['snapshot', '--session', 'TASK'] },
  call: { summary: '在原会话中调用允许的 GPUI 工具', options: ['--json', '--session', '--tool', '--params-file', '--observation', '--output'], required: ['--session', '--tool'], example: ['call', '--session', 'TASK', '--tool', 'get_element', '--params-file', './element.json'],
    input: z.toJSONSchema(gpuiCommandSchema.shape.params.unwrap(), { io: 'input' }),
    notes: ['先用 ppilot gpui schema TOOL_NAME 读取已安装后端的实际参数 schema；例如 ppilot gpui schema click_element。此只读查询不选择实例或取得控制权。', '只读：ping/get_element/get_element_bounds/find_elements/screenshot/screenshot_element/screenshot_region/get_logs/get_frame_report/get_frame_stats/get_performance_report/list_app_commands/get_text_info/get_value/get_element_state。', '输入：click_element/double_click_element/hover_element/drag_element/focus_element/keyboard/type_text/set_text/set_value/scroll；调试：highlight_elements/clear_highlights/record_performance。输入及调试必须提供最新 --observation。', '参数文件 UTF-8（兼容 BOM），最大 64 KiB；--output 保存 PNG，文件已存在时不覆盖。'] },
  handoff: { summary: '交给用户并保留会话', options: ['--json', '--session'], required: ['--session'], example: ['handoff', '--session', 'TASK'] },
  'return-control': { summary: '按用户明确指令交还本次暂停会话', options: ['--json', '--session', '--pause-id'], required: ['--session', '--pause-id'], example: ['return-control', '--session', 'TASK', '--pause-id', 'PAUSE_ID_FROM_STATUS'], notes: ['用户在当前对话明确同意交还后调用，无需再到应用内点击。先核对 status 中的目标和会话。', 'pauseId 是暂停版本，不是授权凭证；调用方负责获得用户同意。再次接管、重启或会话重建会使旧 ID 失效，禁止自动循环恢复。成功后重新 snapshot。'] },
  resume: { summary: '核对原会话已恢复控制', options: ['--json', '--session'], required: ['--session'], example: ['resume', '--session', 'TASK'], notes: ['保留旧命令的状态检查行为；用户同意后的交还操作使用 return-control。'] },
  complete: { summary: '完成活动会话', options: ['--json', '--session'], required: ['--session'], example: ['complete', '--session', 'TASK'] },
  release: { summary: '取消活动会话', options: ['--json', '--session'], required: ['--session'], example: ['release', '--session', 'TASK'] }
};

export const gpuiHelp = `ppilot gpui · 通用 GPUI 调试（gpui-mcp bridge 协议 14）
  list | status                                      发现应用 / 查看会话
  doctor [--target TARGET_ID] [--session TASK]         只读诊断目标和控制权
  schema [COMMAND|TOOL_NAME]                         CLI 契约 / 后端真实工具 schema
  configure --backend ABSOLUTE_PATH                    选择本地 gpui-mcp 可执行文件
  claim --target TARGET_ID --session TASK              连接指定实例并显示控制条
  snapshot --session TASK                             读取元素树、边界和 observation
  call --session TASK --tool NAME [--params-file FILE]
       [--observation UUID] [--output FILE]             调试调用 / 保存截图
  handoff --session TASK                              暂停并交由用户控制
  return-control --session TASK --pause-id UUID       用户明确同意后交还本次暂停
  resume --session TASK                               核对会话是否已恢复
  complete | release --session TASK                   结束活动会话

支持 --json；参数接受 --name=VALUE。输入、标注和性能录制必须带最新 observation。
输入工具：click_element、double_click_element、hover_element、drag_element、keyboard、
type_text、set_text、set_value、scroll。参数沿用 gpui-mcp schema，例如 {"id":"button"}、
{"id":"input","text":"中文"}、{"keystroke":"ctrl-a"}。每次输入后重新 snapshot。
只读工具：ping、get_element、get_element_bounds、find_elements、screenshot、
screenshot_element、screenshot_region、get_logs、get_frame_report、get_frame_stats、
get_performance_report、list_app_commands、get_text_info、get_value、get_element_state。
调试工具：highlight_elements、clear_highlights、record_performance。
用户在当前对话明确同意后，读取 status 的 pauseId，用 return-control 交还同一会话。
无需重复点击应用。再次接管会产生新 pauseId，旧请求不能恢复；禁止自动循环交还。
超时 / 断线 / 接管后的在途操作可能已执行，不自动重放。退出码 75 表示需核查。
任意未接入调试桥的 GPUI 应用不会被发现。接入说明见 docs/gpui-debug.md。
`;
type Request = (command: ProfilePilotManagementCommand) => Promise<ProfilePilotManagementResponse>;
export async function runGpuiCli(args: string[], request: Request, io: Pick<NodeJS.Process, 'stdout' | 'stderr'> = process): Promise<number> {
  try {
    if (args[0] === 'schema' && args[1] && gpuiAllowedTools.includes(args[1])) {
      if (args.slice(2).some(arg => arg !== '--json') || args.filter(arg => arg === '--json').length > 1) throw new Error('工具 schema 仅接受 TOOL_NAME 和 --json。');
      const response = await request({ action: 'gpui', method: 'schema', tool: args[1] });
      if (!response.ok) { io.stderr.write(JSON.stringify({ ok: false, ...response.error }) + '\n'); return 69; }
      io.stdout.write(JSON.stringify({ ok: true, result: response.data }) + '\n'); return 0;
    }
    if (handleControlCliDiscovery('gpui', args, gpuiCommands, io)) return 0;
    if (!args.length || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') { io.stdout.write(gpuiHelp); return 0; }
    const method = args[0], values = new Map<string, string>(); let json = false;
    const permitted = Object.fromEntries(Object.entries(gpuiCommands).map(([name, definition]) => [name, definition.options.filter(option => option !== '--json').map(option => option.slice(2))]));
    if (!Object.hasOwn(permitted, method)) throw new Error('未知 GPUI 命令。');
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--json' && !json) { json = true; continue; }
      const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(args[i]);
      if (!match || !permitted[method].includes(match[1]) || values.has(match[1])) throw new Error('未知或重复参数：' + args[i]);
      const value = match[2] ?? args[++i];
      if (!value || match[2] === undefined && value.startsWith('--')) throw new Error('参数缺少值：' + match[1]);
      values.set(match[1], value);
    }
    for (const required of gpuiCommands[method].required || []) if (!values.has(required.slice(2))) throw new Error('需要参数：' + required);
    if (method === 'doctor') {
      const statusResponse = await request({ action: 'gpui', method: 'status' });
      if (!statusResponse.ok) { io.stderr.write(JSON.stringify({ ok: false, ...statusResponse.error }) + '\n'); return 69; }
      const listing = await request({ action: 'gpui', method: 'list' });
      const status = statusResponse.data, apps = listing.ok ? (listing.data as any)?.apps || [] : [];
      const routing = gpuiRouting(status, apps, values.get('target'), values.get('session'));
      io.stdout.write(JSON.stringify({ ok: true, result: { status, apps, ...(listing.ok ? {} : { discoveryError: listing.error }) }, routing }) + '\n'); return 0;
    }
    let params: Record<string, unknown> | undefined;
    if (values.has('params-file')) {
      const file = values.get('params-file')!;
      if ((await fs.stat(file)).size > 65536) throw new Error('参数文件超过 64 KiB。');
      params = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
    }
    const command = gpuiCommandSchema.parse({ action: 'gpui', method, session: values.get('session'), target: values.get('target'), backend: values.get('backend'), tool: values.get('tool'), observation: values.get('observation'), params, pauseId: values.get('pause-id') });
    const response = await request(command);
    if (!response.ok) {
      io.stderr.write(JSON.stringify(response.error) + '\n');
      return /PAUSED|OCCUPIED|STALE|UNKNOWN|INTERRUPTED|DISCONNECTED|BUSY/.test(response.error.code) ? 75 : /UNAVAILABLE/.test(response.error.code) ? 69 : 1;
    }
    const data = response.data as any;
    if (values.has('output')) {
      const output = path.resolve(values.get('output')!), blocks = data?.result?.content;
      const image = Array.isArray(blocks) && blocks.find((block: any) => block.type === 'image');
      if (!image || image.mimeType !== 'image/png' || typeof image.data !== 'string') throw new Error('该响应没有 PNG 图片；操作结果已返回，不应重复输入。');
      await fs.writeFile(output, Buffer.from(image.data, 'base64'), { flag: 'wx' });
      image.data = undefined; image.path = output;
    }
    io.stdout.write(JSON.stringify(method === 'status' ? { ...data, routing: gpuiRouting(data, [], undefined, undefined) } : data, null, json ? undefined : 2) + '\n'); return 0;
  } catch (error) { io.stderr.write(JSON.stringify({ code: 'GPUI_CLI_ERROR', message: (error as Error).message, guidance: commandGuidance('gpui', args[0], gpuiCommands) }) + '\n'); return 2; }
}
