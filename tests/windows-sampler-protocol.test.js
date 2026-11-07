const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const protocol = import('../scripts/e2e/windows-sampler-protocol.mjs');
const request = { version: 1, requestId: '12345678-1234-1234-1234-123456789abc', operation: 'snapshot', params: {} };
const row = { pid: 123, parentPid: 1, name: 'owned.exe', executablePath: 'C:\\owned\\owned.exe', commandLine: 'owned.exe',
  commandLineAvailable: true, startedAt: '2026-10-30T00:00:00.000Z', creationFileTime: '134273376000000001', identityStatus: 'confirmed' };
const result = () => ({ processes: [{ ...row }], complete: true, timings: { totalMs: 20, enumerateMs: 1, pinMs: 2, cimMs: 10 } });
const reply = (value = result(), req = request) => ({ version: 1, requestId: req.requestId, operation: req.operation, ok: true, result: value });
const encode = value => Buffer.from(JSON.stringify(value) + '\n');

test('sampler request binds version operation UUID and bounded exact paths', async () => {
  const { validateSamplerRequest } = await protocol;
  assert.ok(validateSamplerRequest(request).equals(encode(request)));
  assert.doesNotThrow(() => validateSamplerRequest({ ...request, operation: 'fileLocks', params: { paths: ['C:\\owned\\file.txt'] } }));
  for (const patch of [{ version: 2 }, { requestId: 'other' }, { requestId: '00000000-0000-0000-0000-000000000000' }, { operation: 'input' }, { params: { unexpected: true } }, { extra: 1 }])
    assert.throws(() => validateSamplerRequest({ ...request, ...patch }));
  for (const paths of [['relative.txt'], ['\\root-relative'], ['C:\\a', 'c:\\a'], ['C:\\nul\0path'], ['C:\\tab\tpath'], ['C:\\control\u0080path'], ['C:\\bad\ud800'], 'C:\\a'])
    assert.throws(() => validateSamplerRequest({ ...request, operation: 'fileLocks', params: { paths } }));
  assert.doesNotThrow(() => validateSamplerRequest({ ...request, operation: 'fileLocks', params: { paths: ['\\\\owned-server\\share\\file.txt', 'C:\\valid\ud83d\ude00'] } }));
});
test('FILETIME is canonical positive uint64 and never rounded through Number', async () => {
  const { isCreationFileTime } = await protocol;
  for (const value of ['1', '134273376000000001', '18446744073709551615']) assert.equal(isCreationFileTime(value), true);
  for (const value of ['0', '01', '-1', '1e5', '18446744073709551616', 134273376000000001, null]) assert.equal(isCreationFileTime(value), false);
});
test('snapshot accepts unavailable protected-process identity without inventing birth', async () => {
  const { validateSamplerReply } = await protocol;
  const value = result(); value.processes.push({ ...row, pid: 124, creationFileTime: null, identityStatus: 'unavailable', identityReason: 'open_failed', identityWin32Error: 5 });
  assert.deepEqual(validateSamplerReply(encode(reply(value)), request, 0), value);
  for (const patch of [{ creationFileTime: row.creationFileTime }, { identityReason: 'guess' }, { creationFileTime: undefined }]) {
    const changed = { ...value, processes: [value.processes[0], { ...value.processes[1], ...patch }] };
    assert.throws(() => validateSamplerReply(encode(reply(changed)), request, 0));
  }
});
test('snapshot rejects duplicate PID, partial enumeration, false confirmed identity and unknown fields', async () => {
  const { validateSamplerReply } = await protocol;
  const bad = [ { ...result(), complete: false }, { ...result(), processes: [row, row] }, { ...result(), processes: [] },
    ...[{ creationFileTime: null }, { identityStatus: 'guessed' }, { commandLine: 'x'.repeat(32769) }, { commandLine: '', commandLineAvailable: true }, { commandLine: '\ud800' }, { guessed: true }].map(patch => ({ ...result(), processes: [{ ...row, ...patch }] })) ];
  for (const value of bad) assert.throws(() => validateSamplerReply(encode(reply(value)), request, 0));
});
test('RM rows require exact requested path and consistent birth for each PID', async () => {
  const { validateSamplerReply } = await protocol;
  const req = { ...request, operation: 'fileLocks', params: { paths: ['C:\\owned\\a', 'C:\\owned\\b'] } };
  const value = { rows: [{ path: req.params.paths[0], pid: 123, creationFileTime: row.creationFileTime }], complete: true, timings: { totalMs: 1 } };
  assert.deepEqual(validateSamplerReply(encode(reply(value, req)), req, 0), value);
  assert.deepEqual(validateSamplerReply(encode(reply({ ...value, rows: [] }, req)), req, 0).rows, []);
  for (const rows of [[{ ...value.rows[0], path: 'C:\\unrequested' }], [value.rows[0], value.rows[0]],
    [value.rows[0], { ...value.rows[0], path: req.params.paths[1], creationFileTime: '134273376000000002' }]])
    assert.throws(() => validateSamplerReply(encode(reply({ ...value, rows }, req)), req, 0));
});
test('wire validation rejects malformed UTF8 incomplete/multiple replies mismatched IDs and exit status', async () => {
  const { validateSamplerReply } = await protocol;
  for (const bytes of [Buffer.from('{}'), Buffer.from([0xff, 0x0a]), Buffer.concat([encode(reply()), encode(reply())]), Buffer.from('log\n' + JSON.stringify(reply()) + '\n')])
    assert.throws(() => validateSamplerReply(bytes, request, 0));
  for (const patch of [{ version: 2 }, { requestId: 'another' }, { operation: 'fileLocks' }])
    assert.throws(() => validateSamplerReply(encode({ ...reply(), ...patch }), request, 0));
  assert.throws(() => validateSamplerReply(encode(reply()), request, 2));
});
test('native structured failure remains failure with only bounded safe diagnostic fields', async () => {
  const { validateSamplerReply } = await protocol;
  const error = { code: 'WINDOWS_SAMPLER_PIN_FAILED', stage: 'process_pin', pid: 123, win32Error: 5 };
  const value = { version: 1, requestId: request.requestId, operation: request.operation, ok: false, error };
  assert.throws(() => validateSamplerReply(encode(value), request, 2), failure => failure.code === error.code && failure.details.pid === 123 && failure.outcome === 'unavailable');
  assert.throws(() => validateSamplerReply(encode({ ...value, error: { ...error, message: 'user command line' } }), request, 2));
  assert.throws(() => validateSamplerReply(encode({ ...value, error: { ...error, stage: 'unknown' } }), request, 2), { code: 'SAMPLER_INVALID_RESPONSE' });
  assert.throws(() => validateSamplerReply(encode({ ...value, error: { ...error, cleanupFailed: true, cleanupWin32Error: 6 } }), request, 2), failure => failure.details.cleanupFailed && failure.details.cleanupWin32Error === 6);
  assert.throws(() => validateSamplerReply(encode({ ...value, error: { ...error, cleanupWin32Error: 6 } }), request, 2), { code: 'SAMPLER_INVALID_RESPONSE' });
});
test('reply grammar rejects duplicate and escaped duplicate keys and excessive depth', async () => {
  const { validateSamplerReply } = await protocol;
  const original = JSON.stringify(reply());
  for (const text of [original.replace('"ok":true', '"ok":false,"ok":true'),
    original.replace('"ok":true', '"o\\u006b":false,"ok":true'),
    original.replace('"creationFileTime":', '"creationFileTime":"1","creationFileTime":'),
    original.replace('"creationFileTime":', '"creationFile\\u0054ime":"1","creationFileTime":')])
    assert.throws(() => validateSamplerReply(Buffer.from(text + '\n'), request, 0), { code: 'SAMPLER_AMBIGUOUS_JSON' });
  const deep = '['.repeat(18) + '0' + ']'.repeat(18) + '\n';
  assert.throws(() => validateSamplerReply(Buffer.from(deep), request, 0), { code: 'SAMPLER_JSON_DEPTH' });
  for (const text of ['{"x":01}\n', '{"x":true,}\n', '{"x":"unterminated}\n', '{}false\n'])
    assert.throws(() => validateSamplerReply(Buffer.from(text), request, 0), { code: 'SAMPLER_INVALID_JSON' });
  const escaped = result(); escaped.processes[0].commandLine = 'owned \\"quote\\\\ and braces { \\u0054 }';
  assert.deepEqual(validateSamplerReply(encode(reply(escaped)), request, 0), escaped);
});
test('total RM and request path caps match native rather than multiplying per-path limits', async () => {
  const { SAMPLER_LIMITS, validateSamplerRequest, validateSamplerReply } = await protocol;
  assert.equal(SAMPLER_LIMITS.lockRows, 16384); assert.equal(SAMPLER_LIMITS.paths, 256);
  const req = { ...request, operation: 'fileLocks', params: { paths: ['C:\\owned\\file.txt'] } };
  const rows = Array.from({ length: 16385 }, (_, i) => ({ path: req.params.paths[0], pid: i + 1, creationFileTime: row.creationFileTime }));
  assert.throws(() => validateSamplerReply(encode(reply({ complete: true, rows, timings: { totalMs: 1 } }, req)), req, 0));
  assert.throws(() => validateSamplerRequest({ ...req, params: { paths: Array.from({ length: 257 }, (_, i) => 'C:\\owned\\' + i) } }));
  assert.throws(() => validateSamplerRequest({ ...req, params: { paths: Array.from({ length: 10 }, (_, i) => 'C:\\' + i + 'x'.repeat(30000)) } }), { code: 'SAMPLER_REQUEST_TOO_LARGE' });
});
function child(onInput, confirmKill = true) {
  const value = Object.assign(new EventEmitter(), { pid: 4321, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kills: 0 });
  let input = ''; value.stdin.on('data', chunk => input += chunk);
  value.stdin.on('finish', () => setImmediate(() => onInput(value, input)));
  value.kill = () => { value.kills++; if (confirmKill) setImmediate(() => value.emit('close', null)); return true; };
  return value;
}
test('runner sends one request and waits for close after fragmented UTF8 stdout', async () => {
  const { runWindowsSampler } = await protocol;
  let calls = 0;
  const native = child((c, input) => { assert.deepEqual(JSON.parse(input), request); const bytes = encode(reply()); c.stdout.emit('data', bytes.subarray(0, 15)); c.stdout.emit('data', bytes.subarray(15)); c.emit('close', 0); });
  const actual = await runWindowsSampler({ executable: 'owned.exe', request, spawnImpl: (_exe, args, options) => { calls++; assert.deepEqual(args, []); assert.equal(options.windowsHide, true); return native; } });
  assert.equal(calls, 1); assert.equal(native.kills, 0); assert.deepEqual(actual.result, result());
});
test('deadline kills only spawned child without retry and rejects even a late successful response', async () => {
  const { runWindowsSampler } = await protocol;
  let calls = 0; const native = child(() => {});
  native.kill = () => { native.kills++; native.stdout.emit('data', encode(reply())); setImmediate(() => native.emit('close', 0)); return true; };
  await assert.rejects(runWindowsSampler({ executable: 'owned.exe', request, timeoutMs: 10, killGraceMs: 20, spawnImpl: () => { calls++; return native; } }), { code: 'SAMPLER_TIMEOUT' });
  assert.equal(calls, 1); assert.equal(native.kills, 1);
});
test('unconfirmed termination and nonempty stderr cannot produce evidence', async () => {
  const { runWindowsSampler } = await protocol;
  await assert.rejects(runWindowsSampler({ executable: 'owned.exe', request, timeoutMs: 5, killGraceMs: 10, spawnImpl: () => child(() => {}, false) }), { code: 'SAMPLER_EXIT_UNCONFIRMED' });
  await assert.rejects(runWindowsSampler({ executable: 'owned.exe', request, spawnImpl: () => child(c => { c.stderr.emit('data', Buffer.from('unexpected')); c.stdout.emit('data', encode(reply())); c.emit('close', 0); }) }), { code: 'SAMPLER_UNEXPECTED_STDERR' });
});
