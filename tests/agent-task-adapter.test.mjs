import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { validateRequest, validateBrowserArgs, controlBlocked, sdkUsage, runAdapter } from '../benchmarks/agent-tasks/adapters/profilepilot-sdk.mjs';

function request(workspace = path.resolve('test-results/adapter-test')) {
  return { protocolVersion: 1, runId: 'test-run/cell', sessionId: 'pp-eval-test', workspace,
    task: { id: 'test', prompt: 'Complete fixture task.', url: 'http://127.0.0.1:4399/', attachments: [] },
    environment: { cdp: 9239 }, budget: { timeoutMs: 10000, maxActions: 20, maxBudgetUsd: 1 } };
}

test('command grammar fixes route and prevents shell, JS, session and file escapes', () => {
  const req = validateRequest(request());
  for (const args of [['eval', 'alert(1)'], ['cdp', 'call'], ['open', 'https://example.com/'], ['open', 'file:///secret'], ['snapshot', '--session', 'other'], ['screenshot', '../outside.jpg'], ['upload', '@e1', '../secret'], ['fill', 'body', 'x'], ['press', 'Control+L'], ['resume']]) {
    assert.throws(() => validateBrowserArgs(args, req), undefined, JSON.stringify(args));
  }
  assert.deepEqual(validateBrowserArgs(['fill', '@e1', '上海 " $() `'], req), ['fill', '@e1', '上海 " $() `']);
  assert.deepEqual(validateBrowserArgs(['snapshot', '-i'], req), ['snapshot', '-i']);
  assert.throws(() => validateRequest({ ...request(), environment: { cdp: 'ws://localhost:9222' } }), /logical port/);
});

test('takeover and unknown outcomes stop control; unavailable usage stays unknown', () => {
  assert.equal(controlBlocked({ code: 'AGENT_USER_IN_CONTROL' }), true);
  assert.equal(controlBlocked({}, 75), true);
  // Unknown effects allow reconciliation reads, but never another write.
  assert.equal(controlBlocked({ recovery: { actionOutcome: 'unknown' } }), false);
  assert.equal(controlBlocked({ ok: true }), false);
  assert.deepEqual(sdkUsage(), { inputTokens: null, outputTokens: null, costUsd: null });
  assert.deepEqual(sdkUsage({ total_cost_usd: 0.2, modelUsage: { a: { inputTokens: 100, outputTokens: 5 }, b: { inputTokens: 200, outputTokens: 10 } } }), { inputTokens: 300, outputTokens: 15, costUsd: 0.2 });
});

async function setup(t, script, result = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, modelUsage: { fake: { inputTokens: 12, outputTokens: 3 } } }) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'pp-adapter-test-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let registered, options;
  const deps = {
    allowDifferentCwd: true, noSignalHandlers: true, log: () => {},
    sdk: {
      tool(name, description, schema, handler) { return { name, handler }; },
      createSdkMcpServer(input) { registered = Object.fromEntries(input.tools.map(tool => [tool.name, tool.handler])); return {}; },
      async *query(input) {
        options = input.options;
        yield { type: 'system', subtype: 'init', tools: ['ppilot', 'write_artifact', 'finish'].map(n => `mcp__benchmark__${n}`) };
        await script(registered);
        yield result;
      }
    },
    loadProvider: async () => ({ settings: { model: 'fixture-model' }, apiKey: 'private-test-credential' }),
    providerHelpers: { workerEnvironment: () => ({}), providerEnvironment: () => ({}) },
    pricingHelpers: { providerPricing: () => ({}), HOST_PRICING_ENV: {} },
    runtimeHelpers: { sdkExecutable: command => command },
    runProcess: async () => { throw Error('This protocol test must not operate a browser'); }
  };
  return { workspace, deps, getOptions: () => options };
}

test('adapter isolates model tools and writes only declared artifacts', async t => {
  const ctx = await setup(t, async tools => {
    const escaped = await tools.write_artifact({ name: '../secret.txt', content: 'no' });
    assert.equal(escaped.isError, true);
    await tools.write_artifact({ name: 'answer.json', content: '{"value":"上海"}' });
    await tools.finish({ answer: 'Observed the result.' });
  });
  const result = await runAdapter(request(ctx.workspace), ctx.deps);
  assert.equal(result.status, 'completed');
  assert.equal(result.metadata.model, 'fixture-model');
  assert.equal(result.usage.costUsd, 0.01);
  assert.deepEqual(ctx.getOptions().tools, []);
  assert.deepEqual(ctx.getOptions().settingSources, []);
  assert.equal((await ctx.getOptions().canUseTool('Bash', {})).behavior, 'deny');
  assert.equal(await readFile(path.join(ctx.workspace, 'outputs/answer.json'), 'utf8'), '{"value":"上海"}');
});

test('SDK failure and missing finish cannot become completed', async t => {
  const noFinish = await setup(t, async () => {});
  assert.equal((await runAdapter(request(noFinish.workspace), noFinish.deps)).status, 'failed');
  const sdkFailure = await setup(t, tools => tools.finish({ answer: 'Claim success' }), { type: 'result', subtype: 'error_max_budget_usd', is_error: true });
  assert.equal((await runAdapter(request(sdkFailure.workspace), sdkFailure.deps)).status, 'failed');
});

test('model can correct its own artifact but cannot overwrite a preexisting file', async t => {
  const ctx = await setup(t, async tools => {
    const first = await tools.write_artifact({ name: 'answer.json', content: '{"draft":"long draft"}' });
    assert.notEqual(first.isError, true);
    const corrected = await tools.write_artifact({ name: 'answer.json', content: '{}' });
    assert.notEqual(corrected.isError, true);
    await writeFile(path.join(ctx.workspace, 'outputs/protected.txt'), 'host supplied');
    const denied = await tools.write_artifact({ name: 'protected.txt', content: 'overwrite' });
    assert.equal(denied.isError, true);
    await tools.finish({ answer: 'Corrected the output.' });
  });
  const result = await runAdapter(request(ctx.workspace), ctx.deps);
  assert.equal(result.status, 'completed');
  assert.equal(await readFile(path.join(ctx.workspace, 'outputs/answer.json'), 'utf8'), '{}');
  assert.equal(await readFile(path.join(ctx.workspace, 'outputs/protected.txt'), 'utf8'), 'host supplied');
});

test('unknown input outcome permits receipt reads while refusing further writes', async t => {
  const executed = [];
  const ctx = await setup(t, async tools => {
    await tools.ppilot({ args: ['open', 'http://127.0.0.1:4399/'] });
    await tools.ppilot({ args: ['click', '@e1'] });
    const repeated = await tools.ppilot({ args: ['click', '@e1'] });
    assert.equal(repeated.isError, true);
    const read = await tools.ppilot({ args: ['snapshot'] });
    assert.notEqual(read.isError, true);
    await tools.finish({ answer: 'Checked receipt after unknown outcome.' });
  });
  ctx.deps.runProcess = async (command, args) => {
    const boundary = args.indexOf('--json'), operation = args[boundary + 1];
    executed.push(operation);
    assert.ok(args.includes('verification'));
    const parsed = operation === 'status' ? { ok: true, profile: { ownerSessionId: 'pp-eval-test', publicPort: 9239, ownership: 'agent' } }
      : operation === 'click' ? { ok: false, recovery: { actionOutcome: 'unknown' } }
      : { success: true, data: { url: 'http://127.0.0.1:4399/', snapshot: 'receipt' } };
    return { stdout: JSON.stringify(parsed), stderr: '', exitCode: operation === 'click' ? 1 : 0 };
  };
  const result = await runAdapter(request(ctx.workspace), ctx.deps);
  assert.equal(result.status, 'completed');
  assert.equal(executed.filter(command => command === 'click').length, 1);
  assert.ok(executed.includes('snapshot'));
});

function extensionRequest(workspace, readOnly = false) {
  const base = request(workspace);
  return { ...base, task: { ...base.task, readOnly, allowedOrigins: [base.task.url.replace(/\/$/, ''), 'https://second.example.test'] },
    environment: { track: 'live-sites-readonly', control: { transport: 'extension', connectionId: 'account-fixture-alias', profileId: 'native:Private test profile', hostOwned: true, tabId: 18 } } };
}

async function extensionSetup(t, script, readOnly = false) {
  const ctx = await setup(t, script);
  const req = extensionRequest(ctx.workspace, readOnly), calls = [];
  const profile = { profileId: req.environment.control.profileId, connected: true, ownership: 'agent', ownerSessionId: req.sessionId,
    controlGeneration: 'test-worker:1', tabId: 18, url: req.task.url };
  let version = 0, hook;
  ctx.deps.runProcess = async (_command, args) => {
    assert.equal(args[args.indexOf('--connection') + 1], 'extension');
    assert.equal(args[args.indexOf('--profile') + 1], req.environment.control.profileId);
    assert.equal(args[args.indexOf('--session') + 1], req.sessionId);
    assert.equal(args.includes('--cdp'), false);
    const method = args[args.indexOf('--json') + 1];
    const fileIndex = args.indexOf('--params-file');
    const params = fileIndex < 0 ? undefined : JSON.parse(await readFile(args[fileIndex + 1], 'utf8'));
    calls.push({ method, params, args });
    let result;
    if (method === 'status') result = { profiles: [{ ...profile }, { profileId: 'native:Other private profile', connected: true, url: 'https://unrelated.example.test/private' }],
      sessions: profile.ownerSessionId ? [{ sessionId: profile.ownerSessionId, profileId: profile.profileId, ownership: profile.ownership }] : [] };
    else if (method === 'claim') { profile.ownerSessionId = req.sessionId; profile.ownership = 'agent'; profile.url = 'about:blank'; result = { sessionId: req.sessionId, profileId: profile.profileId, state: { ...profile } }; }
    else if (method === 'open') { profile.url = params.url; result = { url: profile.url }; }
    else if (['observe', 'read'].includes(method)) result = { version: `observation-${++version}`, url: profile.url, title: 'Controlled fixture', snapshot: 'Public test content',
      fast: { candidates: [{ ref: 'e1', role: 'link', href: 'https://second.example.test/record', label: 'Record' }, { ref: 'f1e2', role: 'textbox', label: 'Field' }] } };
    else if (method === 'action') { assert.equal(params.version, `observation-${version}`); result = { applied: true }; }
    else if (method === 'complete') { result = {}; }
    else throw Error(`Unexpected native method: ${method}`);
    if (hook) await hook({ method, params, result });
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' };
  };
  return { ...ctx, req, profile, calls, setHook: value => { hook = value; } };
}

test('extension contract preserves host binding and explicit origin allowlist without accepting arbitrary routes', () => {
  const req = validateRequest(extensionRequest(path.resolve('test-results/extension-test'), true));
  assert.equal(req.environment.control.hostOwned, true);
  assert.equal(req.environment.control.tabId, 18);
  assert.equal(req.environment.track, 'live-sites-readonly');
  assert.equal(req.task.readOnly, true);
  assert.deepEqual(validateBrowserArgs(['open', 'https://second.example.test/record'], req), ['open', 'https://second.example.test/record']);
  for (const url of ['https://second.example.test.attacker.test/', 'https://unlisted.example.test/', 'https://second.example.test/__oracle', 'https://user:secret@second.example.test/']) assert.throws(() => validateBrowserArgs(['open', url], req));
  assert.throws(() => validateRequest({ ...extensionRequest(), environment: { cdp: 9239, control: req.environment.control } }), /cannot also/);
  assert.throws(() => validateRequest({ ...extensionRequest(), task: { ...req.task, allowedOrigins: ['https://second.example.test/path'] } }), /paths/);
  assert.throws(() => validateBrowserArgs(['read', '{"expression":"document.cookie"}'], req), /Unsupported/);
  assert.throws(() => validateBrowserArgs(['cdp', 'Runtime.evaluate'], req));
  assert.throws(() => validateBrowserArgs(['eval', 'document.cookie'], req));
  const exact = validateRequest({ ...extensionRequest(), task: { ...req.task, allowedUrls: [req.task.url] } });
  assert.deepEqual(exact.task.allowedUrls, [req.task.url]);
  assert.throws(() => validateBrowserArgs(['open', req.task.url + 'logout'], exact), /exact URL/);
  assert.throws(() => validateBrowserArgs(['open', req.task.url + '?action=change'], exact), /exact URL/);
  assert.throws(() => validateBrowserArgs(['open', req.task.url + '#other-route'], exact), /exact URL/);
  assert.throws(() => validateRequest({ ...extensionRequest(), task: { ...req.task, allowedUrls: ['https://second.example.test/'] } }), /exact URL/);
});

test('read-only policy refuses business inputs before any Gateway or extension execution', async t => {
  const denied = [['click', '@e1'], ['fill', '@e1', 'text'], ['press', 'Enter'], ['upload', '@e1', 'secret.txt'], ['check', '@e1'], ['click', '--session=other']];
  for (const input of [validateRequest({ ...request(), task: { ...request().task, readOnly: true } }), validateRequest(extensionRequest())]) {
    input.task.readOnly = true;
    for (const args of denied) assert.throws(() => validateBrowserArgs(args, input), error => error.code === 'ADAPTER_READ_ONLY');
  }
  const ctx = await extensionSetup(t, async tools => {
    for (const args of denied) assert.equal((await tools.ppilot({ args })).isError, true);
    await tools.finish({ answer: 'No business mutation performed.' });
  }, true);
  const result = await runAdapter(ctx.req, ctx.deps);
  assert.equal(result.status, 'completed');
  assert.equal(result.metadata.controlPolicy, 'read-only');
  assert.equal(result.metadata.rejectedMutations, denied.length);
  assert.equal(result.metadata.browserOperations, 0);
  assert.equal(result.metadata.mutationOperations, 0);
  assert.ok(ctx.calls.every(call => call.method === 'status'));
});

test('host-owned extension session executes supported reads and scroll without claiming, completing or exposing other profiles', async t => {
  const ctx = await extensionSetup(t, async tools => {
    assert.notEqual((await tools.ppilot({ args: ['open', 'https://second.example.test/record'] })).isError, true);
    assert.notEqual((await tools.ppilot({ args: ['snapshot'] })).isError, true);
    assert.notEqual((await tools.ppilot({ args: ['read', '{"query":"public","textLimit":5000}'] })).isError, true);
    assert.notEqual((await tools.ppilot({ args: ['scroll', 'down'] })).isError, true);
    const status = await tools.ppilot({ args: ['status'] });
    assert.doesNotMatch(JSON.stringify(status), /private|Other|native:/i);
    await tools.finish({ answer: 'Read the selected page.' });
  }, true);
  const result = await runAdapter(ctx.req, ctx.deps);
  assert.equal(result.status, 'completed');
  assert.equal(result.metadata.rejectedMutations, 0);
  assert.equal(result.metadata.browserOperations, 5);
  assert.equal(result.metadata.mutationOperations, 0);
  assert.doesNotMatch(JSON.stringify(result.metadata), /native:|Private test profile|test-worker/);
  assert.ok(!ctx.calls.some(call => ['claim', 'complete', 'release', 'resume'].includes(call.method)));
  assert.deepEqual(ctx.calls.find(call => call.method === 'action').params, { kind: 'scroll', version: 'observation-2', value: 'down' });
  assert.equal(ctx.calls.find(call => call.method === 'read').params.query, 'public');
});

test('extension actions consume fresh observation versions and use host-written params files', async t => {
  const ctx = await extensionSetup(t, async tools => {
    assert.equal((await tools.ppilot({ args: ['fill', '@f1e2', 'too early'] })).isError, true);
    await tools.ppilot({ args: ['snapshot'] });
    assert.notEqual((await tools.ppilot({ args: ['fill', '@f1e2', '中文 $() `'] })).isError, true);
    assert.equal((await tools.ppilot({ args: ['click', '@e1'] })).isError, true);
    await tools.ppilot({ args: ['snapshot'] });
    assert.notEqual((await tools.ppilot({ args: ['click', '@e1'] })).isError, true);
    await tools.finish({ answer: 'Applied authorized fixture changes.' });
  });
  const result = await runAdapter(ctx.req, ctx.deps);
  assert.equal(result.status, 'completed');
  const actions = ctx.calls.filter(call => call.method === 'action');
  assert.equal(actions.length, 2);
  assert.deepEqual(actions[0].params, { kind: 'fill', version: 'observation-1', ref: 'f1e2', value: '中文 $() `' });
  assert.equal(actions[1].params.version, 'observation-2');
});

test('host-owned takeover, connection loss, wrong tab and generation changes stop without retry or cleanup input', async t => {
  for (const mutate of [profile => { profile.ownership = 'user'; }, profile => { profile.connected = false; }, profile => { profile.tabId = 19; }, profile => { profile.controlGeneration = 'other-worker:2'; }]) {
    const ctx = await extensionSetup(t, async tools => {
      assert.equal((await tools.ppilot({ args: ['snapshot'] })).isError, true);
      assert.equal((await tools.ppilot({ args: ['scroll', 'down'] })).isError, true);
    }, true);
    ctx.setHook(({ method }) => { if (method === 'observe') mutate(ctx.profile); });
    const result = await runAdapter(ctx.req, ctx.deps);
    assert.equal(result.status, 'blocked');
    assert.ok(!ctx.calls.some(call => ['action', 'claim', 'complete', 'resume', 'release'].includes(call.method)));
  }
});

test('missing or occupied explicit Profile blocks before SDK invocation and never substitutes another Profile', async t => {
  for (const mutate of [profile => { profile.profileId = 'native:Different'; }, profile => { profile.ownerSessionId = 'another-session'; }]) {
    const ctx = await extensionSetup(t, async () => { throw Error('The model must not be invoked'); }, true);
    mutate(ctx.profile);
    const result = await runAdapter(ctx.req, ctx.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(ctx.getOptions(), undefined);
    assert.ok(ctx.calls.every(call => call.method === 'status'));
  }
});

test('adapter-owned extension mode claims only the explicit idle Profile and completes only its owned session', async t => {
  const ctx = await extensionSetup(t, async tools => {
    await tools.ppilot({ args: ['open', 'http://127.0.0.1:4399/'] });
    await tools.ppilot({ args: ['snapshot'] });
    await tools.finish({ answer: 'Verified the fixture page.' });
  });
  ctx.req.environment.control.hostOwned = false;
  delete ctx.req.environment.control.tabId;
  delete ctx.profile.ownerSessionId; ctx.profile.ownership = 'user';
  const result = await runAdapter(ctx.req, ctx.deps);
  assert.equal(result.status, 'completed');
  assert.deepEqual(ctx.calls.find(call => call.method === 'claim').params, { newTab: true });
  assert.equal(ctx.calls.filter(call => call.method === 'complete').length, 1);
  assert.equal(ctx.calls.filter(call => call.method === 'claim').length, 1);
});

test('an out-of-allowlist page redirect stops extension reads before more operations', async t => {
  const ctx = await extensionSetup(t, async tools => {
    assert.equal((await tools.ppilot({ args: ['open', 'http://127.0.0.1:4399/redirect'] })).isError, true);
    assert.equal((await tools.ppilot({ args: ['snapshot'] })).isError, true);
  }, true);
  ctx.setHook(({ method }) => { if (method === 'open') ctx.profile.url = 'https://unlisted.example.test/'; });
  const result = await runAdapter(ctx.req, ctx.deps);
  assert.equal(result.status, 'blocked');
  assert.ok(!ctx.calls.some(call => ['observe', 'claim', 'complete', 'resume'].includes(call.method)));
});

test('exact URL scope also blocks same-origin redirects after navigation', async t => {
  const ctx = await extensionSetup(t, async tools => {
    assert.equal((await tools.ppilot({ args: ['open', 'http://127.0.0.1:4399/'] })).isError, true);
    assert.equal((await tools.ppilot({ args: ['snapshot'] })).isError, true);
  }, true);
  ctx.req.task.allowedUrls = [ctx.req.task.url];
  ctx.setHook(({ method }) => { if (method === 'open') ctx.profile.url = 'http://127.0.0.1:4399/other-private-page'; });
  const result = await runAdapter(ctx.req, ctx.deps);
  assert.equal(result.status, 'blocked');
  assert.ok(!ctx.calls.some(call => call.method === 'observe'));
});
