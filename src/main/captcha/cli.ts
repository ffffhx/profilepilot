import os from "node:os";
import path from "node:path";
import { readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { CaptchaBrowser, CaptchaBrowserOptions } from "./browser";
import { captchaBrowser } from "./browser";
import { captchaExpression } from "./page";
import { captchaKey, CaptchaError, createOnce, hash, twoCaptcha, type CaptchaProvider } from "./provider";
import { recognizeWithCodex } from "./codex";

export const captchaHelp = `ppilot browser [connection/session options] captcha COMMAND
  detect                         Inspect supported widgets; no paid API call
  solve [--selector CSS]         Solve one standalone widget and apply its token
  recognize --image-file FILE    Ask your signed-in Codex CLI to read an image
  balance                        Query your 2Captcha account balance (USD)
  submit --task-file FILE --request-id ID
                                 Submit a 2Captcha task object once; returns taskId
  result --task-id ID             Query once; explicitly returns solution/token

Prefer the current conversation's Agent for visible image/text puzzles:
  Extension: ppilot browser --session TASK observe --output challenge.png
  Read result.screenshotPath with the Agent host's image-viewing tool, then
  use action/pointer with that observation's refs/version. Observe after each
  action and verify the website's result. This path starts no extra model.
  Gateway: use the existing session's snapshot/screenshot/click/fill commands.
See the ProfilePilot skill references/captcha.md for the complete workflow.

recognize: --provider codex (default), --kind auto|text|grid (default auto),
  --instruction TEXT (optional puzzle question), --model NAME (optional).
  PNG/JPEG/WebP, max 10 MiB. Returns text or 1-based row-major grid tile numbers.
  No browser session needed; does not click, fill, submit or return a token.
  Unsupported/uncertain images return no answer. Check result.status, then
  observe the current challenge before using an answer; verified is always false.
  Uses the existing Codex login in CODEX_HOME and consumes its account quota.
  Personal Codex config/plugins are not loaded; uses Codex's built-in model
  default unless --model is set. Requires recent Codex CLI. Override executable
  with PROFILEPILOT_CAPTCHA_CODEX_BIN (binary or bin/codex.js, not .cmd/.bat).
  Temporary image/result files are removed. No automatic recognition retry.

Other commands use 2captcha (also --provider 2captcha).
Set PROFILEPILOT_CAPTCHA_API_KEY or PROFILEPILOT_CAPTCHA_API_KEY_FILE locally.
TWOCAPTCHA_API_KEY is accepted. Never pass keys in command arguments.
--timeout MS: solve/recognize budget, 1000-300000 (default 120000).
2Captcha solve polls every 5s; recognize stops its local process on timeout.
--state-dir DIR: receipt directory (default ~/.profilepilot/captcha).

Examples (detect/solve require an already claimed/connected session):
  ppilot browser --session TASK --profile native:Default captcha detect
  ppilot browser --session TASK --profile native:Default captcha solve
  ppilot browser --session TASK --cdp PORT captcha solve
  ppilot browser captcha balance
  ppilot browser captcha result --task-id 123456
  ppilot browser captcha recognize --image-file challenge.png --kind text
  ppilot browser captcha recognize --image-file grid.png --kind grid --instruction "Select buses"

solve supports main-document data-sitekey Turnstile / reCAPTCHA v2 widgets,
with response fields or a named data-callback. --selector selects the widget.
Dynamic/iframe widgets, Enterprise/v3 and full Cloudflare challenge pages need
site-specific adaptation; submit/result accepts provider task JSON for these.
No explicit form submit (page callbacks may submit), reload, UA/proxy change,
takeover resume or new tab.
applied means token delivered, NOT website verified. Observe the page afterward.
Paid requests use YOUR provider balance. Same challenge/request-id reuses its
taskId; creation failures/uncertain responses are never automatically retried.
Timeout/stop does not cancel the paid provider task. result can retrieve it.
submit/result does not change the browser. Reusing an ID with different JSON
is an error; a new request-id creates a new billable task. Keep receipt files.
`;

interface Route { connection: "extension" | "gateway"; args: string[]; commandIndex: number; port?: number; }
interface Runtime { provider?: CaptchaProvider; browser?: CaptchaBrowser; recognize?: typeof recognizeWithCodex; now?: () => number; sleep?: (ms: number) => Promise<void>; }
function invalid(message: string): never { throw new CaptchaError('CAPTCHA_INVALID_ARGUMENTS', message, 64); }

export async function runCaptchaCli(route: Route, io: Pick<NodeJS.Process, 'stdout' | 'stderr'>, env: NodeJS.ProcessEnv, runtime: Runtime = {}): Promise<number> {
  let taskId: number | undefined;
  try {
    const args = route.args.slice(route.commandIndex + 1);
    if (!args.length || args[0] === 'help' || args.includes('--help') || args.includes('-h')) { io.stdout.write(captchaHelp); return 0; }
    const command = args.shift()!;
    if (!['detect', 'solve', 'balance', 'submit', 'result', 'recognize'].includes(command)) invalid('未知验证码命令；运行 ppilot browser captcha --help。');
    const values = new Map<string, string>();
    const prefix = route.args.slice(0, route.commandIndex);
    function parse(input: string[], allowed: string[]) {
      for (let i = 0; i < input.length; i++) {
        const name = input[i].split('=', 1)[0];
        if (name === '--json') continue;
        if (!allowed.includes(name) || values.has(name)) invalid(`无效或重复参数：${name}`);
        const value = input[i].includes('=') ? input[i].slice(name.length + 1) : input[++i];
        if (!value || value.startsWith('--')) invalid(`${name} 需要参数。`);
        values.set(name, value);
      }
    }
    parse(prefix, ['--session', '--profile', '--root', '--cdp', '--target']);
    parse(args, ['--provider', ...(command === 'recognize' ? ['--image-file', '--kind', '--instruction', '--model', '--timeout']
      : ['--state-dir', ...(command === 'solve' ? ['--selector', '--timeout'] : command === 'submit' ? ['--task-file', '--request-id'] : command === 'result' ? ['--task-id'] : [])])]);
    const output = (value: unknown) => io.stdout.write(`${JSON.stringify({ ok: true, result: value })}\n`);
    if (command === 'recognize') {
      if ((values.get('--provider') || 'codex') !== 'codex') invalid('recognize 当前使用 --provider codex。');
      if (prefix.length || route.connection !== 'extension') invalid('recognize 只读取本地图片，不接受浏览器连接/session 参数。');
      if (!values.get('--image-file')) invalid('recognize 需要 --image-file 本地图片路径。');
      const kind = values.get('--kind') || 'auto';
      if (!['auto', 'text', 'grid'].includes(kind)) invalid('--kind 只能是 auto、text 或 grid。');
      output(await (runtime.recognize || recognizeWithCodex)({ imageFile: values.get('--image-file')!, kind: kind as 'auto' | 'text' | 'grid',
        instruction: values.get('--instruction'), model: values.get('--model'), timeout: Number(values.get('--timeout') || 120000) }, env));
      return 0;
    }
    if ((values.get('--provider') || env.PROFILEPILOT_CAPTCHA_PROVIDER || '2captcha') !== '2captcha') invalid('此命令使用 2captcha；Codex 图片识别请使用 captcha recognize。');
    if (route.connection === 'gateway' && (values.has('--profile') || values.has('--root'))) invalid('Gateway 用 --cdp 选择目标；--profile/--root 仅用于扩展连接。');
    if (route.connection === 'extension' && values.has('--target')) invalid('--target 仅用于 Gateway。');
    const root = values.get('--state-dir') || env.PROFILEPILOT_CAPTCHA_STATE_DIR || path.join(env.HOME || os.homedir(), '.profilepilot', 'captcha');
    const provider = () => runtime.provider || twoCaptcha(captchaKey(env));
    if (command === 'balance') { output({ provider: '2captcha', balance: await provider().balance(), currency: 'USD' }); return 0; }
    if (command === 'result') {
      const id = values.get('--task-id') || '';
      if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) invalid('--task-id 需要正整数。');
      taskId = Number(id);
      output({ provider: '2captcha', taskId, ...await provider().result(taskId) }); return 0;
    }
    if (command === 'submit') {
      const file = values.get('--task-file'), requestId = values.get('--request-id');
      if (!file || !requestId || !/^[\w.-]{1,128}$/.test(requestId)) invalid('submit 需要 --task-file 和唯一 --request-id（1–128 个字母/数字/点/下划线/连字符）。');
      let task;
      try {
        if (statSync(file).size > 2 * 1024 * 1024) invalid('task 文件超过 2 MiB。');
        task = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      } catch { invalid('无法读取 task 文件或 JSON 无效（最大 2 MiB）。'); }
      if (!task || Array.isArray(task) || typeof task !== 'object' || typeof task.type !== 'string' || !/^[A-Za-z0-9]+Task[A-Za-z0-9]*$/.test(task.type) || 'clientKey' in task) invalid('文件必须是 2Captcha task 对象（含 type），不能包含 clientKey。');
      taskId = await createOnce(root, `2captcha:submit:${requestId}`, task, provider());
      output({ provider: '2captcha', status: 'submitted', taskId }); return 0;
    }
    const sessionId = values.get('--session') || (route.connection === 'gateway'
      ? env.AGENT_BROWSER_SESSION || env.PROFILEPILOT_SESSION || (env.CODEX_THREAD_ID ? `cx-${env.CODEX_THREAD_ID}` : env.CLAUDE_CODE_SESSION_ID ? `cc-${env.CLAUDE_CODE_SESSION_ID}` : '')
      : env.PROFILEPILOT_SESSION);
    if (!sessionId) invalid('detect/solve 需要已持有控制权的 --session；请先 claim / 连接目标。');
    if (route.connection === 'gateway' && !route.port) invalid('Gateway 验证码操作需要 --cdp 逻辑端口。');
    const timeout = Number(values.get('--timeout') || 120000);
    if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 300000) invalid('--timeout 范围为 1000–300000 毫秒。');
    const options: CaptchaBrowserOptions = { connection: route.connection, sessionId, profileId: values.get('--profile'), port: route.port, root: values.get('--root'), targetId: values.get('--target') };
    const browser = runtime.browser || captchaBrowser(options, env);
    const page = async (input: Parameters<typeof captchaExpression>[0]) => {
      const result = await browser.evaluate(captchaExpression(input));
      if (!result?.ok) throw new CaptchaError(result?.code || 'CAPTCHA_EVALUATION_FAILED', result?.error || '验证码页面状态无效。', 75, taskId);
      return result;
    };
    if (command === 'detect') { output(await page({ mode: 'detect' })); return 0; }
    const api = provider(); // Validate local key before touching page state.
    const prepared = await page({ mode: 'prepare', selector: values.get('--selector'), nonce: randomUUID() });
    if (prepared.status === 'already_applied' || prepared.status === 'response_present') { output({ status: prepared.status, verified: false }); return 0; }
    let url: URL;
    try { url = new URL(prepared.url); } catch { invalid('验证码页面 URL 无效。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !prepared.sitekey || !['turnstile', 'recaptcha-v2'].includes(prepared.kind)) invalid('需要有效 HTTP/HTTPS 页面及支持的验证码 sitekey。');
    const task: Record<string, unknown> = {
      type: prepared.kind === 'turnstile' ? 'TurnstileTaskProxyless' : 'RecaptchaV2TaskProxyless',
      websiteURL: prepared.url, websiteKey: prepared.sitekey,
      ...(prepared.kind === 'turnstile' ? { ...(prepared.action ? { action: prepared.action } : {}), ...(prepared.data ? { data: prepared.data } : {}) } : { isInvisible: prepared.invisible === true })
    };
    const now = runtime.now || Date.now, sleep = runtime.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const deadline = now() + timeout;
    taskId = await createOnce(root, `2captcha:solve:${hash(JSON.stringify(options))}:${prepared.id}`, task, api);
    for (;;) {
      const wait = Math.min(5000, Math.max(0, deadline - now()));
      if (wait) await sleep(wait);
      if (now() >= deadline) throw new CaptchaError('CAPTCHA_TIMEOUT', '等待超时；服务商任务可能仍在计费处理。用 taskId 查询，重复 solve 会复用已有任务。', 75, taskId);
      const current = await page({ mode: 'check', id: prepared.id });
      if (current.status !== 'prepared') { output({ status: current.status, taskId, verified: false }); return 0; }
      const result = await api.result(taskId);
      if (result.status === 'processing') continue;
      const token = result.solution?.token || result.solution?.gRecaptchaResponse;
      if (typeof token !== 'string' || !token || token.length > 32768) throw new CaptchaError('CAPTCHA_RESPONSE_INVALID', '服务商结果缺少有效 token。', 75, taskId);
      if (now() >= deadline) throw new CaptchaError('CAPTCHA_TIMEOUT', '等待预算已耗尽，结果尚未填回；用 taskId 查询。', 75, taskId);
      const applied = await page({ mode: 'apply', id: prepared.id, token });
      output({ provider: '2captcha', taskId, ...applied, verified: false, ...(result.cost ? { cost: result.cost, currency: 'USD' } : {}), next: 'observe' });
      return 0;
    }
  } catch (error) {
    const failure = error as CaptchaError;
    const code = typeof failure.code === 'string' ? failure.code : 'CAPTCHA_ERROR';
    const known = error instanceof CaptchaError;
    io.stderr.write(`${JSON.stringify({ ok: false, code, error: known ? failure.message : '验证码操作失败；请检查浏览器 status 和本地配置，勿自动重放付费任务。', ...(failure.taskId || taskId ? { taskId: failure.taskId || taskId } : {}) })}\n`);
    return known ? failure.exitCode : 75;
  }
}
