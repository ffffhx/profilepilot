const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { buildSync } = require('esbuild');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { WindowsSamplerClient } = loadCli('src/main/windows-sampler.ts');
const { WINDOWS_SAMPLER_LIMITS } = loadCli('src/main/windows-sampler-protocol.ts');

function clock() {
  let value = 0, id = 0; const pending = new Map();
  return { now: () => value, setNow(next) { value = next; },
    timers: { set(callback, milliseconds) { const key = ++id; pending.set(key, { at: value + milliseconds, callback }); return key; }, clear(key) { pending.delete(key); } },
    advance(milliseconds) {
      const target = value + milliseconds;
      for (;;) {
        const next = [...pending].filter(([, row]) => row.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        pending.delete(next[0]); value = next[1].at; next[1].callback();
      }
      value = target;
    }, count: () => pending.size };
}
function result(operation) {
  return operation === 'fileLocks' ? { rows: [], complete: true, timings: { totalMs: 1 } } : {
    processes: [{ pid: 456, parentPid: 123, name: 'fixture.exe', executablePath: 'C:\\owned\\fixture.exe', commandLine: 'fixture.exe', commandLineAvailable: true,
      startedAt: null, creationFileTime: '134273376000000007', identityStatus: 'confirmed' }], complete: true, timings: { totalMs: 1, enumerateMs: 0, pinMs: 0, cimMs: 1 } };
}
function fixture(options = {}) {
  const time = clock(), children = []; let prepared = 0;
  const spawnProcess = (executable, args, spawnOptions) => {
    assert.equal(executable, 'owned-runtime.exe'); assert.deepEqual(args, []); assert.deepEqual(spawnOptions, { windowsHide: true, stdio: 'pipe' });
    const child = Object.assign(new EventEmitter(), { pid: 1000 + children.length, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new EventEmitter(), kills: 0, requests: [] });
    child.stdin.end = bytes => { child.requests.push(JSON.parse(bytes)); options.onInput?.(child, child.requests.at(-1)); };
    child.reply = (value = result(child.requests[0].operation), patch = {}) => {
      const request = child.requests[0]; child.stdout.emit('data', Buffer.from(JSON.stringify({ version: 1, requestId: request.requestId, operation: request.operation, ok: true, result: value, ...patch }) + '\n'));
    };
    child.close = code => child.emit('close', code);
    child.kill = () => { child.kills++; if (options.kill) return options.kill(child); return true; };
    children.push(child); options.onSpawn?.(child); return child;
  };
  const client = new WindowsSamplerClient({ platform: 'win32', prepareExecutable: () => { prepared++; options.prepare?.(); return 'owned-runtime.exe'; },
    spawnProcess, timers: time.timers, killGraceMs: 10, ...options.client });
  const context = (deadlineAt = 1000, controller = new AbortController()) => ({ deadlineAt, now: time.now, signal: controller.signal });
  return { client, children, time, context, prepared: () => prepared };
}
const rejected = (promise, code) => assert.rejects(promise, { code, outcome: 'unavailable' });

test('fresh requests are serialized; success is withheld until close after complete stdout', async () => {
  const f = fixture(), first = f.client.sampleWindowsProcesses(f.context()), second = f.client.sampleWindowsFileLocks(['C:\\owned\\nonce.txt'], f.context());
  let done = false; first.then(() => { done = true; });
  assert.equal(f.children.length, 1); f.children[0].reply(); f.children[0].emit('exit', 0);
  await Promise.resolve(); assert.equal(done, false); assert.equal(f.children.length, 1);
  f.children[0].close(0); assert.equal((await first).processes[0].creationFileTime, '134273376000000007');
  assert.equal(f.children.length, 2); assert.equal(f.children[1].requests[0].operation, 'fileLocks');
  f.children[1].reply(); f.children[1].close(0); assert.equal((await second).complete, true); assert.equal(f.time.count(), 0);
});
test('queued deadlines remain original when an earlier request consumes most of the budget', async () => {
  const f = fixture({ kill: child => { child.close(null); return true; } });
  const first = f.client.sampleWindowsProcesses(f.context()), next = f.client.sampleWindowsProcesses(f.context(350));
  const timed = rejected(next, 'WINDOWS_SAMPLER_TIMEOUT');
  f.time.advance(300); f.children[0].reply(); f.children[0].close(0); await first; assert.equal(f.children.length, 2);
  f.time.advance(50); await timed; assert.equal(f.children[1].kills, 1); assert.equal(f.time.now(), 350);
});
test('expired and aborted queued reads never spawn or cancel the active read', async () => {
  const f = fixture(), controller = new AbortController();
  const first = f.client.sampleWindowsProcesses(f.context());
  const expires = rejected(f.client.sampleWindowsProcesses(f.context(20)), 'WINDOWS_SAMPLER_TIMEOUT');
  const cancels = rejected(f.client.sampleWindowsProcesses(f.context(500, controller)), 'WINDOWS_SAMPLER_ABORTED');
  controller.abort(); f.time.advance(20); await Promise.all([expires, cancels]);
  assert.equal(f.children.length, 1); assert.equal(f.children[0].kills, 0);
  f.children[0].reply(); f.children[0].close(0); await first; assert.equal(f.children.length, 1);
});
test('bounded queue rejects excess calls and retains the admitted queue order', async () => {
  const f = fixture({ client: { maxQueued: 1 } });
  const first = f.client.sampleWindowsProcesses(f.context()), second = f.client.sampleWindowsProcesses(f.context());
  await rejected(f.client.sampleWindowsProcesses(f.context()), 'WINDOWS_SAMPLER_BUSY'); assert.equal(f.children.length, 1);
  f.children[0].reply(); f.children[0].close(0); await first; f.children[1].reply(); f.children[1].close(0); await second;
});
test('active abort waits for close; error, exit and accepted kill cannot unlock a replacement', async () => {
  const f = fixture(), controller = new AbortController();
  const first = f.client.sampleWindowsProcesses(f.context(1000, controller)), second = f.client.sampleWindowsProcesses(f.context());
  const firstFailed = rejected(first, 'WINDOWS_SAMPLER_EXIT_UNCONFIRMED'), secondFailed = rejected(second, 'WINDOWS_SAMPLER_EXIT_UNCONFIRMED');
  controller.abort(); const old = f.children[0]; assert.equal(old.kills, 1);
  old.emit('error', new Error('ignored raw message')); old.emit('exit', 0); assert.equal(f.children.length, 1);
  f.time.advance(10); await Promise.all([firstFailed, secondFailed]);
  await rejected(f.client.sampleWindowsProcesses(f.context()), 'WINDOWS_SAMPLER_EXIT_UNCONFIRMED'); assert.equal(f.children.length, 1);
  old.reply(); old.close(0); assert.equal(f.children.length, 1, 'failed queue must never be revived');
  const fresh = f.client.sampleWindowsProcesses(f.context()); assert.equal(f.children.length, 2);
  old.reply(); old.emit('error', new Error('old error')); f.children[1].reply(); f.children[1].close(0); await fresh;
});
test('a rejected or throwing kill keeps the barrier until real close', async () => {
  for (const kill of [() => false, () => { throw new Error('kill refused'); }]) {
    const f = fixture({ kill }); const first = rejected(f.client.sampleWindowsProcesses(f.context(5)), 'WINDOWS_SAMPLER_EXIT_UNCONFIRMED');
    f.time.advance(15); await first;
    await rejected(f.client.sampleWindowsProcesses(f.context()), 'WINDOWS_SAMPLER_EXIT_UNCONFIRMED'); assert.equal(f.children.length, 1);
    f.children[0].close(null); const fresh = f.client.sampleWindowsProcesses(f.context()); f.children[1].reply(); f.children[1].close(0); await fresh;
  }
});
test('confirmed timeout stays failed even if the old child emits a valid late result', async () => {
  const f = fixture({ kill: child => { child.reply(); child.close(0); return true; } });
  const pending = rejected(f.client.sampleWindowsProcesses(f.context(5)), 'WINDOWS_SAMPLER_TIMEOUT');
  f.time.advance(5); await pending; assert.equal(f.children.length, 1); assert.equal(f.time.count(), 0);
});
test('clock expiry is checked again at close even when the timer callback has not run', async () => {
  const f = fixture(); const pending = rejected(f.client.sampleWindowsProcesses(f.context(5)), 'WINDOWS_SAMPLER_TIMEOUT');
  f.children[0].reply(); f.time.setNow(5); f.children[0].close(0); await pending; assert.equal(f.children[0].kills, 0);
});
test('shutdown rejects the queue, cancels once, and permanently prevents another spawn', async () => {
  const f = fixture(); const first = rejected(f.client.sampleWindowsProcesses(f.context()), 'WINDOWS_SAMPLER_CLOSED');
  const second = rejected(f.client.sampleWindowsProcesses(f.context()), 'WINDOWS_SAMPLER_CLOSED');
  const closing = f.client.close(); assert.equal(f.client.close(), closing); assert.equal(f.children[0].kills, 1);
  await rejected(f.client.sampleWindowsProcesses(f.context()), 'WINDOWS_SAMPLER_CLOSED');
  f.children[0].close(null); await Promise.all([first, second, closing]); await f.client.close(); assert.equal(f.children.length, 1);
});
test('shutdown timeout fails but retains child ownership until late close without reviving requests', async () => {
  const f = fixture(); const first = rejected(f.client.sampleWindowsProcesses(f.context()), 'WINDOWS_SAMPLER_EXIT_UNCONFIRMED');
  const closing = rejected(f.client.close(), 'WINDOWS_SAMPLER_EXIT_UNCONFIRMED');
  f.time.advance(10); await Promise.all([first, closing]); f.children[0].close(0); await f.client.close();
  await rejected(f.client.sampleWindowsProcesses(f.context()), 'WINDOWS_SAMPLER_CLOSED'); assert.equal(f.children.length, 1);
});
test('pre-abort, expired context, unsupported platform and malformed paths do not prepare an executable', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await rejected(f.client.sampleWindowsProcesses(f.context(100, controller)), 'WINDOWS_SAMPLER_ABORTED');
  await rejected(f.client.sampleWindowsProcesses(f.context(0)), 'WINDOWS_SAMPLER_TIMEOUT');
  await rejected(f.client.sampleWindowsFileLocks(['\\relative'], f.context()), 'WINDOWS_SAMPLER_INVALID_REQUEST');
  assert.equal(f.prepared(), 0); assert.equal(f.children.length, 0);
  const mac = fixture({ client: { platform: 'darwin' } });
  await rejected(mac.client.sampleWindowsProcesses(mac.context()), 'WINDOWS_SAMPLER_PLATFORM_UNAVAILABLE'); assert.equal(mac.prepared(), 0); assert.equal(mac.children.length, 0);
});
test('caller mutation cannot replace queued paths or its originally registered abort signal', async () => {
  const f = fixture(), controller = new AbortController(); const context = f.context(1000, controller), paths = ['C:\\owned\\nonce.txt'];
  const first = f.client.sampleWindowsProcesses(f.context()), second = f.client.sampleWindowsFileLocks(paths, context);
  paths[0] = 'C:\\other.txt'; context.signal = new AbortController().signal; context.deadlineAt = 999999;
  f.children[0].reply(); f.children[0].close(0); await first;
  assert.deepEqual(f.children[1].requests[0].params.paths, ['C:\\owned\\nonce.txt']);
  const aborts = rejected(second, 'WINDOWS_SAMPLER_ABORTED'); controller.abort(); f.children[1].close(0); await aborts;
});
test('cancellation or clock exhaustion during synchronous preparation never reaches spawn', async () => {
  const controller = new AbortController(); const f = fixture({ prepare: () => controller.abort() });
  await rejected(f.client.sampleWindowsProcesses(f.context(1000, controller)), 'WINDOWS_SAMPLER_ABORTED'); assert.equal(f.children.length, 0);
  let g; g = fixture({ prepare: () => g.time.setNow(5) });
  await rejected(g.client.sampleWindowsProcesses(g.context(5)), 'WINDOWS_SAMPLER_TIMEOUT'); assert.equal(g.children.length, 0);
});
test('missing pipes and asynchronous spawn error cannot release a child before close', async () => {
  const f = fixture({ onSpawn: child => { child.stdout = null; } });
  const failed = rejected(f.client.sampleWindowsProcesses(f.context()), 'WINDOWS_SAMPLER_EXIT_UNCONFIRMED');
  f.children[0].pid = undefined; f.children[0].emit('error', new Error('spawn failure')); f.time.advance(10); await failed;
  await rejected(f.client.sampleWindowsProcesses(f.context()), 'WINDOWS_SAMPLER_EXIT_UNCONFIRMED'); f.children[0].close(null);
});
test('stderr and over-limit stdout fail without returning partial evidence', async () => {
  for (const kind of ['stderr', 'stdout']) {
    const f = fixture({ kill: child => { child.close(null); return true; } });
    const failed = rejected(f.client.sampleWindowsProcesses(f.context()), kind === 'stderr' ? 'WINDOWS_SAMPLER_UNEXPECTED_STDERR' : 'WINDOWS_SAMPLER_RESPONSE_TOO_LARGE');
    f.children[0][kind].emit('data', kind === 'stderr' ? Buffer.from('not stored') : Buffer.alloc(WINDOWS_SAMPLER_LIMITS.responseBytes + 1));
    await failed; assert.equal(f.children[0].kills, 1);
  }
});
test('normal close validates UTF8, request identity, protocol and exit status before resolving', async () => {
  for (const kind of ['utf8', 'requestId', 'exit']) {
    const f = fixture(); const failed = rejected(f.client.sampleWindowsProcesses(f.context()), {
      utf8: 'WINDOWS_SAMPLER_INVALID_UTF8', requestId: 'WINDOWS_SAMPLER_RESPONSE_MISMATCH', exit: 'WINDOWS_SAMPLER_EXIT_MISMATCH' }[kind]);
    if (kind === 'utf8') f.children[0].stdout.emit('data', Buffer.from([0xff, 10]));
    else f.children[0].reply(undefined, kind === 'requestId' ? { requestId: randomUUID() } : {});
    f.children[0].close(kind === 'exit' ? 2 : 0); await failed;
  }
});
test('default request budget caps a much longer caller deadline including time in queue', async () => {
  const f = fixture({ kill: child => { child.close(null); return true; } });
  const pending = rejected(f.client.sampleWindowsProcesses(f.context(100000)), 'WINDOWS_SAMPLER_TIMEOUT');
  f.time.advance(8000); await pending; assert.equal(f.children[0].kills, 1);
});
function isolatedFacade(platform) {
  const entry = path.resolve(__dirname, '../src/main/windows-sampler.ts');
  const code = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' }).outputFiles[0].text;
  let reads = 0, spawns = 0; const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, __dirname: path.dirname(entry), Buffer, AbortController, setTimeout, clearTimeout,
    process: { platform }, require(name) {
      if (name === 'node:child_process') return { spawn() { spawns++; throw new Error('OS spawn forbidden'); } };
      if (name === 'node:fs') return new Proxy({}, { get() { return () => { reads++; throw new Error('FS access forbidden'); }; } });
      return require(name);
    } });
  return { api: module.exports, reads: () => reads, spawns: () => spawns };
}
test('facade close before first use permanently prevents lazy initialization and spawn', async () => {
  const f = isolatedFacade('win32'); assert.equal(f.reads(), 0); assert.equal(f.spawns(), 0);
  await f.api.closeWindowsSampler();
  await rejected(f.api.sampleWindowsProcesses(), 'WINDOWS_SAMPLER_CLOSED');
  await rejected(f.api.sampleWindowsFileLocks(['C:\\owned\\file.txt']), 'WINDOWS_SAMPLER_CLOSED');
  assert.equal(f.reads(), 0); assert.equal(f.spawns(), 0);
});
test('macOS import and unsupported calls never copy or spawn a Windows helper', async () => {
  const f = isolatedFacade('darwin'); assert.equal(f.reads(), 0); assert.equal(f.spawns(), 0);
  await rejected(f.api.sampleWindowsProcesses(), 'WINDOWS_SAMPLER_PLATFORM_UNAVAILABLE'); await f.api.closeWindowsSampler();
  assert.equal(f.reads(), 0); assert.equal(f.spawns(), 0);
});
test('runtime publication uses content hash copy and leaves a corrupt possibly locked entry untouched', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-sampler-runtime-pure-'));
  const source = path.join(directory, 'source.exe'), bytes = Buffer.from('pure fake executable ' + randomUUID()); fs.writeFileSync(source, bytes);
  const cached = path.join(os.tmpdir(), 'profilepilot-windows-sampler-runtime', createHash('sha256').update(bytes).digest('hex') + '.exe');
  fs.mkdirSync(path.dirname(cached), { recursive: true }); fs.writeFileSync(cached, 'corrupt'); let published;
  t.after(() => { for (const file of [source, cached, published]) if (file && fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(directory); });
  const client = new WindowsSamplerClient({ platform: 'win32', executable: source, spawnProcess(file) {
    published = file; assert.notEqual(file, cached); assert.equal(path.dirname(file), path.dirname(cached)); assert.deepEqual(fs.readFileSync(file), bytes);
    const child = Object.assign(new EventEmitter(), { pid: 456, stdin: new EventEmitter(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { return true; } });
    child.stdin.end = input => { const request = JSON.parse(input); queueMicrotask(() => { child.stdout.emit('data', Buffer.from(JSON.stringify({ ...request, params: undefined, ok: true, result: result(request.operation) }) + '\n')); child.emit('close', 0); }); };
    return child;
  } });
  await client.sampleWindowsProcesses(); assert.equal(fs.readFileSync(cached, 'utf8'), 'corrupt'); await client.close();
});
