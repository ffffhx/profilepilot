const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const { promisify } = require('node:util');

const forbidden = () => assert.fail('Unexpected real OS access');
function load(name, stubs = {}) {
  const filename = path.resolve(__dirname, '../src/main', name + '.ts');
  const code = transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} };
  const requireStub = id => Object.hasOwn(stubs, id) ? stubs[id]
    : id === 'node:path' ? path.win32
    : id === './profile-process-change' || id === './windows-sampler-protocol' ? load(id.slice(2))
    : id === 'node:child_process' ? { execFile: forbidden }
    : id.startsWith('node:') ? require(id) : {};
  vm.runInThisContext(`(function(require,module,exports,process){${code}\n})`, { filename })(requireStub, module, module.exports, { platform: 'win32', env: {} });
  return module.exports;
}
const profile = 'C:\\Data\\Profile 1', file = path.win32.join(profile, 'History');
const row = (pid, birth, extra = {}) => ({ pid, parentPid: 0, name: 'worker.exe', executablePath: 'C:\\worker.exe',
  commandLine: 'worker.exe', commandLineAvailable: true, startedAt: null, identityStatus: 'confirmed', creationFileTime: birth, ...extra });
const snapshot = processes => ({ processes, tcp: [], processesAvailable: true, processesComplete: true, tcpAvailable: true, tcpComplete: true });
function scanner(processes, locks) {
  const api = load('process-scan', {
    'node:fs': { existsSync: forbidden, promises: { stat: async candidate => ({ isFile: () => candidate === file }) } },
    './windows-platform': { getWindowsSystemSnapshot: forbidden, collectWindowsControlSample: forbidden,
      createWindowsReadContext: () => ({ now: Date.now, deadlineAt: Date.now() + 8000, signal: new AbortController().signal }),
      findWindowsProcessesLockingPaths: async () => new Map([[file, locks.map(lock => lock.pid)]]),
      findWindowsProcessIdentitiesLockingPaths: async () => new Map([[file, locks]]) },
    './cdp-client': { parseRemoteDebuggingPort: () => null },
    './fs-util': { uniqueNumbers: numbers => [...new Set(numbers)], compareNumbers: (a, b) => a - b }
  });
  return { api, options: { strict: true, windowsSnapshot: snapshot(processes) } };
}
for (const [name, processes, locks, stage] of [
  ['same PID with a different birth', [row(10, '100')], [{ pid: 10, creationFileTime: '101' }], 'windows_rm_birth_join'],
  ['unavailable pinned identity', [row(10, null, { identityStatus: 'unavailable' })], [{ pid: 10, creationFileTime: '100' }], 'windows_rm_birth_join'],
  ['reused parent newer than child', [row(10, '100', { parentPid: 20 }), row(20, '101', { name: 'chrome.exe', commandLine: 'chrome.exe' })], [{ pid: 10, creationFileTime: '100' }], 'windows_parent_identity']
]) test('strict file mapping rejects ' + name, async () => {
  const { api, options } = scanner(processes, locks);
  await assert.rejects(api.getOpenProfilePidsByPath([profile], options), error => error.code === 'PROFILE_FILE_PROCESS_CHANGED' && error.profileProcessChange?.stage === stage);
});
test('strict file mapping preserves exact UInt64 births above Number precision', async () => {
  const { api, options } = scanner([row(10, '134060000000000001')], [{ pid: 10, creationFileTime: '134060000000000001' }]);
  assert.deepEqual((await api.getOpenProfilePidsByPath([profile], options)).get(profile), [10]);
  const second = scanner([row(10, '134060000000000001')], [{ pid: 10, creationFileTime: '134060000000000002' }]);
  await assert.rejects(second.api.getOpenProfilePidsByPath([profile], second.options), /PROFILE_FILE_PROCESS_CHANGED/);
});
function platformClient(read) {
  const execFile = forbidden.bind(null); execFile[promisify.custom] = forbidden;
  return load('windows-platform', { 'node:child_process': { execFile }, './windows-sampler': {
    sampleWindowsProcesses: forbidden, sampleWindowsFileLocks: read } });
}
test('strict RM adapter batches count and bytes under one context and rejects cross-batch identity conflict', async () => {
  const calls = [], context = { now: () => 1, deadlineAt: 8001, signal: new AbortController().signal };
  const api = platformClient(async (paths, actualContext) => { calls.push(paths); assert.equal(actualContext, context);
    return { complete: true, rows: [{ path: paths[0], pid: 10, creationFileTime: calls.length === 1 ? '100' : '101' }] }; });
  await assert.rejects(api.findWindowsProcessIdentitiesLockingPaths(Array.from({ length: 257 }, (_, n) => `C:\\Data\\${n}`), { context }), /PROFILE_FILE_PROCESS_CHANGED/);
  assert.deepEqual(calls.map(batch => batch.length), [256, 1]);
});
test('strict RM adapter counts escaped UTF8 bytes and aborts between batches without publishing partial rows', async () => {
  const controller = new AbortController(), calls = [];
  const api = platformClient(async paths => { calls.push(paths); controller.abort(); return { complete: true, rows: [] }; });
  const paths = Array.from({ length: 20 }, (_, n) => 'C:\\' + '界'.repeat(10000) + n);
  await assert.rejects(api.findWindowsProcessIdentitiesLockingPaths(paths, { context: { now: () => 1, deadlineAt: 8001, signal: controller.signal } }), /CANCELLED|ABORT|TIMEOUT/);
  assert.equal(calls.length, 1); assert.ok(calls[0].length < 20);
  assert.ok(Buffer.byteLength(JSON.stringify({ version: 1, requestId: '1'.repeat(36), operation: 'fileLocks', params: { paths: calls[0] } }) + '\n') <= 256 * 1024);
});

test('failed native sampling waits for both TCP families before the round can be released', async () => {
  const failure = new Error('original native failure'), pending = [], calls = [];
  const execFile = forbidden.bind(null); execFile[promisify.custom] = (_file, args) => { calls.push(args.at(-1)); return new Promise(resolve => pending.push(resolve)); };
  const api = load('windows-platform', { 'node:child_process': { execFile }, './windows-sampler': {
    sampleWindowsProcesses: async () => { throw failure; }, sampleWindowsFileLocks: forbidden } });
  let settled = false; const read = api.collectWindowsControlSample().finally(() => { settled = true; });
  const rejected = assert.rejects(read, error => error === failure);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, ['tcp', 'tcpv6']); assert.equal(settled, false);
  pending[0]({ stdout: '' }); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  pending[1]({ stdout: '' }); await rejected; assert.equal(settled, true);
});
test('native preparation that exhausts the original deadline cannot start either TCP child', async () => {
  let now = 0, calls = 0;
  const execFile = forbidden.bind(null); execFile[promisify.custom] = () => { calls++; return Promise.resolve({ stdout: '' }); };
  const api = load('windows-platform', { 'node:child_process': { execFile }, './windows-sampler': {
    sampleWindowsProcesses: () => { now = 6; return Promise.resolve({ processes: [], complete: true }); }, sampleWindowsFileLocks: forbidden } });
  await assert.rejects(api.collectWindowsControlSample({ now: () => now, deadlineAt: 5, signal: new AbortController().signal }), /TIMEOUT/);
  assert.equal(calls, 0);
});

test('a direct strict file query without a snapshot uses native evidence and the same fixed context', async () => {
  let reads = 0, locks = 0; const context = { now: Date.now, deadlineAt: Date.now() + 8000, signal: new AbortController().signal };
  const api = load('process-scan', {
    'node:fs': { existsSync: forbidden, promises: { stat: async candidate => ({ isFile: () => candidate === file }) } },
    './cdp-client': { parseRemoteDebuggingPort: () => null },
    './windows-platform': { getWindowsSystemSnapshot: forbidden, createWindowsReadContext: () => context,
      collectWindowsControlSample: async actual => { reads++; assert.equal(actual, context); return { snapshotId: 'fresh-fixture', capturedAt: 1, context, snapshot: snapshot([row(10, '100')]) }; },
      findWindowsProcessIdentitiesLockingPaths: async (_paths, options) => { locks++; assert.equal(options.context, context); return new Map([[file, [{ pid: 10, creationFileTime: '100' }]]]); } }
  });
  assert.deepEqual((await api.getOpenProfilePidsByPath([profile], { strict: true })).get(profile), [10]); assert.equal(reads, 1); assert.equal(locks, 1);
});
test('final runtime mapping rejects a different birth even when both lists contain the PID', () => {
  const { api, options } = scanner([row(10, '100')], []);
  assert.doesNotThrow(() => api.requireWindowsRuntimeIdentity(row(10, '100'), options));
  assert.throws(() => api.requireWindowsRuntimeIdentity(row(10, '101'), options), error => error.profileProcessChange.stage === 'profile_runtime_birth_join');
});
test('RM aggregate row cap applies across batches, and missing file rows represent complete emptiness', async () => {
  let calls = 0;
  const api = platformClient(async paths => ({ complete: true, rows: ++calls === 1
    ? Array.from({ length: 16384 }, (_, n) => ({ path: paths[0], pid: n + 1, creationFileTime: '100' }))
    : [{ path: paths[0], pid: 20000, creationFileTime: '100' }] }));
  await assert.rejects(api.findWindowsProcessIdentitiesLockingPaths(Array.from({ length: 257 }, (_, n) => 'C:\\' + n)), /PROFILE_FILE_SCAN_TOO_LARGE/);
  assert.equal(calls, 2);
  const empty = platformClient(async () => ({ complete: true, rows: [] }));
  assert.equal((await empty.findWindowsProcessIdentitiesLockingPaths([file])).size, 0);
});
test('case aliases share one RM request and both map to the same confirmed identity', async () => {
  const upper = file.toUpperCase(); let calls = 0;
  const api = platformClient(async paths => { calls++; assert.deepEqual(paths, [file]); return { complete: true, rows: [{ path: file, pid: 10, creationFileTime: '100' }] }; });
  const found = await api.findWindowsProcessIdentitiesLockingPaths([file, upper]);
  assert.equal(calls, 1); assert.deepEqual(found.get(file), found.get(upper));
});

test('identity rejection records the actual origin and a bounded reason while keeping refusal unchanged', async () => {
  for (const [processes, locks, expected] of [
    [[row(10, null, { identityStatus: 'unavailable', identityReason: 'open_failed' })], [{ pid: 10, creationFileTime: '100' }], { origin: 'restart_manager', reason: 'unavailable', identityReason: 'open_failed' }],
    [[row(10, '100')], [{ pid: 10, creationFileTime: '101' }], { origin: 'restart_manager', reason: 'birth_mismatch' }],
    [[row(10, 'bad')], [{ pid: 10, creationFileTime: '100' }], { origin: 'restart_manager', reason: 'invalid_birth' }],
    [[row(10, null, { identityStatus: 'unavailable', identityReason: 'exited', commandLine: 'chrome.exe --profile-directory="Profile 1"' })], [], { origin: 'profile_command', reason: 'unavailable', identityReason: 'exited' }],
    [[row(10, '100', { parentPid: 20 }), row(20, '101')], [{ pid: 10, creationFileTime: '100' }], { origin: 'parent_chain', reason: 'parent_newer' }]
  ]) {
    const { api, options } = scanner(processes, locks);
    await assert.rejects(api.getOpenProfilePidsByPath([profile], options), error => {
      assert.equal(error.message, 'PROFILE_FILE_PROCESS_CHANGED');
      for (const [key, value] of Object.entries(expected)) assert.equal(error.profileProcessChange[key], value);
      assert.equal(Object.hasOwn(error.profileProcessChange, 'creationFileTime'), false); return true;
    });
  }
});
