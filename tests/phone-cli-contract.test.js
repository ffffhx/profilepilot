const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { runPhoneCli } = loadCli('src/main/phones/cli.ts');
const { phoneFailure } = loadCli('src/main/phones/errors.ts');
const { readPhoneParams } = loadCli('src/main/phones/cli-input.ts');

function harness(reply = async () => ({ ok: true, data: {} })) {
  const h = { calls: [], out: '', err: '' };
  h.request = async c => { h.calls.push(c); return reply(c); };
  h.io = { stdout: { write: v => { h.out += v; } }, stderr: { write: v => { h.err += v; } } };
  h.run = (args, json = '') => runPhoneCli(args, h.request, h.io, Readable.from([json]));
  return h;
}

test('phone no-observe is explicit and image feedback stays compact even when saving fails', async t => {
  const {savePhoneFeedbackImage}=loadCli('src/main/phones/action-feedback.ts');
  const h=harness(),params={id:'PHONE',sessionId:'s',generation:1,requestId:randomUUID(),action:{kind:'key',key:'home'}};
  assert.equal(await h.run(['action','--params-stdin','--no-observe'],JSON.stringify(params)),0);
  assert.equal(h.calls[0].params.observeAfter,false);
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'phone-feedback-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const input={state:{},result:{accepted:true},actionOutcome:'completed',observationStatus:'available',nextStep:'use-observation',observation:{kind:'screenshot',mime:'image/png',base64:Buffer.from('pixels').toString('base64'),width:1,height:1}};
  const saved=await savePhoneFeedbackImage(input,undefined,home);
  assert.equal(saved.observation.base64,undefined);assert.equal(fs.readFileSync(saved.observation.path,'utf8'),'pixels');
  const failed=await savePhoneFeedbackImage(input,saved.observation.path,home);
  assert.equal(failed.actionOutcome,'completed');assert.equal(failed.observationStatus,'unavailable');
  assert.equal(failed.observation,undefined);assert.equal(fs.readFileSync(saved.observation.path,'utf8'),'pixels');
});

test('phone schema and scoped help are local, concise and describe the same accepted JSON input', async () => {
  const h = harness();
  assert.equal(await h.run(['schema', 'action']), 0);
  const schema = JSON.parse(h.out);
  assert.deepEqual(schema.input.exactlyOneOf, ['--params-file', '--params-stdin']);
  assert.deepEqual(schema.input.schema.required, ['id', 'sessionId', 'generation', 'requestId', 'action']);
  assert.equal(schema.input.schema.additionalProperties, false);
  assert.ok(JSON.stringify(schema.input.schema).includes('selector'));
  h.out = '';
  assert.equal(await h.run(['action', '--help']), 0);
  assert.match(h.out, /--params-stdin/); assert.doesNotMatch(h.out, /camera-sample|wireless-discover/);
  assert.equal(h.calls.length, 0);
  const pair = harness(); assert.equal(await pair.run(['schema', 'wireless-pair']), 0);
  assert.equal(JSON.parse(pair.out).input.schema.properties.address.type, 'string', 'discovery describes input before address normalization');
});

test('stdin/BOM passes the exact action object once, without creating a temporary file', async () => {
  const h = harness();
  const action = { id: 'PHONE', sessionId: 'session', generation: 3, requestId: randomUUID(), action: { kind: 'fill', selector: { text: '姓名' }, text: '姓名 有空格' } };
  assert.equal(await h.run(['action', '--params-stdin'], '\uFEFF' + JSON.stringify(action)), 0);
  assert.deepEqual(h.calls, [{ action: 'phone', method: 'action', params: action }]);
});

test('group command schemas and help stay local; camera JSON stdin uses the same contract', async () => {
  for (const words of [['camera', 'tap'], ['camera', 'frame'], ['follow', 'analyze'], ['iphone', 'usb-start']]) {
    const h = harness();
    assert.equal(await h.run(['schema', ...words]), 0, words.join(' '));
    const contract = JSON.parse(h.out); assert.equal(contract.command, 'ppilot phone ' + words.join(' '));
    assert.ok(contract.options.length);
    if (contract.input) assert.ok(!contract.input.schema.required.includes('op'), 'the CLI supplies the operation');
    h.out = ''; assert.equal(await h.run([...words, '--help']), 0); assert.equal(h.calls.length, 0);
  }
  const h = harness(), params = { id: 'PHONE', sessionId: 's', generation: 1, x: 100, y: 200 };
  assert.equal(await h.run(['camera', 'tap', '--params-stdin'], '\uFEFF' + JSON.stringify(params)), 0);
  assert.deepEqual(h.calls[0].params, { ...params, op: 'tap' });
  const invalid = harness(); assert.equal(await invalid.run(['camera', 'tap', '--params-stdin'], '{"secret":"no-echo",BROKEN}'), 2);
  assert.equal(JSON.parse(invalid.err).recovery.actionOutcome, 'not-executed');
  assert.equal(invalid.calls.length, 0); assert.doesNotMatch(invalid.err, /no-echo/);
});

test('mutually exclusive, malformed, oversized and invalid action inputs never dispatch or echo input', async () => {
  const examples = [
    [['action', '--params-file', 'unused.json', '--params-stdin'], '{}'],
    [['action', '--params-stdin'], '{"secret":"do-not-echo",BROKEN}'],
    [['action', '--params-stdin'], '[]'],
    [['action', '--params-stdin'], JSON.stringify({ id: 'PHONE', sessionId: 's', generation: 2, requestId: randomUUID(), action: { kind: 'fill', selector: {}, text: 'do-not-echo' } })],
    [['exec', '--device', 'PHONE', '--params-stdin'], JSON.stringify({ args: ['shell', 'cat'], stdin: true })],
    [['action', '--params-stdin'], JSON.stringify({ huge: 'x'.repeat(32769) })],
    [['install', '--device', 'PHONE'], ''],
  ];
  for (const [args, input] of examples) {
    const h = harness(); assert.equal(await h.run(args, input), 2, args.join(' '));
    assert.equal(h.calls.length, 0);
    const error = JSON.parse(h.err); assert.equal(error.code, 'PHONE_INVALID_REQUEST');
    assert.equal(error.recovery.actionOutcome, 'not-executed');
    assert.equal(error.recovery.automaticReplay, false); assert.doesNotMatch(h.err, /do-not-echo/);
  }
});

test('JSON file with spaces and Unicode is portable and the reader rejects large files before parsing', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cli-input-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '手机 参数.json'); fs.writeFileSync(file, '\uFEFF{"args":["server-status"]}');
  assert.deepEqual(await readPhoneParams(new Map([['--params-file', file]])), { args: ['server-status'] });
  await assert.rejects(readPhoneParams(new Map([['--params-file', file]]), 4), e => e.code === 'PHONE_INVALID_REQUEST');
});

test('phone errors preserve server recovery across direct, exec and app wrappers', async () => {
  for (const [code, step, user, exit] of [
    ['PHONE_SESSION_CONFLICT', 'wait-for-owner', false, 75],
    ['PHONE_PERMISSION_REQUIRED', 'check-readiness', false, 1],
    ['PHONE_USER_PERMISSION_REQUIRED', 'check-readiness', true, 1],
    ['PHONE_SCREEN_LOCKED', 'check-readiness', false, 1],
    ['PHONE_CONNECTION_REQUIRED', 'check-connection', false, 1],
    ['PHONE_USER_IN_CONTROL', 'return-control', true, 75],
    ['PHONE_SERVICE_UNAVAILABLE', 'check-connection', false, 69]
  ]) {
    for (const [args, input] of [
      [['start', '--device', 'PHONE'], ''],
      [['exec', '--device', 'PHONE', '--params-stdin'], '{"args":["shell","getprop","ro.build.version.release"]}'],
      [['app', '--device', 'PHONE', '--params-stdin'], '{"operation":"launch","packageName":"com.example.app"}']
    ]) {
      const failure = phoneFailure(code, 'fixture rejection');
      const h = harness(async () => ({ ok: false, error: { code, message: failure.message, details: failure.details } }));
      assert.equal(await h.run(args, input), exit, code + ' ' + args[0]);
      const result = JSON.parse(h.out || h.err);
      assert.equal(result.recovery.cause, code); assert.equal(result.recovery.actionOutcome, 'not-executed');
      assert.equal(result.recovery.nextStep, step); assert.equal(result.recovery.requiresUser, user);
      assert.equal(h.calls.length, 1, 'failed acquisition must not stop or replace another owner');
    }
  }
});

test('an unknown dispatched action is preserved and never retried', async () => {
  const h = harness(async () => { throw new Error('response lost after dispatch'); });
  const action = { id: 'PHONE', sessionId: 's', generation: 3, requestId: randomUUID(), action: { kind: 'tap', x: 10, y: 20 } };
  assert.equal(await h.run(['action', '--params-stdin'], JSON.stringify(action)), 75);
  assert.equal(JSON.parse(h.err).recovery.actionOutcome, 'unknown'); assert.equal(h.calls.length, 1);
});

test('exec preserves Android exit status and cannot replace the primary typed failure with cleanup failure', async () => {
  const h = harness(async c => c.method === 'wrapper-start' ? { ok: true, data: { lease: 'l', device: { state: { generation: 1 } } } }
    : c.method === 'adb-start' ? { ok: true, data: { jobId: 'j' } }
    : c.method === 'adb-status' ? { ok: true, data: { status: 'completed', code: 23, drained: true, nextOffset: 0, chunks: [] } }
    : { ok: true, data: {} });
  assert.equal(await h.run(['exec', '--device', 'PHONE', '--params-stdin'], '{"args":["shell","getprop"]}'), 23);
  const fail = phoneFailure('PHONE_USER_IN_CONTROL', 'user took over');
  const failed = harness(async c => c.method === 'wrapper-start' ? { ok: true, data: { lease: 'l', device: { state: { generation: 1 } } } }
    : { ok: false, error: { code: c.method === 'wrapper-stop' ? 'CLEANUP_OTHER' : fail.code, message: fail.message, details: fail.details } });
  assert.equal(await failed.run(['exec', '--device', 'PHONE', '--params-stdin'], '{"args":["shell","getprop"]}'), 75);
  assert.equal(JSON.parse(failed.err).code, 'PHONE_USER_IN_CONTROL');
});

test('missing launch activity is not-executed and never submits am start', async () => {
  const h = harness(async c => c.method === 'wrapper-start' ? { ok: true, data: { lease: 'l', device: { state: { generation: 1 } } } }
    : c.method === 'adb-start' ? { ok: true, data: { jobId: 'j' } }
    : c.method === 'adb-status' ? { ok: true, data: { status: 'completed', code: 0, drained: true, nextOffset: 1, chunks: [{ channel: 'stdout', data: Buffer.from('No activity found').toString('base64') }] } }
    : { ok: true, data: {} });
  assert.equal(await h.run(['app', '--device', 'PHONE', '--params-stdin'], '{"operation":"launch","packageName":"com.example.app"}'), 1);
  assert.equal(JSON.parse(h.out).recovery.actionOutcome, 'not-executed');
  assert.equal(h.calls.filter(c => c.method === 'adb-start').length, 1);
  assert.deepEqual(h.calls.find(c => c.method === 'adb-start').params.args.slice(0, 4), ['shell', 'cmd', 'package', 'resolve-activity']);
});
