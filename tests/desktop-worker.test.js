const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { DesktopWorker } = loadCli('src/main/desktop/worker.ts');

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-desktop-worker-test-'));
  const executable = path.join(directory, 'fixture.exe');
  const bytes = Buffer.from('DesktopWorker fake child only: ' + randomUUID());
  const digest = createHash('sha256').update(bytes).digest('hex');
  const runtimeCopy = path.join(os.tmpdir(), 'profilepilot-desktop-runtime', digest + '.exe');
  fs.writeFileSync(executable, bytes);
  const children = [], workers = [], events = [], runtimeFiles = new Set([runtimeCopy]);

  const spawn = (file, args, spawnOptions) => {
    runtimeFiles.add(file);
    if (options.assertExecutable) options.assertExecutable(file, runtimeCopy, bytes);
    else assert.equal(file, runtimeCopy);
    assert.equal(args.length, 2);
    assert.equal(args[0], '--input-marker');
    assert.match(args[1], /^[a-f0-9]{16}$/);
    assert.notEqual(args[1], '0000000000000000');
    assert.equal(spawnOptions.windowsHide, true);
    assert.equal(spawnOptions.stdio, 'pipe');
    const child = new EventEmitter();
    const index = children.length;
    child.pid = 1000 + index;
    child.exitCode = null;
    child.signalCode = null;
    child.requests = [];
    child.inputMarker = args[1];
    child.killCalls = 0;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new EventEmitter();
    child.respond = (request, result = { executed: true }) => child.stdout.emit('data', JSON.stringify({ id: request.id, ok: true, result }) + '\n');
    child.stdin.write = text => {
      const request = JSON.parse(text);
      child.requests.push(request);
      events.push('request:' + index + ':' + request.operation);
      if (options.autoReply !== false) queueMicrotask(() => child.respond(request));
      return true;
    };
    child.stdin.end = text => {
      const request = JSON.parse(text);
      child.requests.push(request);
      events.push('cancel:' + index);
    };
    child.exit = () => {
      if (child.exitCode !== null) return;
      child.exitCode = 0;
      events.push('exit:' + index);
      child.emit('exit', 0, null);
    };
    child.kill = () => {
      child.killCalls++;
      if (options.kill) return options.kill(child);
      child.exit();
      return true;
    };
    options.beforeSpawn?.(child, index);
    children.push(child);
    events.push('spawn:' + index);
    return child;
  };

  t.after(async () => {
    // These are fake children; never launch or terminate an operating-system app.
    for (const child of children) child.exit();
    for (const worker of workers) worker.close();
    await nextTurn();
    for (const file of runtimeFiles) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.unlinkSync(executable);
    fs.rmdirSync(directory);
  });
  return {
    children, events, runtimeCopy, bytes,
    worker() {
      const worker = new DesktopWorker(executable, spawn);
      workers.push(worker);
      return worker;
    }
  };
}

test('one helper keeps its full input marker across requests and a replacement uses a distinct marker', async t => {
  const f = fixture(t), first = f.worker();
  const marker = first.inputMarker;
  assert.match(marker, /^[a-f0-9]{16}$/);
  await first.request('windows', {});
  await first.request('window.action', { kind: 'invoke' });
  assert.equal(f.children[0].inputMarker, marker);
  assert.equal(first.inputMarker, marker);
  first.close(); f.children[0].exit();
  const replacement = f.worker();
  assert.notEqual(replacement.inputMarker, marker);
  await replacement.request('windows', {});
  assert.equal(f.children[1].inputMarker, replacement.inputMarker);
});

test('desktop worker reuses a cached executable only when its actual bytes match', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.runtimeCopy), { recursive: true });
  fs.writeFileSync(f.runtimeCopy, f.bytes, { flag: 'wx' });
  const marker = new Date('2001-01-01T00:00:00.000Z');
  fs.utimesSync(f.runtimeCopy, marker, marker);
  const previous = fs.statSync(f.runtimeCopy).mtimeMs;
  await f.worker().request('windows', {});
  assert.equal(fs.statSync(f.runtimeCopy).mtimeMs, previous, 'verified cache should be reused');
  assert.deepEqual(fs.readFileSync(f.runtimeCopy), f.bytes);
});

test('desktop worker preserves a corrupt potentially running cache and spawns a verified independent copy', async t => {
  let repaired;
  const f = fixture(t, { assertExecutable(file, cached, bytes) {
    repaired = file;
    assert.notEqual(file, cached);
    assert.equal(path.dirname(file), path.dirname(cached));
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(fs.existsSync(file.replace(/\.exe$/, '.tmp')), false, 'partial publication remains visible');
  } });
  fs.mkdirSync(path.dirname(f.runtimeCopy), { recursive: true });
  const corrupt = Buffer.from(f.bytes); corrupt[0] ^= 0xff;
  fs.writeFileSync(f.runtimeCopy, corrupt, { flag: 'wx' });
  await f.worker().request('windows', {});
  assert.ok(repaired);
  assert.deepEqual(fs.readFileSync(f.runtimeCopy), corrupt, 'existing cache must never be overwritten or deleted');
});

test('desktop worker waits for the cancelled helper to exit before starting its replacement', { timeout: 5000 }, async t => {
  const f = fixture(t), old = f.worker();
  await old.request('window.action', { kind: 'click' });
  old.close();
  assert.equal(f.children[0].requests.at(-1).operation, 'cancel');

  const replacement = f.worker();
  let settled = false;
  const pending = replacement.request('windows', {}).then(value => { settled = true; return value; });
  await nextTurn();
  assert.equal(settled, false);
  assert.equal(f.children.length, 1, 'replacement must not spawn while the old helper releases input');

  f.children[0].exit();
  await pending;
  assert.equal(f.children.length, 2);
  assert.ok(f.events.indexOf('exit:0') < f.events.indexOf('spawn:1'));
  assert.equal(f.children[0].killCalls, 0, 'cooperative cancellation does not need forced termination');
});

test('worker close synchronously cancels once and returns the same pending exit confirmation', async t => {
  const f = fixture(t), worker = f.worker(); await worker.request('windows', {});
  let settled = false; const closing = worker.close(); closing.then(() => { settled = true; });
  assert.equal(worker.close(), closing); assert.equal(worker.stopConfirmed, false);
  assert.deepEqual(f.children[0].requests.map(request => request.operation), ['windows', 'cancel']);
  await nextTurn(); assert.equal(settled, false);
  f.children[0].exit(); await closing;
  assert.equal(worker.stopConfirmed, true); assert.equal(worker.close(), closing);
  const unused = f.worker(), unusedClose = unused.close(); await unusedClose;
  assert.equal(unused.stopConfirmed, true); assert.equal(unused.close(), unusedClose);
  assert.equal(f.children.length, 1, 'closing an unused driver must not spawn');
});

test('a cached failed stop remains reportable while late exit permits an explicit replacement', async t => {
  const f = fixture(t), worker = f.worker(); await worker.request('windows', {});
  const closing = worker.close(), rejected = assert.rejects(closing, error => {
    assert.equal(error.code, 'DESKTOP_DRIVER_STOP_UNCONFIRMED');
    assert.deepEqual(error.details.stop, { pid: f.children[0].pid, reason: 'process_error', errorCode: 'EPERM', killAttempted: false, killAccepted: null, cancelWriteFailed: false });
    assert.equal(JSON.stringify(error.details).includes('fake live process'), false); return true;
  });
  f.children[0].emit('error', Object.assign(new Error('fake live process'), { code: 'EPERM' })); await rejected;
  assert.equal(worker.stopConfirmed, false); assert.equal(worker.close(), closing);
  f.children[0].exit(); assert.equal(worker.stopConfirmed, true);
  await assert.rejects(worker.close(), { code: 'DESKTOP_DRIVER_STOP_UNCONFIRMED' });
  await f.worker().request('windows', {}); assert.equal(f.children.length, 2);
});

test('stdout closure starts retirement but cannot itself confirm that the process exited', async t => {
  const f = fixture(t), worker = f.worker(); await worker.request('windows', {});
  const child = f.children[0]; child.stdout.emit('close');
  let settled = false; const closing = worker.close(); closing.then(() => { settled = true; });
  await nextTurn(); assert.equal(settled, false); assert.equal(worker.stopConfirmed, false);
  assert.equal(child.exitCode, null); assert.equal(child.requests.at(-1).operation, 'cancel');
  child.exit(); await closing; assert.equal(worker.stopConfirmed, true);
});

test('cooperative cancellation waits 750ms, then exit confirmation expires at 1500ms without pretending kill is exit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { kill: () => true }), worker = f.worker(); await worker.request('windows', {});
  let state = 'pending'; const closing = worker.close(); closing.then(() => { state = 'resolved'; }, () => { state = 'rejected'; });
  const rejected = assert.rejects(closing, error => {
    assert.equal(error.code, 'DESKTOP_DRIVER_STOP_UNCONFIRMED');
    assert.deepEqual(error.details.stop, { pid: f.children[0].pid, reason: 'exit_timeout', killAttempted: true, killAccepted: true, cancelWriteFailed: false }); return true;
  });
  t.mock.timers.tick(749); await Promise.resolve(); assert.equal(f.children[0].killCalls, 0); assert.equal(state, 'pending');
  t.mock.timers.tick(1); await Promise.resolve(); assert.equal(f.children[0].killCalls, 1); assert.equal(state, 'pending');
  t.mock.timers.tick(749); await Promise.resolve(); assert.equal(state, 'pending'); assert.equal(worker.stopConfirmed, false);
  t.mock.timers.tick(1); await rejected; assert.equal(state, 'rejected'); assert.equal(worker.stopConfirmed, false);
  f.children[0].exit(); assert.equal(worker.stopConfirmed, true);
  await f.worker().request('windows', {}); assert.equal(f.children.length, 2, 'late actual exit releases only the replacement barrier');
});

test('a failed cancellation write attempts kill immediately and bounds its confirmation wait to 750ms', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { kill: () => true, beforeSpawn(child) { child.stdin.end = () => { throw new Error('fake pipe unavailable'); }; } });
  const worker = f.worker(); await worker.request('windows', {});
  const closing = worker.close(), rejected = assert.rejects(closing, error => {
    assert.equal(error.code, 'DESKTOP_DRIVER_STOP_UNCONFIRMED');
    assert.deepEqual(error.details.stop, { pid: f.children[0].pid, reason: 'exit_timeout', killAttempted: true, killAccepted: true, cancelWriteFailed: true }); return true;
  });
  assert.equal(f.children[0].killCalls, 1); assert.equal(worker.stopConfirmed, false);
  t.mock.timers.tick(749); await Promise.resolve(); assert.equal(worker.stopConfirmed, false);
  t.mock.timers.tick(1); await rejected; assert.equal(worker.stopConfirmed, false);
  f.children[0].exit(); assert.equal(worker.stopConfirmed, true);
});

test('an initially empty stop barrier cannot yield into another helper cancellation', { timeout: 5000 }, async t => {
  const f = fixture(t), old = f.worker();
  await old.request('window.action', { kind: 'click' });
  const replacement = f.worker();
  const pending = replacement.request('window.action', { kind: 'click' });
  old.close();
  await nextTurn();

  const dispatched = f.events.indexOf('request:1:window.action');
  const cancelled = f.events.indexOf('cancel:0');
  assert.ok(cancelled >= 0);
  // Dispatch before cancellation is allowed. Dispatch during input release is
  // not; a deferred request instead has to wait for the helper's actual exit.
  assert.ok(dispatched < 0 || dispatched < cancelled, JSON.stringify(f.events));
  f.children[0].exit();
  await pending;
  const finalDispatch = f.events.indexOf('request:1:window.action');
  assert.ok(finalDispatch < cancelled || f.events.indexOf('exit:0') < finalDispatch, JSON.stringify(f.events));
});

test('a helper retiring during an existing wait extends the stop barrier', { timeout: 5000 }, async t => {
  const f = fixture(t), first = f.worker(), second = f.worker();
  await first.request('windows', {});
  await second.request('windows', {});
  first.close();
  const replacement = f.worker();
  const pending = replacement.request('window.action', { kind: 'click' });
  second.close();

  f.children[0].exit();
  await nextTurn();
  assert.equal(f.children.length, 2, 'finishing the original barrier must not bypass a later retiring helper');
  assert.equal(f.children[1].exitCode, null);

  f.children[1].exit();
  await pending;
  assert.equal(f.children.length, 3);
  assert.ok(f.events.indexOf('exit:0') < f.events.indexOf('spawn:2'));
  assert.ok(f.events.indexOf('exit:1') < f.events.indexOf('spawn:2'));
});

test('a live helper error retains the stop barrier; a later exit permits recovery', { timeout: 5000 }, async t => {
  const f = fixture(t), old = f.worker();
  await old.request('window.action', { kind: 'click' });
  old.close();
  const replacement = f.worker();
  const blocked = assert.rejects(replacement.request('window.action', { kind: 'click' }), { code: 'DESKTOP_DRIVER_STOP_UNCONFIRMED' });
  await nextTurn();
  f.children[0].emit('error', Object.assign(new Error('termination denied'), { code: 'EPERM' }));
  await blocked;
  assert.equal(f.children[0].exitCode, null);
  assert.equal(f.children[0].signalCode, null);
  assert.equal(f.children.length, 1, 'an error event is not evidence of exit');
  await assert.rejects(replacement.request('windows', {}), { code: 'DESKTOP_DRIVER_STOP_UNCONFIRMED' });
  assert.equal(f.children.length, 1, 'a repeated request must not bypass the rejected barrier');

  f.children[0].exit();
  await nextTurn();
  await replacement.request('windows', {});
  assert.equal(f.children.length, 2);
  assert.deepEqual(f.children[1].requests.map(request => request.operation), ['windows'], 'failed requests must never replay');
});

test('closing a worker rejects an in-flight action as unknown and ignores a late reply', { timeout: 5000 }, async t => {
  const f = fixture(t, { autoReply: false }), worker = f.worker();
  const pending = worker.request('window.action', { kind: 'drag' });
  const unknown = assert.rejects(pending, { code: 'DESKTOP_OUTCOME_UNKNOWN' });
  await nextTurn();
  const child = f.children[0];
  worker.close();
  await unknown;
  child.respond(child.requests[0]);
  assert.deepEqual(child.requests.map(request => request.operation), ['window.action', 'cancel']);
  child.exit();
  await assert.rejects(worker.request('windows', {}), { code: 'DESKTOP_READ_INTERRUPTED' });
  assert.equal(f.children.length, 1);
});

test('a failed kill cannot release the desktop worker stop barrier', { timeout: 5000 }, async t => {
  const f = fixture(t, { kill: () => false }), old = f.worker();
  await old.request('windows', {});
  old.close();
  await assert.rejects(f.worker().request('windows', {}), { code: 'DESKTOP_DRIVER_STOP_UNCONFIRMED' });
  assert.equal(f.children[0].killCalls, 1);
  assert.equal(f.children[0].exitCode, null);
  assert.equal(f.children.length, 1);
});

test('a successful kill request still requires an exit confirmation', { timeout: 5000 }, async t => {
  const f = fixture(t, { kill: () => true }), old = f.worker();
  await old.request('windows', {});
  old.close();
  await assert.rejects(f.worker().request('windows', {}), { code: 'DESKTOP_DRIVER_STOP_UNCONFIRMED' });
  assert.equal(f.children[0].killCalls, 1);
  assert.equal(f.children[0].exitCode, null);
  assert.equal(f.children.length, 1, 'a kill request alone must not let another helper start');
});

test('native failure retains the original cause and safe diagnostic fields', async t => {
  const f = fixture(t, { autoReply: false }), worker = f.worker();
  const pending = worker.request('window.action', { kind: 'click' });
  const diagnostics = { source: { pid: 1000 }, target: { pid: 1001 }, activation: { apiAccepted: false, confirmed: false } };
  const failed = assert.rejects(pending, error => {
    assert.equal(error.code, 'DESKTOP_FOCUS_REQUIRED');
    assert.equal(error.cause, 'FOREGROUND_NOT_CONFIRMED');
    assert.deepEqual(error.details, { cause: 'FOREGROUND_NOT_CONFIRMED', diagnostics });
    return true;
  });
  await nextTurn(); const child = f.children[0];
  child.stdout.emit('data', JSON.stringify({ id: child.requests[0].id, ok: false, code: 'DESKTOP_FOCUS_REQUIRED', cause: 'FOREGROUND_NOT_CONFIRMED', diagnostics }) + '\n');
  await failed;
});

test('the first spawn error without a PID cannot leave a retirement barrier', async t => {
  const f = fixture(t, { autoReply: false }), first = f.worker();
  const failed = assert.rejects(first.request('windows', {}), { code: 'DESKTOP_READ_INTERRUPTED' });
  const child = f.children[0]; child.pid = undefined;
  child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }));
  await failed;
  const next = f.worker().request('windows', {});
  await nextTurn();
  assert.equal(f.children.length, 2, 'a process that never existed must not block replacement');
  assert.equal(child.killCalls, 0);
  f.children[1].respond(f.children[1].requests[0], { windows: [] });
  assert.deepEqual(await next, { windows: [] });
});

test('spawn failure with missing pipes still handles its later error event', async t => {
  const f = fixture(t, { beforeSpawn(child, index) {
    if (index === 0) { child.pid = undefined; child.stdout = child.stdin = child.stderr = undefined; }
  } });
  await assert.rejects(f.worker().request('windows', {}), { code: 'DESKTOP_READ_INTERRUPTED' });
  assert.doesNotThrow(() => f.children[0].emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' })));
  await f.worker().request('windows', {});
  assert.equal(f.children.length, 2);
});

test('partial spawn pipes consume late stream errors after the worker rejects', async t => {
  let remaining;
  const f = fixture(t, { beforeSpawn(child, index) {
    if (index === 0) { child.pid = undefined; remaining = [child.stdin, child.stderr]; child.stdout = undefined; }
  } });
  await assert.rejects(f.worker().request('windows', {}), { code: 'DESKTOP_READ_INTERRUPTED' });
  for (const stream of remaining) assert.doesNotThrow(() => stream.emit('error', new Error('late missing-pipe failure')));
  await f.worker().request('windows', {});
  assert.equal(f.children.length, 2);
});

test('coalesced duplicate or unsolicited trailing data is rejected before another action can dispatch', async t => {
  for (const suffix of ['duplicate', 'wrong-id', 'partial']) await t.test(suffix, async t => {
    const f = fixture(t, { autoReply: false }), worker = f.worker();
    const pending = worker.request('windows', {}), child = f.children[0];
    const reply = JSON.stringify({ id: child.requests[0].id, ok: true, result: { windows: [] } }) + '\n';
    const extra = suffix === 'duplicate' ? reply : suffix === 'partial' ? '{"id":' : JSON.stringify({ id: randomUUID(), ok: true, result: {} }) + '\n';
    child.stdout.emit('data', reply + extra);
    assert.deepEqual(await pending, { windows: [] }, 'an already confirmed result is retained');
    const later = assert.rejects(worker.request('window.action', { kind: 'invoke' }), { code: 'DESKTOP_SESSION_ENDED' });
    await nextTurn();
    assert.deepEqual(child.requests.map(request => request.operation), ['windows', 'cancel']);
    child.exit(); await later;
  });
});

test('reply envelopes require boolean ok, a success result, and a valid native failure code', async t => {
  const malformed = [
    { ok: 'false', result: { executed: true } }, { ok: 1, result: {} }, { ok: true },
    { ok: false }, { ok: false, code: {} }, { ok: false, code: 'DESKTOP_BAD REQUEST' },
    { ok: false, code: 'DESKTOP_' + 'A'.repeat(81) }
  ];
  for (let index = 0; index < malformed.length; index++) await t.test(String(index), async t => {
    const f = fixture(t, { autoReply: false }), worker = f.worker();
    const failed = assert.rejects(worker.request('window.action', { kind: 'invoke' }), { code: 'DESKTOP_OUTCOME_UNKNOWN' });
    const child = f.children[0];
    child.stdout.emit('data', JSON.stringify({ id: child.requests[0].id, ...malformed[index] }) + '\n');
    await failed;
    assert.deepEqual(child.requests.map(request => request.operation), ['window.action', 'cancel']);
  });
});

test('wrong IDs and late replies cannot satisfy or replay an in-flight action', async t => {
  const f = fixture(t, { autoReply: false }), worker = f.worker();
  const failed = assert.rejects(worker.request('window.action', { kind: 'invoke' }), { code: 'DESKTOP_OUTCOME_UNKNOWN' });
  const child = f.children[0], oldRequest = child.requests[0];
  child.stdout.emit('data', JSON.stringify({ id: randomUUID(), ok: true, result: { executed: true } }) + '\n');
  await failed;
  child.respond(oldRequest);
  const next = f.worker().request('windows', {});
  child.exit(); await nextTurn();
  child.respond(oldRequest);
  assert.equal(f.children.length, 2);
  f.children[1].respond(f.children[1].requests[0], { windows: [] });
  assert.deepEqual(await next, { windows: [] });
  assert.equal(child.requests.filter(request => request.operation === 'window.action').length, 1);
});

test('stdout end, close, or stream errors reject pending work without waiting for the 12-second timeout', async t => {
  for (const [stream, event] of [['stdout', 'end'], ['stdout', 'close'], ['stdout', 'error'], ['stderr', 'error']]) await t.test(`${stream} ${event}`, { timeout: 1000 }, async t => {
    const f = fixture(t, { autoReply: false }), worker = f.worker();
    const failed = assert.rejects(worker.request('windows', {}), { code: 'DESKTOP_READ_INTERRUPTED' });
    const child = f.children[0];
    child[stream].emit(event, ...(event === 'error' ? [new Error('pipe failed')] : []));
    await failed;
    assert.equal(child.requests.at(-1).operation, 'cancel');
  });
});

test('process exit allows a complete final stdout reply before pipe closure', async t => {
  const f = fixture(t, { autoReply: false }), worker = f.worker();
  const pending = worker.request('window.action', { kind: 'invoke' }), child = f.children[0];
  child.exit();
  const reply = JSON.stringify({ id: child.requests[0].id, ok: true, result: { executed: true } }) + '\n';
  child.stdout.emit('data', reply.slice(0, 10));
  child.stdout.emit('data', reply.slice(10));
  child.stdout.emit('end'); child.emit('close', 0, null);
  assert.deepEqual(await pending, { executed: true });
  await assert.rejects(worker.request('windows', {}), { code: 'DESKTOP_READ_INTERRUPTED' });
  assert.deepEqual(child.requests.map(request => request.operation), ['window.action']);
});

test('exit followed by EOF without a complete reply leaves the action outcome unknown', { timeout: 1000 }, async t => {
  const f = fixture(t, { autoReply: false }), worker = f.worker();
  const failed = assert.rejects(worker.request('window.action', { kind: 'invoke' }), { code: 'DESKTOP_OUTCOME_UNKNOWN' });
  const child = f.children[0]; child.exit(); child.stdout.emit('data', '{"id":'); child.stdout.emit('end');
  await failed;
});

test('UTF-8 and JSON can be split at every byte without corrupting the reply', async t => {
  const f = fixture(t, { autoReply: false }), worker = f.worker();
  const pending = worker.request('windows', {}), child = f.children[0];
  const value = String.fromCodePoint(20013, 25991, 128578);
  const bytes = Buffer.from(JSON.stringify({ id: child.requests[0].id, ok: true, result: { value } }) + '\r\n');
  for (let index = 0; index < bytes.length; index++) child.stdout.write(bytes.subarray(index, index + 1));
  assert.deepEqual(await pending, { value });
});

test('a synchronous stdin failure clears pending work and retires the helper', async t => {
  const f = fixture(t, { beforeSpawn(child) { child.stdin.write = () => { throw new Error('write failed'); }; } });
  const worker = f.worker();
  await assert.rejects(worker.request('window.action', { kind: 'invoke' }), { code: 'DESKTOP_OUTCOME_UNKNOWN' });
  const child = f.children[0]; child.exit();
  await assert.rejects(worker.request('windows', {}), { code: 'DESKTOP_READ_INTERRUPTED' });
  assert.deepEqual(child.requests.map(request => request.operation), ['cancel']);
});
