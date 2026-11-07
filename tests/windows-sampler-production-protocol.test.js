const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { validateWindowsSamplerRequest: encodeRequest, validateWindowsSamplerReply: decode,
  isWindowsCreationFileTime: birth, WINDOWS_SAMPLER_LIMITS: limits } = loadCli('src/main/windows-sampler-protocol.ts');
const request = { version: 1, requestId: '12345678-1234-1234-1234-123456789abc', operation: 'snapshot', params: {} };
const row = { pid: 123, parentPid: 1, name: 'owned.exe', executablePath: 'C:\\owned\\owned.exe', commandLine: 'owned.exe', commandLineAvailable: true,
  startedAt: '2026-10-30T00:00:00.0000000Z', creationFileTime: '134273376000000001', identityStatus: 'confirmed' };
const snapshot = () => ({ processes: [{ ...row }], complete: true, timings: { totalMs: 20, enumerateMs: 1, pinMs: 2, cimMs: 10 } });
const reply = (result = snapshot(), req = request) => ({ version: 1, requestId: req.requestId, operation: req.operation, ok: true, result });
const encode = value => Buffer.from(JSON.stringify(value) + '\n');

test('production request schema rejects malformed identity, paths and Unicode before any spawn', () => {
  assert.deepEqual(encodeRequest(request), encode(request));
  for (const patch of [{ version: 2 }, { requestId: '00000000-0000-0000-0000-000000000000' }, { requestId: 'UPPERCASE' },
    { operation: 'input' }, { operation: { toString: () => 'snapshot' } }, { params: { other: true } }, { extra: true }])
    assert.throws(() => encodeRequest({ ...request, ...patch }), { code: 'WINDOWS_SAMPLER_INVALID_REQUEST' });
  for (const paths of [['relative'], ['\\root-relative'], ['C:\\file', 'c:\\file'], ['C:\\line\nfeed'], ['C:\\control\u0080'], ['C:\\bad\udfff'], ['C:\\bad\ud800'], 'C:\\file'])
    assert.throws(() => encodeRequest({ ...request, operation: 'fileLocks', params: { paths } }), { code: 'WINDOWS_SAMPLER_INVALID_REQUEST' });
  assert.doesNotThrow(() => encodeRequest({ ...request, operation: 'fileLocks', params: { paths: ['\\\\owned\\share\\file.txt', 'C:\\valid\ud83d\ude00'] } }));
});
test('positive UInt64 FILETIME identity remains exact above Number precision', () => {
  for (const value of ['1', row.creationFileTime, '18446744073709551615']) assert.equal(birth(value), true);
  for (const value of ['0', '01', '-1', '1e6', '18446744073709551616', Number(row.creationFileTime), null]) assert.equal(birth(value), false);
  const result = decode(encode(reply()), request, 0); assert.equal(result.processes[0].creationFileTime, row.creationFileTime);
});
test('complete snapshot requires unique PIDs, bounded fields and accurate unavailable identity', () => {
  const unavailable = { ...row, pid: 124, identityStatus: 'unavailable', creationFileTime: null, identityReason: 'open_failed', identityWin32Error: 5 };
  assert.equal(decode(encode(reply({ ...snapshot(), processes: [row, unavailable] })), request, 0).processes.length, 2);
  for (const processes of [[], [row, row], [{ ...row, pid: 0 }], [{ ...row, parentPid: -1 }],
    [{ ...row, identityReason: 'open_failed' }], [{ ...unavailable, creationFileTime: row.creationFileTime }], [{ ...unavailable, identityReason: 'unknown' }],
    [{ ...row, commandLine: '' }], [{ ...row, commandLine: 'x'.repeat(32769) }], [{ ...row, name: 'x'.repeat(513) }],
    [{ ...row, name: '\udfff' }], [{ ...row, startedAt: 'not a date' }], [{ ...row, guessed: true }]])
    assert.throws(() => decode(encode(reply({ ...snapshot(), processes })), request, 0));
  assert.throws(() => decode(encode(reply({ ...snapshot(), complete: false })), request, 0), { code: 'WINDOWS_SAMPLER_INCOMPLETE_EVIDENCE' });
  assert.throws(() => decode(encode(reply({ ...snapshot(), timings: { totalMs: 1 } })), request, 0), { code: 'WINDOWS_SAMPLER_INVALID_RESPONSE' });
});
test('RM response requires exact requested paths, deduplication and consistent PID birth', () => {
  const req = { ...request, operation: 'fileLocks', params: { paths: ['C:\\owned\\a', 'C:\\owned\\b'] } };
  const first = { path: req.params.paths[0], pid: row.pid, creationFileTime: row.creationFileTime };
  const value = { rows: [first, { ...first, path: req.params.paths[1] }], complete: true, timings: { totalMs: 1 } };
  assert.deepEqual(decode(encode(reply(value, req)), req, 0), value);
  assert.equal(decode(encode(reply({ ...value, rows: [] }, req)), req, 0).rows.length, 0);
  for (const rows of [[first, first], [{ ...first, path: 'C:\\unrequested' }], [first, { ...first, path: req.params.paths[1], creationFileTime: '134273376000000002' }]])
    assert.throws(() => decode(encode(reply({ ...value, rows }, req)), req, 0));
});
test('wire validation rejects ambiguity, malformed UTF8, excess depth and mismatched envelope', () => {
  const text = JSON.stringify(reply());
  for (const value of [text.replace('"ok":true', '"ok":false,"ok":true'), text.replace('"ok":true', '"o\\u006b":false,"ok":true'),
    text.replace('"creationFileTime":', '"creationFile\\u0054ime":"1","creationFileTime":')])
    assert.throws(() => decode(Buffer.from(value + '\n'), request, 0), { code: 'WINDOWS_SAMPLER_AMBIGUOUS_JSON' });
  for (const bytes of [Buffer.from('{}'), Buffer.from([0xff, 10]), Buffer.concat([encode(reply()), encode(reply())]), Buffer.from('log\n' + text + '\n')])
    assert.throws(() => decode(bytes, request, 0));
  assert.throws(() => decode(Buffer.from('['.repeat(18) + '0' + ']'.repeat(18) + '\n'), request, 0), { code: 'WINDOWS_SAMPLER_JSON_DEPTH' });
  for (const patch of [{ version: 2 }, { requestId: 'other' }, { operation: 'fileLocks' }])
    assert.throws(() => decode(encode({ ...reply(), ...patch }), request, 0), { code: 'WINDOWS_SAMPLER_RESPONSE_MISMATCH' });
  assert.throws(() => decode(encode(reply()), request, 2), { code: 'WINDOWS_SAMPLER_EXIT_MISMATCH' });
});
test('request bytes and total reply counts share the native caps', () => {
  assert.equal(limits.paths, 256); assert.equal(limits.lockRows, 16384);
  const req = { ...request, operation: 'fileLocks', params: { paths: ['C:\\owned\\file.txt'] } };
  assert.throws(() => encodeRequest({ ...req, params: { paths: Array.from({ length: 257 }, (_, index) => 'C:\\' + index) } }));
  assert.throws(() => encodeRequest({ ...req, params: { paths: Array.from({ length: 10 }, (_, index) => 'C:\\' + index + 'x'.repeat(30000)) } }), { code: 'WINDOWS_SAMPLER_REQUEST_TOO_LARGE' });
  assert.throws(() => decode(encode(reply({ complete: true, timings: { totalMs: 1 }, rows: Array.from({ length: 16385 }, (_, index) => ({ path: req.params.paths[0], pid: index + 1, creationFileTime: row.creationFileTime })) }, req)), req, 0));
  assert.throws(() => decode(Buffer.alloc(limits.responseBytes + 1), request, 0), { code: 'WINDOWS_SAMPLER_RESPONSE_TOO_LARGE' });
});
test('native failure and cleanup errors expose only bounded structured diagnostics', () => {
  const error = { code: 'WINDOWS_SAMPLER_PROVIDER_FAILED', stage: 'process_close', cleanupFailed: true, cleanupWin32Error: 6 };
  const value = { version: 1, requestId: request.requestId, operation: request.operation, ok: false, error };
  assert.throws(() => decode(encode(value), request, 2), failure => failure.code === error.code && failure.outcome === 'unavailable' && failure.details.cleanupWin32Error === 6);
  for (const patch of [{ stage: 'guess' }, { rawException: 'user command line' }, { cleanupFailed: false }])
    assert.throws(() => decode(encode({ ...value, error: { ...error, ...patch } }), request, 2), { code: 'WINDOWS_SAMPLER_INVALID_RESPONSE' });
  assert.throws(() => decode(encode(value), request, 0), { code: 'WINDOWS_SAMPLER_EXIT_MISMATCH' });
});
test('production and retained e2e protocol agree on valid native snapshot and RM fixtures', async () => {
  const prototype = await import('../scripts/e2e/windows-sampler-protocol.mjs');
  assert.deepEqual(decode(encode(reply()), request, 0), prototype.validateSamplerReply(encode(reply()), request, 0));
  const req = { ...request, operation: 'fileLocks', params: { paths: ['C:\\owned\\file.txt'] } };
  const value = reply({ rows: [{ path: req.params.paths[0], pid: 123, creationFileTime: row.creationFileTime }], complete: true, timings: { totalMs: 1 } }, req);
  assert.deepEqual(decode(encode(value), req, 0), prototype.validateSamplerReply(encode(value), req, 0));
});
