const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { loadCli } = require('./cli-test-build.cjs');
const { twoCaptcha, createOnce, captchaKey } = loadCli('src/main/captcha/provider.ts');
const { captchaBrowser } = loadCli('src/main/captcha/browser.ts');
const { runCaptchaCli } = loadCli('src/main/captcha/cli.ts');
const { captchaExpression } = loadCli('src/main/captcha/page.ts');
const { runBrowserCli, parseBrowserCliRoute } = loadCli('src/main/browser-cli.ts');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppilot-captcha-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function output() {
  let stdout = '', stderr = '';
  return { io: { stdout: { write: s => stdout += s }, stderr: { write: s => stderr += s } }, read: () => ({ stdout, stderr }) };
}
function domFixture(kind = 'turnstile', count = 1) {
  class Input {
    constructor(name) { this.name = name; this.tagName = 'INPUT'; this.events = []; this.data = ''; }
    set value(value) { this.data = value; }
    get value() { return this.data; }
    dispatchEvent(event) { this.events.push(event.type); }
  }
  const field = new Input(kind === 'turnstile' ? 'cf-turnstile-response' : 'g-recaptcha-response');
  const attributes = { 'data-sitekey': 'public-site-key', 'data-callback': 'app.done' };
  const node = {
    isConnected: true,
    classList: { contains: name => name === (kind === 'turnstile' ? 'cf-turnstile' : 'g-recaptcha') },
    getAttribute: name => attributes[name] ?? null, hasAttribute: name => name in attributes,
    closest: () => null, querySelectorAll: () => [field], matches: selector => selector === '#captcha'
  };
  const callbacks = [];
  const window = { app: { done(token) { assert.equal(this, window.app); callbacks.push(token); } } };
  const location = { href: 'https://example.test/form?q=中文&x=1' };
  const document = { querySelector: () => null, querySelectorAll: selector => selector === 'input, textarea' ? [field] : Array(count).fill(node) };
  const context = vm.createContext({ window, document, location, HTMLInputElement: Input, HTMLTextAreaElement: Input, Event: class { constructor(type) { this.type = type; } } });
  return { window, field, node, attributes, callbacks, location, context, browser: { evaluate: async expression => vm.runInContext(expression, context) } };
}

test('2Captcha wire format, redacted errors, no redirect and no automatic paid retry', async () => {
  const requests = [];
  const replies = [{ errorId: 0, taskId: 123 }, { errorId: 0, status: 'processing' }, { errorId: 0, status: 'ready', solution: { token: 'answer' }, cost: '0.00145' }, { errorId: 0, balance: 4.5 }];
  const provider = twoCaptcha('local-secret', async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, json: async () => replies.shift() };
  });
  assert.equal(await provider.create({ type: 'TurnstileTaskProxyless', websiteKey: 'key' }), 123);
  assert.equal((await provider.result(123)).status, 'processing');
  assert.deepEqual(await provider.result(123), { status: 'ready', solution: { token: 'answer' }, cost: '0.00145' });
  assert.equal(await provider.balance(), 4.5);
  assert.equal(requests[0].url, 'https://api.2captcha.com/createTask');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].body.clientKey, 'local-secret');
  assert.deepEqual(requests[1].body, { clientKey: 'local-secret', taskId: 123 });
  let calls = 0;
  const failed = twoCaptcha('local-secret', async () => { calls++; throw new Error('local-secret'); });
  await assert.rejects(failed.create({}), e => e.code === 'CAPTCHA_NETWORK_UNCERTAIN' && !e.message.includes('local-secret'));
  assert.equal(calls, 1);
  const denied = twoCaptcha('local-secret', async () => ({ ok: true, json: async () => ({ errorId: 10, errorCode: 'local-secret', errorDescription: 'local-secret' }) }));
  await assert.rejects(denied.balance(), e => e.code === 'CAPTCHA_PROVIDER_ERROR' && !e.message.includes('local-secret'));
});

test('receipts prevent duplicate billing including concurrent and uncertain create requests', async t => {
  const root = temporary(t), task = { type: 'TurnstileTaskProxyless', websiteURL: 'https://private.example', websiteKey: 'key' };
  let calls = 0, finish;
  const provider = { create: () => { calls++; return new Promise(resolve => finish = resolve); } };
  const first = createOnce(root, 'same', task, provider);
  await assert.rejects(createOnce(root, 'same', task, provider), { code: 'CAPTCHA_SUBMISSION_UNCERTAIN' });
  finish(456); assert.equal(await first, 456);
  assert.equal(await createOnce(root, 'same', task, provider), 456);
  assert.equal(calls, 1);
  await assert.rejects(createOnce(root, 'same', { ...task, websiteKey: 'other' }, provider), { code: 'CAPTCHA_REQUEST_CONFLICT' });
  const receipt = fs.readFileSync(path.join(root, fs.readdirSync(root)[0]), 'utf8');
  assert.ok(!receipt.includes('private.example'));
  const uncertain = { create: async () => { throw new Error('lost response'); } };
  await assert.rejects(createOnce(root, 'uncertain', task, uncertain));
  await assert.rejects(createOnce(root, 'uncertain', task, provider), { code: 'CAPTCHA_SUBMISSION_UNCERTAIN' });
  assert.equal(calls, 1);
});

test('page applies once to the bound document and named callback; never submits a form', async () => {
  for (const kind of ['turnstile', 'recaptcha-v2']) {
    const f = domFixture(kind);
    const prepared = await f.browser.evaluate(captchaExpression({ mode: 'prepare', nonce: 'original' }));
    assert.equal(prepared.kind, kind);
    const again = await f.browser.evaluate(captchaExpression({ mode: 'prepare', nonce: 'new' }));
    assert.equal(again.id, 'original');
    const apply = { mode: 'apply', id: 'original', token: 'provider-answer' };
    assert.equal((await f.browser.evaluate(captchaExpression(apply))).status, 'applied');
    assert.equal(f.field.value, 'provider-answer');
    assert.deepEqual(f.field.events, ['input', 'change']);
    assert.equal((await f.browser.evaluate(captchaExpression(apply))).status, 'already_applied');
    assert.deepEqual(f.callbacks, ['provider-answer']);
    f.location.href = 'https://example.test/other';
    assert.equal((await f.browser.evaluate(captchaExpression(apply))).code, 'CAPTCHA_PAGE_CHANGED');
  }
});

test('unsupported, ambiguous, replaced and throwing widgets fail without replay', async () => {
  const f = domFixture();
  f.window._cf_chl_opt = {};
  assert.equal((await f.browser.evaluate(captchaExpression({ mode: 'prepare', nonce: 'x' }))).code, 'CAPTCHA_UNSUPPORTED_CHALLENGE');
  delete f.window._cf_chl_opt;
  await f.browser.evaluate(captchaExpression({ mode: 'prepare', nonce: 'x' }));
  f.node.isConnected = false;
  assert.equal((await f.browser.evaluate(captchaExpression({ mode: 'apply', id: 'x', token: 't' }))).code, 'CAPTCHA_PAGE_CHANGED');
  const multiple = domFixture('turnstile', 2);
  assert.equal((await multiple.browser.evaluate(captchaExpression({ mode: 'prepare', nonce: 'x' }))).code, 'CAPTCHA_AMBIGUOUS');
  const broken = domFixture();
  let invoked = 0;
  broken.window.app.done = () => { invoked++; throw new Error('callback failed'); };
  await broken.browser.evaluate(captchaExpression({ mode: 'prepare', nonce: 'x' }));
  const apply = captchaExpression({ mode: 'apply', id: 'x', token: 't' });
  assert.equal((await broken.browser.evaluate(apply)).code, 'CAPTCHA_APPLY_UNCERTAIN');
  assert.equal((await broken.browser.evaluate(apply)).code, 'CAPTCHA_APPLY_UNCERTAIN');
  assert.equal(invoked, 1);
});

test('selecting another widget does not discard the first pending paid task identity', async () => {
  const first = domFixture(), second = domFixture();
  second.node.matches = selector => selector === '#other';
  first.context.document.querySelectorAll = () => [first.node, second.node];
  const prepare = (selector, nonce) => first.browser.evaluate(captchaExpression({ mode: 'prepare', selector, nonce }));
  assert.equal((await prepare('#captcha', 'first')).id, 'first');
  assert.equal((await prepare('#other', 'second')).id, 'second');
  assert.equal((await prepare('#captcha', 'third')).id, 'first');
  assert.equal((await first.browser.evaluate(captchaExpression({ mode: 'check', id: 'second' }))).status, 'prepared');
});

test('both browser transports retain ownership generation and never acquire or change routes', async () => {
  for (const connection of ['extension', 'gateway']) {
    let generation = 1;
    const calls = [];
    const profile = () => ({ publicPort: 9223, profileId: 'native:Default', ownerSessionId: 'task', ownership: 'agent', controlGeneration: generation });
    const native = async command => { calls.push(command); return command.method === 'status' ? { profiles: [profile()] } : { result: { value: 'ok' } }; };
    const gateway = async command => { calls.push(command); return command.action === 'status' ? { ok: true, state: { profiles: [profile()] } } : { ok: true, result: { result: { value: 'ok' } } }; };
    const browser = captchaBrowser({ connection, sessionId: 'task', port: 9223, profileId: connection === 'extension' ? 'native:Default' : undefined }, {}, { native, gateway, identity: () => 'original-daemon' });
    assert.equal(await browser.evaluate('1'), 'ok');
    generation++;
    await assert.rejects(browser.evaluate('2'), { code: 'CAPTCHA_CONTROL_CHANGED' });
    assert.equal(calls.length, 3);
    assert.equal(calls[1].method, connection === 'extension' ? 'cdp' : 'Runtime.evaluate');
    assert.equal(calls[1].sessionId, 'task');
    if (connection === 'gateway') assert.equal(calls[1].daemonInstanceId, 'original-daemon');
  }
});

test('CLI solves, reports cost without exposing token, and repeat solve never purchases again', async t => {
  const root = temporary(t), f = domFixture();
  let time = 0, creates = 0, polls = 0;
  const provider = { create: async task => { creates++; assert.equal(task.type, 'TurnstileTaskProxyless'); return 789; }, result: async () => { polls++; return { status: polls === 1 ? 'processing' : 'ready', solution: { token: 'private-token' }, cost: '0.00145' }; } };
  const route = parseBrowserCliRoute(['--session', 'task', 'captcha', 'solve']);
  const runtime = { provider, browser: f.browser, now: () => time, sleep: async ms => { time += ms; } };
  const out = output();
  assert.equal(await runCaptchaCli(route, out.io, { PROFILEPILOT_CAPTCHA_STATE_DIR: root }, runtime), 0);
  assert.equal(creates, 1); assert.equal(polls, 2); assert.equal(time, 10000);
  const value = JSON.parse(out.read().stdout).result;
  assert.equal(value.status, 'applied'); assert.equal(value.verified, false); assert.equal(value.cost, '0.00145');
  assert.ok(!out.read().stdout.includes('private-token'));
  assert.equal(f.field.value, 'private-token');
  assert.equal(await runCaptchaCli(route, output().io, { PROFILEPILOT_CAPTCHA_STATE_DIR: root }, runtime), 0);
  assert.equal(creates, 1);
});

test('timeout retains taskId and resuming solve reuses it; changed page never gets a token', async t => {
  const root = temporary(t), f = domFixture();
  let time = 0, creates = 0;
  const provider = { create: async () => { creates++; return 987; }, result: async () => ({ status: 'ready', solution: { token: 'token' } }) };
  const env = { PROFILEPILOT_CAPTCHA_STATE_DIR: root };
  const runtime = { provider, browser: f.browser, now: () => time, sleep: async ms => { time += ms; } };
  const out = output();
  assert.equal(await runCaptchaCli(parseBrowserCliRoute(['--session', 'task', 'captcha', 'solve', '--timeout', '1000']), out.io, env, runtime), 75);
  assert.equal(JSON.parse(out.read().stderr).taskId, 987);
  runtime.sleep = async ms => { time += ms; f.location.href = 'https://example.test/moved'; };
  const moved = output();
  assert.equal(await runCaptchaCli(parseBrowserCliRoute(['--session', 'task', 'captcha', 'solve']), moved.io, env, runtime), 75);
  assert.equal(JSON.parse(moved.read().stderr).code, 'CAPTCHA_PAGE_CHANGED');
  assert.equal(f.field.value, ''); assert.equal(creates, 1);
});

test('CLI configuration, portable task files and local routing fail before paid requests', async t => {
  const root = temporary(t), file = path.join(root, '中文 task.json');
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ type: 'ImageToTextTask', body: 'base64-image' }));
  const env = { PROFILEPILOT_CAPTCHA_STATE_DIR: root };
  let creates = 0;
  const provider = { create: async () => { creates++; return 123; } };
  const route = parseBrowserCliRoute(['captcha', 'submit', '--task-file', file, '--request-id', 'image-1']);
  assert.equal(await runCaptchaCli(route, output().io, env, { provider }), 0);
  assert.equal(await runCaptchaCli(route, output().io, env, { provider }), 0);
  assert.equal(creates, 1);
  fs.writeFileSync(file, '\uFEFFsecret\n');
  assert.equal(captchaKey({ PROFILEPILOT_CAPTCHA_API_KEY_FILE: file }), 'secret');
  for (const args of [['captcha', 'solve'], ['--session', 'task', 'captcha', 'solve', '--timeout', 'NaN'], ['captcha', 'result', '--task-id', 'abc'], ['captcha', 'balance', '--provider', 'unknown']]) {
    assert.equal(await runCaptchaCli(parseBrowserCliRoute(args), output().io, env, { provider }), 64);
  }
  for (const args of [['captcha', '--help'], ['--connection', 'gateway', 'captcha', '--help']]) {
    const out = output();
    assert.equal(await runBrowserCli(args, out.io, {}), 0);
    assert.match(out.read().stdout, /2Captcha/);
  }
  for (const args of [['--session', 's', 'captcha', 'detect'], ['--session', 's', '--cdp', '9223', 'captcha', 'detect']]) {
    let dispatched;
    assert.equal(await runBrowserCli(args, output().io, {}, { captcha: async route => { dispatched = route; return 0; }, gateway: async () => { throw new Error('wrong dispatch'); }, extension: async () => { throw new Error('wrong dispatch'); } }), 0);
    assert.equal(dispatched.connection, args.includes('--cdp') ? 'gateway' : 'extension');
  }
});
