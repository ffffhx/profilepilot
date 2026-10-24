const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { buildSync } = require('esbuild');
const { loadCli } = require('./cli-test-build.cjs');

test('Browser CLI validates before dispatch and preserves portable JSON inputs', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppilot-native-cli-'));
  const cli = path.join(root, 'ppilot.cjs');
  fs.writeFileSync(cli, buildSync({ entryPoints: [path.resolve('src/main/profilepilot-cli.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' }).outputFiles[0].contents);
  const requests = [];
  let browserReply = command => command;
  const server = http.createServer((req, res) => { const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => { const command = JSON.parse(Buffer.concat(chunks)); requests.push(command); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result: req.url === '/native-service' ? { service: 'browser', version: 1, pid: process.pid, root } : browserReply(command) })); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(root, 'native-control.json'), JSON.stringify({ version: 1, port: server.address().port, token: 'a'.repeat(64), pid: process.pid, service: 'browser', serviceVersion: 1 }));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const run = (args, input, envelope = false) => new Promise(resolve => {
    const argv = ['browser', '--root', root, ...args];
    const env = envelope ? { ...process.env, PROFILEPILOT_LAUNCHER_ARGV: Buffer.from(JSON.stringify(argv)).toString('base64') } : process.env;
    const child = spawn(process.execPath, [cli, ...(envelope ? ['--profilepilot-argv-env'] : argv)], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = ''; child.stdout.setEncoding('utf8').on('data', value => stdout += value); child.stderr.setEncoding('utf8').on('data', value => stderr += value); child.stdin.end(input);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  const directory = path.join(root, '中文 空格'); fs.mkdirSync(directory);
  const file = path.join(directory, 'params.json');
  const url = 'https://example.invalid/search?q=人工智能&src=typed_query&f=live';
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ url, tabId: 7, query: '中文 热点' }));
  for (const [method, key, expected] of [['open', 'url', url], ['switch', 'tabId', 7], ['newTab', 'url', url]]) {
    const result = await run([method, '--params-file', file]);
    assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).result.params[key], expected);
  }
  const overridden = await run(['open', 'https://override.example/', '--params-file', file]);
  assert.equal(JSON.parse(overridden.stdout).result.params.url, 'https://override.example/');
  const overriddenTab = await run(['switch', '8', '--params-file', file]);
  assert.equal(JSON.parse(overriddenTab.stdout).result.params.tabId, 8);
  const stdin = await run(['status', '--params-stdin'], '\uFEFF{"query":"人工智能 热点"}');
  assert.equal(stdin.code, 0, stdin.stderr); assert.equal(JSON.parse(stdin.stdout).result.params.query, '人工智能 热点');
  const quoted = { query: '中文 "with quotes" and C:\\trailing\\', url };
  const envelope = await run(['status', '--params', JSON.stringify(quoted)], undefined, true);
  assert.equal(envelope.code, 0, envelope.stderr); assert.deepEqual(JSON.parse(envelope.stdout).result.params, quoted);
  const ui = await run(['--session', 'original-task', 'extension-ui', 'connect', '--params-stdin'], JSON.stringify({ extensionId: 'a'.repeat(32) }));
  assert.equal(ui.code, 0, ui.stderr);
  assert.deepEqual(JSON.parse(ui.stdout).result.params, { action: 'connect', extensionId: 'a'.repeat(32) });
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=';
  const imageFile = path.join(directory, '当前验证码.png');
  const observation = { version: 'page-image-1', snapshot: 'Verification puzzle', viewport: { width: 800, height: 600 },
    fast: { candidates: [{ ref: 'e1', role: 'textbox', name: 'Answer' }] }, screenshotDataUrl: `data:image/png;base64,${png}` };
  browserReply = command => {
    assert.equal(command.method, 'observe'); assert.equal(command.sessionId, 'original-task');
    assert.equal(command.params.screenshot, true);
    return observation;
  };
  const image = await run(['--session', 'original-task', 'observe', '--output', imageFile]);
  assert.equal(image.code, 0, image.stderr);
  const returned = JSON.parse(image.stdout).result;
  assert.equal(returned.version, observation.version); assert.deepEqual(returned.fast, observation.fast);
  assert.deepEqual(returned.viewport, observation.viewport); assert.equal(returned.screenshotPath, imageFile);
  assert.equal(returned.screenshotDataUrl, undefined); assert.ok(!image.stdout.includes(png));
  assert.deepEqual(fs.readFileSync(imageFile), Buffer.from(png, 'base64'));
  for (const bad of [{ ...observation, screenshotDataUrl: undefined }, { ...observation, screenshotDataUrl: 'data:image/png;base64,bm90LXBuZw==' }, { ...observation, version: undefined }]) {
    browserReply = () => bad;
    const failed = await run(['--session', 'original-task', 'observe', '--output', imageFile]);
    assert.equal(failed.code, 1); assert.equal(JSON.parse(failed.stderr).code, 'NATIVE_RENDER_UNAVAILABLE');
    assert.equal(failed.stdout, '', 'failed capture must not return an old artifact path');
    assert.deepEqual(fs.readFileSync(imageFile), Buffer.from(png, 'base64'), 'failed capture must not overwrite the previous artifact');
  }
  browserReply = command => { assert.equal(command.method, 'screenshot'); return { data: png }; };
  const standalone = await run(['screenshot', '--output', imageFile]);
  assert.equal(standalone.code, 0); assert.equal(JSON.parse(standalone.stdout).path, imageFile);
  browserReply = command => command;
  const count = requests.length;
  const invalid = [
    ['status', '--conversion'], ['status', '--version'], ['status', '--profile'], ['typo'], ['open'], ['open', 'not-url'], ['open', 'file:///tmp/test'],
    ['switch'], ['switch', '0'], ['switch', '--params', '{"tabId":null}'], ['claim', '--tab', '-2'], ['cdp'],
    ['status', '--output', path.join(root, 'unexpected.png')], ['status', '--params', '{}', '--params-file', file], ['status', '--params', '[]'],
    ['observe', '--output', imageFile, '--params', '{"screenshot":false}'], ['extension-ui'], ['extension-ui', 'eval']
  ];
  for (const args of invalid) {
    const result = await run(args);
    assert.equal(result.code, 64, JSON.stringify({ args, ...result }));
    assert.equal(JSON.parse(result.stderr).code, 'NATIVE_INVALID_REQUEST');
  }
  const missing = await run(['status', '--params-file', path.join(directory, 'missing.json')]);
  assert.equal(missing.code, 64); assert.match(JSON.parse(missing.stderr).error, /无法读取 params 文件.*missing\.json.*ENOENT/);
  const malformed = await run(['status', '--params', '{']);
  assert.equal(malformed.code, 64); assert.match(JSON.parse(malformed.stderr).error, /JSON 语法无效/);
  assert.equal(requests.length, count, 'invalid input must not reach the desktop service');
});

test('legacy error mapping distinguishes parameter names from stale observations', () => {
  const { nativeControlError } = loadCli('src/main/native-control/errors.ts');
  assert.equal(nativeControlError(new Error('未知参数：--conversion')).code, 'NATIVE_INVALID_REQUEST');
  assert.equal(nativeControlError(new Error('动作必须携带最新 version')).code, 'NATIVE_OBSERVATION_STALE');
  assert.equal(nativeControlError(new Error('引用已失效，请重新观察。')).exitCode, 75);
});

test('only known visual read timeouts are render failures without changing ownership errors', () => {
  const { nativeControlError, NativeControlError } = loadCli('src/main/native-control/errors.ts');
  for (const message of ['截图无响应，已停止等待。', '实时画面无响应，已停止等待。']) {
    const result = nativeControlError(new Error(message));
    const { recovery, ...legacy } = result;
    assert.deepEqual(legacy, { code: 'NATIVE_RENDER_UNAVAILABLE', message, exitCode: 1 });
    assert.equal(recovery.requiresUser, false); assert.equal(recovery.automaticReplay, false);
    assert.equal(recovery.nextStep, 'reobserve');
    const explicit = nativeControlError(new NativeControlError('NATIVE_USER_IN_CONTROL', message));
    assert.equal(explicit.code, 'NATIVE_USER_IN_CONTROL'); assert.equal(explicit.exitCode, 75);
  }
  for (const message of ['用户已接管；截图无响应，已停止等待。', '实时画面无响应，已停止等待。请交还浏览器。', '页面读取或操作无响应，已停止等待。', '浏览器操作无响应，已停止等待。']) {
    const error = nativeControlError(new Error(message));
    assert.equal(error.code, 'NATIVE_USER_IN_CONTROL', message); assert.equal(error.exitCode, 75);
  }
  const uncertain = nativeControlError(new Error('浏览器操作超时，执行结果未知。'));
  assert.equal(uncertain.code, 'NATIVE_TIMEOUT_UNCERTAIN'); assert.equal(uncertain.exitCode, 75);
});

test('exact completed-scroll paint timeout wrappers retain render classification', () => {
  const { nativeControlError, NativeControlError } = loadCli('src/main/native-control/errors.ts');
  const wrap = detail => `滚动已执行，但绘制尚未确认：${detail} 请先核查控制状态并读取结果，勿直接重放滚动。`;
  for (const detail of ['截图无响应，已停止等待。', '实时画面无响应，已停止等待。']) {
    const message = wrap(detail);
    const wrapped = Object.assign(new Error(message), { code: undefined });
    const { recovery, ...legacy } = nativeControlError(wrapped);
    assert.deepEqual(legacy, { code: 'NATIVE_RENDER_UNAVAILABLE', message, exitCode: 1 });
    assert.equal(recovery.actionOutcome, 'completed'); assert.equal(recovery.automaticReplay, false);
    const explicit = nativeControlError(new NativeControlError('NATIVE_USER_IN_CONTROL', message));
    assert.equal(explicit.code, 'NATIVE_USER_IN_CONTROL'); assert.equal(explicit.exitCode, 75);
  }
  for (const detail of ['用户已接管；截图无响应，已停止等待。', '用户正在操作浏览器，请交还后继续。', '浏览器操作无响应，已停止等待。']) {
    const error = nativeControlError(new Error(wrap(detail)));
    assert.equal(error.code, 'NATIVE_USER_IN_CONTROL'); assert.equal(error.exitCode, 75);
  }
  const uncertain = nativeControlError(new Error(wrap('浏览器操作超时，执行结果未知。')));
  assert.equal(uncertain.code, 'NATIVE_TIMEOUT_UNCERTAIN'); assert.equal(uncertain.exitCode, 75);
});

test('launcher argv is consumed before dispatch and malformed envelopes do not expose their content', async () => {
  const { runProfilePilotCli } = loadCli('src/main/profilepilot-cli.ts');
  for (const value of [undefined, 'not-base64-sensitive', Buffer.from('{"secret":"never-print-this"}').toString('base64'), Buffer.from('[42]').toString('base64')]) {
    const env = { PROFILEPILOT_LAUNCHER_ARGV: value };
    let stderr = '';
    const code = await runProfilePilotCli(['--profilepilot-argv-env'], { stdout: { write() {} }, stderr: { write: text => stderr += text } }, { env });
    assert.equal(code, 64); assert.equal(env.PROFILEPILOT_LAUNCHER_ARGV, undefined);
    assert.equal(JSON.parse(stderr).code, 'NATIVE_INVALID_REQUEST'); assert.doesNotMatch(stderr, /sensitive|secret|never-print/);
  }
  const env = { PROFILEPILOT_LAUNCHER_ARGV: Buffer.from('["--version"]').toString('base64') };
  let stdout = '';
  const code = await runProfilePilotCli(['--profilepilot-argv-env'], { stdout: { write: text => stdout += text }, stderr: { write() {} } }, { env });
  assert.equal(code, 0); assert.match(stdout, /^\d+\.\d+\.\d+/); assert.equal(env.PROFILEPILOT_LAUNCHER_ARGV, undefined);
});
