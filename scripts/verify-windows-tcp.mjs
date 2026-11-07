import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { launchWindowsUserProcess } from './e2e/windows-user-process.mjs';
import { assertDesktopAcceptanceWindow } from './e2e/desktop-acceptance-window.mjs';
import { loadLegacySampler, retireSamplerProcess } from './verify-windows-sampler.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = fileURLToPath(import.meta.url), protocol = 'profilepilot.windows-tcp-prototype';
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = async file => sha(await readFile(file));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = code => Object.assign(new Error(code), { code });
const check = (value, code) => { if (!value) throw fail(code); };
// Error messages/stdout may contain unrelated endpoints. Only fixed codes and
// numeric native diagnostics are persisted.
const errorRecord = error => ({ code: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,90}$/.test(error.code) ? error.code : 'TCP_ACCEPTANCE_FAILED',
  ...(['tcp4', 'tcp6', 'tcp_total', 'complete', 'abi', 'protocol', 'identity', 'serialize', 'unknown'].includes(error?.stage) ? { stage: error.stage } : {}),
  ...(Number.isInteger(error?.nativeReturn) ? { nativeReturn: error.nativeReturn } : {}),
  ...(Number.isInteger(error?.state) ? { state: error.state } : {}) });
export function tcpOptions(args) {
  let mode;
  for (const arg of args) { check(['--check', '--run'].includes(arg) && mode === undefined, 'TCP_INVALID_OPTIONS'); mode = arg; }
  return { run: mode === '--run', rounds: 5 };
}
export const tcpOrder = round => round % 2 ? ['native', 'netstat'] : ['netstat', 'native'];
export function tcpSummary(rounds) {
  check(rounds.length === 5 && rounds.every((round, index) => round.index === index + 1 && JSON.stringify(round.order) === JSON.stringify(tcpOrder(index))
    && round.samples.length === 2 && round.samples.every((sample, at) => sample.variant === round.order[at] && sample.ok === true && Number.isFinite(sample.wallMs) && sample.wallMs >= 0)), 'TCP_ROUNDS_INCOMPLETE');
  return ['netstat', 'native'].map(variant => {
    const samples = rounds.flatMap(round => round.samples.filter(sample => sample.variant === variant));
    const values = samples.map(sample => sample.wallMs).sort((a, b) => a - b);
    return { variant, samples: values.length, firstWallMs: samples[0].wallMs, minWallMs: values[0], medianWallMs: values[2], maxWallMs: values[4],
      samplingChildren: samples.reduce((count, sample) => count + sample.samplingChildren, 0) };
  });
}
export function verifyTcpIdentity(value, expected, original) {
  check(value?.ok === true && Number.isSafeInteger(value.pid) && value.pid > 0 && Number.isSafeInteger(value.parentPid) && value.parentPid > 0, 'TCP_IDENTITY_INVALID');
  check(/^[1-9]\d{15,18}$/.test(value.startedUtcTicks) && path.win32.isAbsolute(value.executable), 'TCP_IDENTITY_INVALID');
  check(path.win32.resolve(value.executable).toLowerCase() === path.win32.resolve(expected.executable).toLowerCase()
    && /^[a-f0-9]{64}$/.test(expected.sha256) && value.sha256 === expected.sha256, 'TCP_IDENTITY_IMAGE_MISMATCH');
  check(value.integrityRid === 8192 && value.elevated === false && value.uiAccess === false, 'TCP_MEDIUM_REQUIRED');
  if (expected.pid !== undefined) check(value.pid === expected.pid, 'TCP_IDENTITY_PID_MISMATCH');
  if (original) for (const key of ['pid', 'parentPid', 'startedUtcTicks', 'executable', 'sha256']) check(value[key] === original[key], 'TCP_IDENTITY_CHANGED');
  return value;
}
export function tcpRunnerLifecycle(expected, io) {
  let attempted = false, launched, pinned;
  const pin = (value, receipt) => {
    verifyTcpIdentity(value, { ...expected, ...(launched ? { pid: launched.pid } : {}) });
    if (receipt) { check(receipt.nonce === expected.nonce && receipt.identity?.pid === value.pid && receipt.identity.startedUtcTicks === value.startedUtcTicks, 'TCP_READY_IDENTITY_MISMATCH'); }
    pinned = { ...value }; return pinned;
  };
  return {
    get attempted() { return attempted; }, get identity() { return pinned; }, pin,
    async launch() { check(!attempted, 'TCP_DUPLICATE_LAUNCH'); attempted = true; launched = await io.launch(); return launched; },
    async cleanup() {
      const result = { attempted, ok: !attempted, errors: [], nonceCloseRequested: false };
      if (!attempted) return result;
      if (!pinned) try {
        const ready = await io.ready(); check(ready?.nonce === expected.nonce && Number.isSafeInteger(ready.identity?.pid) && ready.identity.pid > 0, 'TCP_READY_INVALID');
        pin(await io.inspect(ready.identity.pid), ready); result.identityRecovered = true;
      } catch (error) { result.errors.push({ stage: 'identity', ...errorRecord(error) }); }
      try { await io.requestClose(); result.nonceCloseRequested = true; }
      catch (error) { result.errors.push({ stage: 'nonce-close', ...errorRecord(error) }); }
      if (pinned) {
        result.identity = pinned;
        try { result.retirement = await io.retire(pinned); } catch (error) { result.errors.push({ stage: 'retire', ...errorRecord(error) }); }
      }
      // No full identity means no PID kill. A force fallback always remains a
      // failed acceptance, even if it eventually proves the original exited.
      result.ok = result.nonceCloseRequested && !result.errors.length && result.retirement?.ok === true && !result.retirement.forced;
      return result;
    }
  };
}
async function poll(read, accept, milliseconds, code) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try { const value = await read(); if (accept(value)) return value; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await sleep(40);
  }
  throw fail(code);
}
const nativeAddress = row => row.localAddressHex === (row.family === 2 ? '7f000001' : '00000000000000000000000000000001');
export function verifyOwnedTcp(rows, owner, native) {
  check(Array.isArray(rows), 'TCP_ROWS_INVALID');
  check(Number.isSafeInteger(owner?.pid) && owner.pid > 0 && owner.pid <= 0xffffffff && Array.isArray(owner.endpoints) && owner.endpoints.length === 2
    && owner.endpoints.map(endpoint => endpoint?.family).sort((a, b) => a - b).join(',') === '2,23', 'TCP_OWN_ENDPOINTS_INVALID');
  for (const endpoint of owner.endpoints) check(endpoint.address === (endpoint.family === 2 ? '127.0.0.1' : '::1')
    && [endpoint.port, endpoint.clientPort].every(port => Number.isSafeInteger(port) && port > 0 && port <= 65535)
    && endpoint.port !== endpoint.clientPort, 'TCP_OWN_ENDPOINTS_INVALID');
  const evidence = [];
  for (const endpoint of owner.endpoints) {
    const relevant = rows.filter(row => row.pid === owner.pid);
    const listening = relevant.filter(row => (native ? row.state === 2 && row.family === endpoint.family && nativeAddress(row) :
      row.state === 'Listen' && row.localAddress === endpoint.address) && row.localPort === endpoint.port);
    check(listening.length === 1, 'TCP_OWN_LISTENER_MISMATCH');
    const established = relevant.filter(row => (native ? row.state === 5 && row.family === endpoint.family && nativeAddress(row) :
      row.state === 'Established' && row.localAddress === endpoint.address) && row.localPort === endpoint.clientPort && row.remotePort === endpoint.port);
    check(established.length === 1, 'TCP_OWN_ESTABLISHED_MISMATCH');
    if (native) {
      check(listening[0].localScopeRaw === 0 && established[0].localScopeRaw === 0 && established[0].remoteScopeRaw === 0, 'TCP_LOOPBACK_SCOPE_MISMATCH');
      check(listening[0].remoteMeaningful === false && listening[0].remotePort === 0 && /^0+$/.test(listening[0].remoteAddressHex), 'TCP_LISTENER_REMOTE_INVALID');
      check(established[0].remoteAddressHex === established[0].localAddressHex, 'TCP_OWN_REMOTE_MISMATCH');
    } else check(established[0].remoteAddress === endpoint.address, 'TCP_OWN_REMOTE_MISMATCH');
    evidence.push({ family: endpoint.family, port: endpoint.port, clientPort: endpoint.clientPort, listenerMatches: 1, establishedMatches: 1 });
  }
  return evidence;
}
export function validateTcpReply(bytes, requestId, exitCode) {
  check(Buffer.isBuffer(bytes) && bytes.length <= 32 * 1024 * 1024, 'TCP_RESPONSE_TOO_LARGE');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  check(text.endsWith('\n') && !/[\r\n]/.test(text.slice(0, -1)), 'TCP_RESPONSE_FRAMING');
  let reply; try { reply = JSON.parse(text); } catch { throw fail('TCP_RESPONSE_JSON'); }
  check(reply?.protocol === protocol && reply.version === 1 && reply.operation === 'tcp' && reply.requestId === requestId && typeof reply.ok === 'boolean', 'TCP_RESPONSE_MISMATCH');
  if (!reply.ok) {
    check(exitCode === 2 && typeof reply.error?.code === 'string' && /^TCP_PROTOTYPE_[A-Z0-9_]+$/.test(reply.error.code), 'TCP_RESPONSE_ERROR_INVALID');
    throw Object.assign(fail(reply.error.code), { stage: reply.error.stage, ...(Number.isInteger(reply.error.nativeReturn) ? { nativeReturn: reply.error.nativeReturn } : {}),
      ...(Number.isInteger(reply.error.state) ? { state: reply.error.state } : {}) });
  }
  const result = reply.result;
  check(exitCode === 0 && result?.complete === true && result.processBirthJoined === false && result.scopeEncoding === 'raw-DWORD-uninterpreted'
    && Array.isArray(result.families) && result.families.length === 2, 'TCP_RESPONSE_INCOMPLETE');
  const fields = ['family', 'state', 'pid', 'localPort', 'remotePort', 'localAddressHex', 'remoteAddressHex', 'localScopeRaw', 'remoteScopeRaw', 'remoteMeaningful'];
  let total = 0;
  for (const [index, family] of result.families.entries()) {
    check(family.family === [2, 23][index] && Array.isArray(family.rows) && Number.isSafeInteger(family.rowCount) && family.rowCount >= family.rows.length
      && family.rowCount <= 65536 && Number.isSafeInteger(family.apiCalls) && family.apiCalls >= 2 && family.apiCalls <= 5, 'TCP_FAMILY_INVALID');
    total += family.rowCount;
    for (const row of family.rows) {
      check(Object.keys(row).length === fields.length && fields.every(key => Object.hasOwn(row, key)) && row.family === family.family && [2, 5].includes(row.state)
        && Number.isSafeInteger(row.pid) && row.pid >= 0 && row.pid <= 0xffffffff, 'TCP_ROW_INVALID');
      for (const name of ['localPort', 'remotePort']) check(Number.isSafeInteger(row[name]) && row[name] >= 0 && row[name] <= 65535, 'TCP_PORT_INVALID');
      for (const name of ['localScopeRaw', 'remoteScopeRaw']) check(Number.isSafeInteger(row[name]) && row[name] >= 0 && row[name] <= 0xffffffff, 'TCP_SCOPE_INVALID');
      for (const name of ['localAddressHex', 'remoteAddressHex']) check(typeof row[name] === 'string' && new RegExp('^[a-f0-9]{' + (row.family === 2 ? 8 : 32) + '}$').test(row[name]), 'TCP_ADDRESS_INVALID');
      check(row.remoteMeaningful === (row.state !== 2), 'TCP_REMOTE_INVALID');
    }
  }
  check(total <= 65536, 'TCP_RESPONSE_TOO_LARGE'); return reply;
}
async function candidate(executable, expectedHash, signal) {
  check(await digest(executable) === expectedHash, 'TCP_PROBE_IMAGE_CHANGED');
  check(!signal.aborted, 'TCP_RUN_CANCELLED');
  const requestId = randomUUID(), began = performance.now();
  const request = JSON.stringify({ protocol, version: 1, requestId, operation: 'tcp', params: {} }) + '\n';
  const result = { samplingChildren: 1, descendantSamplingChildren: 0, launchParentPid: process.pid, parentEvidence: 'direct-spawn-child-reference', closeConfirmed: false, forced: false };
  let child, failure, timer, killTimer, bytes = 0; const chunks = [];
  await new Promise((resolve, reject) => {
    const interrupt = code => {
      failure ||= fail(code);
      if (!child || result.forced) return;
      result.forced = true; try { result.killAccepted = child.kill(); } catch { result.killAccepted = false; }
      killTimer = setTimeout(() => reject(fail('TCP_PROBE_EXIT_UNCONFIRMED')), 1500);
    };
    const aborted = () => interrupt('TCP_RUN_CANCELLED');
    try { child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(error); return; }
    result.pid = child.pid;
    child.on('error', () => interrupt('TCP_PROBE_SPAWN_FAILED'));
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener('abort', aborted);
      result.exitCode = code; result.closeConfirmed = true; failure ? reject(failure) : resolve();
    });
    if (!child.stdin || !child.stdout || !child.stderr) { interrupt('TCP_PROBE_PIPES_UNAVAILABLE'); return; }
    child.stdin.on('error', () => interrupt('TCP_PROBE_STDIN_FAILED'));
    child.stdout.on('error', () => interrupt('TCP_PROBE_STDOUT_FAILED'));
    child.stderr.on('error', () => interrupt('TCP_PROBE_STDERR_FAILED'));
    child.stdout.on('data', value => { bytes += value.length; if (bytes > 32 * 1024 * 1024) interrupt('TCP_RESPONSE_TOO_LARGE'); else chunks.push(value); });
    child.stderr.on('data', value => { if (value.length) interrupt('TCP_PROBE_STDERR_NONEMPTY'); });
    timer = setTimeout(() => interrupt('TCP_PROBE_TIMEOUT'), 10000);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    child.stdin.end(request);
  }).catch(error => { error.probe = result; throw error; });
  result.wallMs = performance.now() - began;
  try {
    const reply = validateTcpReply(Buffer.concat(chunks), requestId, result.exitCode), identity = reply.identity;
    check(identity?.pid === child.pid && identity.sha256 === expectedHash && path.resolve(identity.executable).toLowerCase() === path.resolve(executable).toLowerCase()
      && /^[1-9]\d{15,18}$/.test(identity.startedUtcTicks) && identity.integrityRid === 8192 && identity.elevated === false && identity.uiAccess === false, 'TCP_PROBE_IDENTITY_MISMATCH');
    return { result: reply.result, evidence: { ...result, identity, stdoutBytes: bytes } };
  } catch (error) { error.probe = result; throw error; }
}
async function ownedEndpoints(signal) {
  const servers = [], sockets = [], endpoints = [];
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    const errors = [];
    for (const server of servers) try { if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    catch { errors.push('TCP_LISTENER_CLOSE_FAILED'); }
    return { ok: !errors.length && servers.every(server => !server.listening) && sockets.every(socket => socket.destroyed), errors, servers: servers.length, sockets: sockets.length };
  };
  try {
    for (const [family, address] of [[2, '127.0.0.1'], [23, '::1']]) {
      check(!signal.aborted, 'TCP_RUN_CANCELLED');
      const server = net.createServer(socket => { sockets.push(socket); socket.on('error', () => {}); }); servers.push(server);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: address, port: 0, ...(family === 23 ? { ipv6Only: true } : {}) }, resolve); });
      const port = server.address().port;
      const client = new net.Socket(); sockets.push(client); client.on('error', () => {});
      await new Promise((resolve, reject) => { client.once('error', reject); client.connect({ host: address, port, family: family === 2 ? 4 : 6 }, resolve); });
      endpoints.push({ family, address, port, clientPort: client.localPort, ipv6Only: family === 23 });
    }
    return { endpoints, close };
  } catch (error) { error.socketCleanup = await close(); throw error; }
}
async function medium(configFile) {
  await assertDesktopAcceptanceWindow();
  const config = await json(configFile);
  check(config.root === root && /^[a-f0-9]{32}$/.test(config.nonce) && config.rounds === 5, 'TCP_CONFIG_INVALID');
  const inspect = args => JSON.parse(execFileSync(config.identityExe, args, { windowsHide: true, encoding: 'utf8', timeout: 10000 }));
  const report = { ok: false, finished: false, protocol, mode: 'isolated-tcp-medium', nonce: config.nonce, rounds: [], cleanup: {},
    scope: 'TCP only. No full-system process snapshot or Restart Manager sampling; exact own-process identity queries are performed. No pinned process birth join, App admission or GUI/input.',
    limitations: ['Sequential family/API/netstat observations are not atomic or causal performance attribution.',
      'No production end-to-end speed claim. Native sample wall time includes artifact hashing, a fresh helper and self-identity checks; netstat uses two concurrent fresh children.',
      'Nonzero link-local scope and bind-only sockets are not covered. Zero loopback scope cannot validate scope byte order.',
      'Raw table payloads remain in memory; reports retain only own endpoint matches and aggregate counts.', 'Windows Medium only; macOS unchanged.'] };
  const save = () => writeFile(config.result, JSON.stringify(report, null, 2));
  const control = new AbortController(); let timer, opened, closeReason;
  const began = Date.now();
  const controlTick = async () => {
    try { if (await readFile(config.close, 'utf8') === config.nonce) { closeReason = 'requested'; control.abort(); return; } } catch (error) { if (error.code !== 'ENOENT') { closeReason = 'control_error'; control.abort(); } }
    try { const beat = await stat(config.heartbeat); if (await readFile(config.heartbeat, 'utf8') !== config.nonce || Date.now() - beat.mtimeMs > 30000) { closeReason = 'heartbeat_expired'; control.abort(); } }
    catch { closeReason = 'heartbeat_missing'; control.abort(); }
    if (Date.now() - began > 180000) { closeReason = 'lifetime_expired'; control.abort(); }
  };
  try {
    for (const [file, hash] of Object.entries(config.artifacts)) check(await digest(file) === hash, 'TCP_ARTIFACT_CHANGED');
    report.identity = verifyTcpIdentity(inspect(['--inspect', String(process.pid)]), { pid: process.pid, executable: process.execPath, sha256: config.nodeSha256 });
    await writeFile(config.ready, JSON.stringify({ nonce: config.nonce, identity: report.identity }));
    timer = setInterval(() => { void controlTick(); }, 100);
    await poll(async () => { await controlTick(); check(!control.signal.aborted, 'TCP_RUN_CANCELLED'); return readFile(config.go, 'utf8'); }, value => value === config.nonce, 30000, 'TCP_START_ACK_MISSING');
    opened = await ownedEndpoints(control.signal); report.endpoints = opened.endpoints;
    const owner = { pid: process.pid, endpoints: opened.endpoints }, segments = [], execute = promisify(execFile);
    const legacy = loadLegacySampler(await readFile(config.baseline, 'utf8'), segments, { execute: (file, args, options) => {
      check(path.basename(file).toLowerCase() === 'netstat' && args.join(' ') === '-ano -p ' + args.at(-1) && ['tcp', 'tcpv6'].includes(args.at(-1)), 'TCP_LEGACY_OPERATION_FORBIDDEN');
      return execute(file, args, { ...options, signal: control.signal });
    } });
    for (let index = 0; index < 5; index++) {
      const round = { index: index + 1, order: tcpOrder(index), samples: [] }; report.rounds.push(round);
      for (const variant of round.order) {
        await controlTick(); check(!control.signal.aborted, 'TCP_RUN_CANCELLED');
        const sample = { variant, firstIteration: index === 0 }; round.samples.push(sample); segments.length = 0; const start = performance.now();
        try {
          if (variant === 'native') {
            const value = await candidate(config.probeExe, config.artifacts[config.probeExe], control.signal);
            sample.lifecycle = value.evidence;
            sample.owned = verifyOwnedTcp(value.result.families.flatMap(family => family.rows), owner, true);
            sample.families = value.result.families.map(({ rows, ...metadata }) => ({ ...metadata, projectedRows: rows.length }));
            sample.nativeReadMs = value.result.elapsedMs; sample.samplingChildren = 1;
          } else {
            const value = await legacy.__samplerBenchmarkTcp();
            check(value?.complete === true, 'TCP_LEGACY_INCOMPLETE'); sample.owned = verifyOwnedTcp(value.connections, owner, false);
            sample.projectedRows = value.connections.length; sample.samplingChildren = 2;
          }
          sample.ok = true;
        } catch (error) { sample.ok = false; sample.error = errorRecord(error); if (error.probe) sample.lifecycle = error.probe; throw error; }
        finally { await legacy.__samplerBenchmarkSettle(); sample.wallMs = performance.now() - start; sample.segments = segments.splice(0); await save(); }
        if (variant === 'netstat') check(sample.segments.length === 2 && sample.segments.every(segment => segment.ok === true)
          && sample.segments.map(segment => segment.operation).sort().join(',') === 'netstat.tcp,netstat.tcpv6', 'TCP_LEGACY_CHILD_COUNT_MISMATCH');
      }
    }
    for (const [file, hash] of Object.entries(config.artifacts)) check(await digest(file) === hash, 'TCP_ARTIFACT_CHANGED');
    report.summary = tcpSummary(report.rounds); report.ok = true;
  } catch (error) { report.error = errorRecord(error); if (error.socketCleanup) report.cleanup.sockets = error.socketCleanup; }
  finally {
    report.finished = true; await save();
    // Keep own listeners stable until the parent acknowledges the result and
    // requests normal nonce shutdown. A launcher handshake failure is also
    // cleaned by this same path before any go/listen operation.
    while (!control.signal.aborted) { await controlTick(); if (!control.signal.aborted) await sleep(40); }
    clearInterval(timer);
    if (opened) report.cleanup.sockets = await opened.close();
    report.cleanup.nativeChildren = report.rounds.flatMap(round => round.samples).filter(sample => sample.lifecycle).map(sample => ({ pid: sample.lifecycle.pid,
      closeConfirmed: sample.lifecycle.closeConfirmed, forced: sample.lifecycle.forced, exitCode: sample.lifecycle.exitCode }));
    if (report.cleanup.nativeChildren.some(child => child.closeConfirmed !== true || child.forced)) report.ok = false;
    if (report.cleanup.sockets?.ok === false || closeReason !== 'requested') report.ok = false;
    report.cleanup.closeReason = closeReason; report.cleanup.complete = true; await save();
    await writeFile(config.closed, JSON.stringify({ nonce: config.nonce, pid: process.pid, startedUtcTicks: report.identity?.startedUtcTicks,
      reason: closeReason, exitCode: report.ok ? 0 : 1, socketsClosed: report.cleanup.sockets?.ok !== false }));
  }
  return report;
}
export async function main(args = process.argv.slice(2)) {
  const options = tcpOptions(args); check(process.platform === 'win32', 'TCP_WINDOWS_REQUIRED');
  const home = await mkdtemp(path.join(os.tmpdir(), 'pp-windows-tcp-')), output = path.join(root, '.tools/desktop-verification', path.basename(home)); await mkdir(output, { recursive: true });
  const config = { root, home, nonce: randomBytes(16).toString('hex'), rounds: 5, probeExe: path.join(home, 'TcpPrototype.exe'), identityExe: path.join(home, 'OwnedIdentity.exe'),
    baseline: path.join(root, 'scripts/e2e/windows-sampler-legacy-platform.ts'), ready: path.join(home, 'ready.json'), result: path.join(output, 'medium-report.json'),
    go: path.join(home, 'go'), close: path.join(home, 'close'), closed: path.join(home, 'closed.json'), heartbeat: path.join(home, 'heartbeat.json') };
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const compile = (out, source, references) => execFileSync(compiler, ['/nologo', '/codepage:65001', '/platform:x64', '/target:exe', '/out:' + out,
    ...references.map(name => '/r:' + name), path.join(root, source)], { windowsHide: true, timeout: 30000 });
  compile(config.probeExe, 'scripts/e2e/windows-tcp-prototype.cs', ['System.Web.Extensions.dll']);
  compile(config.identityExe, 'scripts/e2e/desktop-observer-fault-identity.cs', ['System.Web.Extensions.dll', 'System.Management.dll']);
  config.baselineManifest = await json(path.join(root, 'scripts/e2e/windows-sampler-legacy-platform.json'));
  check(config.baselineManifest.sha256 === await digest(config.baseline), 'TCP_BASELINE_HASH_MISMATCH');
  config.artifacts = Object.fromEntries(await Promise.all([config.probeExe, config.identityExe, config.baseline, script,
    ...['scripts/e2e/windows-tcp-prototype.cs', 'scripts/verify-windows-sampler.mjs', 'scripts/e2e/windows-user-process.mjs',
      'scripts/e2e/desktop-acceptance-window.mjs', 'scripts/e2e/desktop-observer-fault-identity.cs'].map(file => path.join(root, file))].map(async file => [file, await digest(file)])));
  config.nodeSha256 = await digest(process.execPath);
  const report = { ok: false, mode: options.run ? 'run' : 'compile-only', output, protocol, artifacts: config.artifacts, baseline: config.baselineManifest,
    productionChanged: false, processBirthJoined: false, guiStarted: false, hooksInstalled: false, cleanup: {} };
  const save = () => writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (!options.run) { report.ok = true; report.osSampled = false; await save(); return report; }
  await assertDesktopAcceptanceWindow();
  const configFile = path.join(home, 'config.json'); await writeFile(configFile, JSON.stringify(config));
  // The content is immutable. Updating mtime avoids transient empty/partial
  // JSON reads being mistaken for loss of the parent's heartbeat.
  await writeFile(config.heartbeat, config.nonce);
  const beat = () => { const now = new Date(); return utimes(config.heartbeat, now, now); }; await beat();
  let heartbeat = setInterval(() => { void beat().catch(() => {}); }, 1000);
  const inspect = args => JSON.parse(execFileSync(config.identityExe, args, { windowsHide: true, timeout: 12000, encoding: 'utf8' }));
  const lifecycle = tcpRunnerLifecycle({ nonce: config.nonce, executable: process.execPath, sha256: config.nodeSha256 }, {
    launch: () => launchWindowsUserProcess(process.execPath, [script, '--medium', configFile], root),
    ready: () => poll(() => json(config.ready), value => value.nonce === config.nonce, 4000, 'TCP_READY_MISSING'),
    inspect: pid => inspect(['--inspect', String(pid)]), requestClose: () => writeFile(config.close, config.nonce),
    retire: identity => retireSamplerProcess({ identity, executable: process.execPath, inspect, close: () => writeFile(config.close, config.nonce),
      closed: () => poll(() => json(config.closed), value => {
        check(value.nonce === config.nonce && value.pid === identity.pid && value.startedUtcTicks === identity.startedUtcTicks && value.socketsClosed === true, 'TCP_CLOSED_INVALID'); return true;
      }, 12000, 'TCP_CLOSED_MISSING') })
  });
  try {
    const launched = await lifecycle.launch();
    const ready = await poll(() => json(config.ready), value => value.nonce === config.nonce, 15000, 'TCP_READY_MISSING');
    report.runner = lifecycle.pin(inspect(['--inspect', String(launched.pid)]), ready);
    await writeFile(config.go, config.nonce);
    report.medium = await poll(() => json(config.result), value => value.finished === true, 150000, 'TCP_RESULT_MISSING');
    check(report.medium.nonce === config.nonce && report.medium.identity.pid === report.runner.pid, 'TCP_RESULT_IDENTITY_MISMATCH');
    check(report.medium.ok === true, 'TCP_BENCHMARK_FAILED'); report.ok = true;
  } catch (error) { report.error = errorRecord(error); }
  finally {
    report.cleanup.runner = await lifecycle.cleanup(); clearInterval(heartbeat); heartbeat = undefined;
    if (!report.cleanup.runner.ok) report.ok = false;
    try { const final = await json(config.result); check(final.nonce === config.nonce, 'TCP_RESULT_IDENTITY_MISMATCH'); report.medium = final;
      if (!final.ok || final.cleanup.complete !== true) report.ok = false; }
    catch (error) { report.finalReportError = errorRecord(error); report.ok = false; }
    await save();
  }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  const run = process.argv[2] === '--medium' && process.argv.length === 4 ? medium(process.argv[3]) : main();
  run.then(report => { if (process.argv[2] !== '--medium') console.log(JSON.stringify({ ok: report.ok, mode: report.mode, report: path.join(report.output, 'report.json') }));
    process.exitCode = report.ok ? 0 : 1; }).catch(error => { console.error(JSON.stringify(errorRecord(error))); process.exitCode = 1; });
}
