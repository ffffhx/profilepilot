const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { recognizeWithCodex, validateImageAnswer, codexInvocation } = loadCli('src/main/captcha/codex.ts');
const { runCaptchaCli } = loadCli('src/main/captcha/cli.ts');
const { parseBrowserCliRoute } = loadCli('src/main/browser-cli.ts');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');
const textAnswer = { status: 'answered', kind: 'text', text: 'Ab7P', tiles: [], rows: null, columns: null, reason: 'Visible characters.' };
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppilot-model-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const imageFile = path.join(root, '中文 & %PATH% picture.png');
  fs.writeFileSync(imageFile, png);
  return { root, imageFile };
}
function output() {
  let stdout = '', stderr = '';
  return { io: { stdout: { write: s => stdout += s }, stderr: { write: s => stderr += s } }, read: () => ({ stdout, stderr }) };
}

test('model output cannot smuggle tokens, invalid cells or guesses into a usable answer', () => {
  assert.deepEqual(validateImageAnswer(textAnswer, 'text'), textAnswer);
  const grid = { status: 'answered', kind: 'grid', text: null, tiles: [1, 5, 9], rows: 3, columns: 3, reason: 'Buses.' };
  assert.deepEqual(validateImageAnswer(grid), grid);
  const unsupported = { ...textAnswer, status: 'unsupported', kind: 'unsupported', text: null };
  assert.deepEqual(validateImageAnswer(unsupported), unsupported);
  for (const candidate of [
    { ...textAnswer, token: 'forged-clearance' }, { ...textAnswer, text: '' }, { ...textAnswer, text: 'line\nbreak' },
    { ...textAnswer, status: 'uncertain' }, { ...textAnswer, kind: 'unsupported' },
    { ...grid, tiles: [0] }, { ...grid, tiles: [10] }, { ...grid, tiles: [1, 1] }, { ...grid, rows: 1 },
    { ...grid, columns: '3' }, { ...grid, text: 'guess' }, { ...unsupported, rows: 3 }, null, []
  ]) assert.throws(() => validateImageAnswer(candidate), { code: 'CAPTCHA_MODEL_RESPONSE_INVALID' });
  assert.throws(() => validateImageAnswer(grid, 'text'), { code: 'CAPTCHA_MODEL_RESPONSE_INVALID' });
});

test('recognition uses an immutable image copy, cleans temporary files and never reports verification', async t => {
  const { imageFile } = temporary(t);
  let cwd, calls = 0;
  const result = await recognizeWithCodex({ imageFile, kind: 'text', instruction: 'Read case exactly' }, {}, async job => {
    calls++; cwd = job.cwd;
    const input = job.args[job.args.indexOf('--image') + 1];
    assert.deepEqual(fs.readFileSync(input), png);
    fs.writeFileSync(imageFile, 'changed outside while model runs');
    assert.deepEqual(fs.readFileSync(input), png);
    assert.equal(job.args[job.args.indexOf('--sandbox') + 1], 'read-only');
    assert.ok(job.args.includes('--ignore-user-config'));
    assert.ok(!job.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.match(job.prompt, /Never fabricate a token/);
    fs.writeFileSync(job.args[job.args.indexOf('--output-last-message') + 1], JSON.stringify(textAnswer));
  });
  assert.equal(calls, 1);
  assert.equal(result.text, 'Ab7P');
  assert.equal(result.imageSha256, createHash('sha256').update(png).digest('hex'));
  assert.equal(result.applied, false); assert.equal(result.verified, false);
  assert.equal(fs.existsSync(cwd), false);
  assert.equal(fs.readFileSync(imageFile, 'utf8'), 'changed outside while model runs');
});

test('invalid inputs fail before model invocation; bad output cleans up without retry', async t => {
  const { root, imageFile } = temporary(t);
  let calls = 0, cwd;
  const run = async job => { calls++; cwd = job.cwd; fs.writeFileSync(job.args[job.args.indexOf('--output-last-message') + 1], '{not-json'); };
  for (const options of [
    { imageFile: root }, { imageFile: path.join(root, 'missing.png') }, { imageFile, timeout: NaN },
    { imageFile, timeout: 999 }, { imageFile, kind: 'turnstile' }, { imageFile, model: 'bad;command' },
    { imageFile, instruction: 'x'.repeat(2001) }
  ]) await assert.rejects(recognizeWithCodex(options, {}, run), { code: 'CAPTCHA_INVALID_ARGUMENTS' });
  assert.equal(calls, 0);
  await assert.rejects(recognizeWithCodex({ imageFile }, {}, run), { code: 'CAPTCHA_MODEL_RESPONSE_INVALID' });
  assert.equal(calls, 1); assert.equal(fs.existsSync(cwd), false);
  fs.writeFileSync(imageFile, 'not an image');
  await assert.rejects(recognizeWithCodex({ imageFile }, {}, run), { code: 'CAPTCHA_INVALID_ARGUMENTS' });
  assert.equal(calls, 1);
});

test('Codex process receives stdin and existing login location without shell interpolation', async t => {
  const { root, imageFile } = temporary(t);
  const script = path.join(root, '中文 & %PATH% codex.cjs');
  fs.writeFileSync(script, `
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    let prompt = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', text => prompt += text);
    process.stdin.on('end', () => {
      assert.equal(process.env.CODEX_HOME, process.env.EXPECT_AUTH_HOME);
      assert.equal(JSON.parse(prompt.split('Task hint (JSON string): ')[1]), 'select "buses" & %PATH%');
      const args = process.argv.slice(2);
      assert.equal(args[0], 'exec');
      assert.ok(fs.readFileSync(args[args.indexOf('--image') + 1]).length > 8);
      console.error('private diagnostics must not enter stdout');
      fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], ${JSON.stringify(JSON.stringify(textAnswer))});
    });
  `);
  const authHome = path.join(root, 'auth-not-read-by-profilepilot');
  const env = { ...process.env, PROFILEPILOT_CAPTCHA_CODEX_BIN: script, CODEX_HOME: authHome, EXPECT_AUTH_HOME: authHome };
  const invocation = codexInvocation(env);
  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args, [script]);
  const result = await recognizeWithCodex({ imageFile, instruction: 'select "buses" & %PATH%', timeout: 10000 }, env);
  assert.equal(result.text, 'Ab7P');
  assert.equal(fs.existsSync(authHome), false);
  assert.throws(() => codexInvocation({ PATH: root, PROFILEPILOT_CAPTCHA_CODEX_BIN: path.join(root, 'codex.cmd') }, 'win32'), { code: 'CAPTCHA_CODEX_NOT_FOUND' });
});

test('failed and timed-out model processes are not retried; stderr is redacted', async t => {
  const { root, imageFile } = temporary(t);
  const script = path.join(root, 'fake-codex.cjs'), pidFile = path.join(root, 'pid.txt');
  const env = { ...process.env, PROFILEPILOT_CAPTCHA_CODEX_BIN: script, TEST_PID_FILE: pidFile };
  fs.writeFileSync(script, `console.error('private-account-value'); process.exit(1);`);
  await assert.rejects(recognizeWithCodex({ imageFile }, env), e => e.code === 'CAPTCHA_MODEL_FAILED' && !e.message.includes('private-account-value'));
  fs.writeFileSync(script, `require('node:fs').writeFileSync(process.env.TEST_PID_FILE, String(process.pid)); setInterval(() => {}, 1000);`);
  await assert.rejects(recognizeWithCodex({ imageFile, timeout: 1000 }, env), { code: 'CAPTCHA_MODEL_TIMEOUT' });
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('CLI separates Codex recognition from paid token solving and browser ownership', async () => {
  let calls = 0;
  const runtime = { recognize: async options => { calls++; assert.equal(options.kind, 'text'); return { ...textAnswer, verified: false, applied: false }; },
    provider: { create: () => { throw new Error('must not buy a task'); } }, browser: { evaluate: () => { throw new Error('must not touch browser'); } } };
  const out = output();
  assert.equal(await runCaptchaCli(parseBrowserCliRoute(['captcha', 'recognize', '--image-file', 'input.png', '--kind', 'text']), out.io, { PROFILEPILOT_CAPTCHA_PROVIDER: '2captcha' }, runtime), 0);
  assert.equal(JSON.parse(out.read().stdout).result.verified, false);
  for (const args of [
    ['captcha', 'recognize'], ['captcha', 'recognize', '--image-file', 'x', '--kind', 'turnstile'],
    ['captcha', 'recognize', '--image-file', 'x', '--provider', '2captcha'],
    ['--session', 'task', 'captcha', 'recognize', '--image-file', 'x'],
    ['--cdp', '9223', 'captcha', 'recognize', '--image-file', 'x'],
    ['captcha', 'solve', '--provider', 'codex']
  ]) assert.equal(await runCaptchaCli(parseBrowserCliRoute(args), output().io, {}, runtime), 64);
  assert.equal(calls, 1);
});
