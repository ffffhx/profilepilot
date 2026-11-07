// Parser/help regression coverage only. Requests and screenshot bytes are fake;
// this never starts the App, a helper, a hook, or a native input operation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { runDesktopCli, desktopHelp } = loadCli('src/main/desktop/cli.ts');
const windowId = 'a'.repeat(32), version = 'b'.repeat(32);
const action = { version, kind: 'invoke', ref: 'e1' };
async function cli(args, { data = {}, input = '', response } = {}) {
  let stdout = '', stderr = ''; const calls = [];
  const io = { stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } } };
  const code = await runDesktopCli(args, async command => { calls.push(command); return response || { ok: true, data }; }, io, Readable.from([input]));
  return { code, stdout, stderr, calls };
}
async function invalid(args, options) {
  const result = await cli(args, options);
  assert.equal(result.code, 2, JSON.stringify(args)); assert.equal(result.calls.length, 0, JSON.stringify(args));
  assert.equal(JSON.parse(result.stdout).code, 'DESKTOP_INVALID_ARGUMENTS');
}

test('wait accepts known equals options and preserves leading dashes and subsequent equals literally', async () => {
  const result = await cli(['wait', '--session=guidance', '--name=--status', '--role=Text', '--automation-id=--field=id',
    '--text=--literal=a=b', '--has-action=text', '--timeout-ms=100', '--interval-ms=100', '--json']);
  assert.equal(result.code, 0); assert.equal(result.calls.length, 1);
  const command = result.calls[0];
  assert.equal(command.session, 'guidance'); assert.equal(command.method, 'wait');
  assert.deepEqual(command.condition, { name: '--status', role: 'Text', automationId: '--field=id', text: '--literal=a=b', hasAction: 'text' });
  assert.equal(command.timeoutMs, 100); assert.equal(command.intervalMs, 100);
});

test('inline text supports empty and option-looking literals without invoking help or adding switches', async () => {
  for (const text of ['', '--help', '-h', '--json', '--session=other', '=leading', ' spaced = value ']) {
    const result = await cli(['wait', '--session', 'guidance', '--text=' + text]);
    assert.equal(result.code, 0, text); assert.equal(result.calls.length, 1, text);
    assert.deepEqual(result.calls[0].condition, { text }); assert.equal(result.calls[0].session, 'guidance');
    assert.equal(JSON.parse(result.stdout).ok, true);
  }
});

test('claim doctor and receipt accept equal-form identifiers without changing command scope', async () => {
  const requestId = randomUUID();
  for (const args of [['claim', '--session=guidance', '--window=' + windowId], ['doctor', '--window=' + windowId],
    ['receipt', '--session=guidance', '--request-id=' + requestId]]) {
    const result = await cli(args); assert.equal(result.code, 0, args.join(' ')); assert.equal(result.calls.length, 1);
    const command = result.calls[0]; assert.equal(command.method, args[0]);
    if (command.method === 'doctor') assert.equal(command.session, undefined);
    else assert.equal(command.session, 'guidance');
    if (command.method === 'receipt') assert.equal(command.requestId, requestId); else assert.equal(command.windowId, windowId);
  }
});

test('file and output equals options preserve the full path and retain explicit action receipt flags', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cli-guidance-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputFile = path.join(directory, 'owned=action.json'), outputFile = path.join(directory, 'owned=image.jpg');
  fs.writeFileSync(inputFile, JSON.stringify(action));
  const requestId = randomUUID();
  const result = await cli(['action', '--session=guidance', '--params-file=' + inputFile, '--request-id=' + requestId, '--observe']);
  assert.equal(result.code, 0); assert.equal(result.calls.length, 1);
  assert.deepEqual(result.calls[0].params, action); assert.equal(result.calls[0].requestId, requestId);
  assert.equal(result.calls[0].observeAfter, true);
  const bytes = Buffer.from('owned fake image bytes');
  const screenshot = await cli(['screenshot', '--session=guidance', '--output=' + outputFile, '--image-only'],
    { data: { image: { mimeType: 'image/jpeg', data: bytes.toString('base64') } } });
  assert.equal(screenshot.code, 0); assert.equal(screenshot.calls.length, 1);
  assert.equal(screenshot.calls[0].screenshotOnly, true);
  assert.deepEqual(fs.readFileSync(outputFile), bytes); assert.equal(JSON.parse(screenshot.stdout).result.image.path, outputFile);
});

test('duplicate options are rejected across separated and inline forms before request dispatch', async () => {
  for (const duplicate of [['--text=x', '--text', 'x'], ['--text', 'x', '--text=x'], ['--text=x', '--text=x'],
    ['--session=another'], ['--json', '--json']]) {
    await invalid(['wait', '--session', 'guidance', ...duplicate]);
  }
});

test('boolean switches never accept equals values, including empty or false', async () => {
  const cases = [ ['status', [], '--json'], ['action', ['--session', 'guidance'], '--params-stdin'],
    ['action', ['--session', 'guidance', '--params-stdin'], '--observe'],
    ['screenshot', ['--session', 'guidance'], '--image-only'], ['complete', ['--session', 'guidance'], '--require-active'] ];
  for (const [method, args, option] of cases) for (const value of ['', 'false', 'true', '0']) {
    await invalid([method, ...args, option + '=' + value], { input: JSON.stringify(action) });
  }
});

test('inline syntax does not bypass unknown options, command-specific scope or strict schema validation', async () => {
  for (const args of [ ['wait', '--session=guidance', '--text=x', '--unknown=value'],
    ['status', '--text=x'], ['observe', '--session=guidance', '--window=' + windowId],
    ['wait', '--session=guidance', '--text=x', '--timeout-ms=-1'], ['wait', '--session=guidance', '--text=x', '--timeout-ms=20001'],
    ['wait', '--session=guidance', '--text=x', '--interval-ms=99'], ['wait', '--session=guidance', '--text=x', '--interval-ms=NaN'],
    ['wait', '--session=guidance', '--text=x', '--has-action=not_an_action'],
    ['wait', '--session=guidance', '--text=x', '--role='], ['wait', '--session=guidance', '--name='],
    ['claim', '--session=bad name', '--window=' + windowId], ['claim', '--session=guidance', '--window=invalid'],
    ['receipt', '--session=guidance', '--request-id=invalid'], ['action', '--session=guidance', '--params-file='] ]) {
    await invalid(args);
  }
  for (const params of [{ ...action, keys: ['A'] }, { ...action, kind: 'text' }, { ...action, kind: 'set_value' }]) {
    await invalid(['action', '--session=guidance', '--params-stdin'], { input: JSON.stringify(params) });
  }
});

test('existing separate options remain supported and bare option-looking text remains an error', async () => {
  const result = await cli(['wait', '--session', 'guidance', '--text', 'unchanged']);
  assert.equal(result.code, 0); assert.deepEqual(result.calls[0].condition, { text: 'unchanged' });
  await invalid(['wait', '--session', 'guidance', '--text', '--literal']);
  const requestId = randomUUID();
  const input = await cli(['action', '--session', 'guidance', '--params-stdin', '--request-id', requestId],
    { input: JSON.stringify(action), response: { ok: false, error: { code: 'DESKTOP_USER_IN_CONTROL', message: 'paused' } } });
  assert.equal(input.code, 75); assert.equal(input.calls.length, 1); assert.equal(JSON.parse(input.stdout).requestId, requestId);
});

test('help explains the literal-text spelling and the actual native press_key name set', async () => {
  const native = fs.readFileSync('native/desktop/windows.cs', 'utf8');
  const method = native.slice(native.indexOf('static ushort KeyCode(string key)'), native.indexOf('static bool SameRect'));
  const names = [...method.matchAll(/\{"([A-Z]+)",\d+\}/g)].map(match => match[1]);
  assert.ok(names.length >= 19, 'derive the named-key dictionary from the actual native driver');
  const result = await cli(['--help']); assert.equal(result.code, 0); assert.equal(result.calls.length, 0);
  assert.equal(result.stdout, desktopHelp);
  for (const name of names) assert.match(desktopHelp, new RegExp('\\b' + name + '\\b'), name);
  for (const range of ['A-Z', '0-9', 'F1-F12']) assert.ok(desktopHelp.includes(range), range);
  assert.match(desktopHelp, /--text=--literal/); assert.match(desktopHelp, /--text=/);
  assert.match(desktopHelp, /不区分大小写/);
});
