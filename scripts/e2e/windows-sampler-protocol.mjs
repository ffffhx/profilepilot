import { spawn } from 'node:child_process';
import path from 'node:path';
import { TextDecoder } from 'node:util';

export const SAMPLER_LIMITS = Object.freeze({ requestBytes: 256 * 1024, responseBytes: 32 * 1024 * 1024, stderrBytes: 64 * 1024, processRows: 16384, lockRows: 16384, paths: 256 });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const reasons = new Set(['not_pinned', 'open_failed', 'birth_failed', 'exited', 'wait_failed']);
const stages = new Set(['protocol', 'process_enumeration', 'process_pin', 'process_cim', 'process_identity', 'process_close', 'rm_start', 'rm_register', 'rm_list', 'rm_end', 'serialize']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = code => Object.assign(new Error(code), { code, outcome: 'unavailable' });
function requireValue(value, code = 'SAMPLER_INVALID_RESPONSE') { if (!value) throw invalid(code); }
function keys(value, allowed, code) { requireValue(record(value) && Object.keys(value).every(key => allowed.includes(key)), code); }
const integer = (value, positive = false) => Number.isSafeInteger(value) && value >= (positive ? 1 : 0) && value <= 0xffffffff;
const boundedText = (value, limit) => typeof value === 'string' && value.length <= limit && !value.includes('\0') && value.isWellFormed();
export function isCreationFileTime(value) { return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n; }

export function validateSamplerRequest(request) {
  const code = 'SAMPLER_INVALID_REQUEST';
  keys(request, ['version', 'requestId', 'operation', 'params'], code);
  requireValue(request.version === 1 && uuid.test(request.requestId) && request.requestId !== '00000000-0000-0000-0000-000000000000' && ['snapshot', 'fileLocks'].includes(request.operation), code);
  keys(request.params, request.operation === 'snapshot' ? [] : ['paths'], code);
  if (request.operation === 'fileLocks') {
    const paths = request.params.paths;
    requireValue(Array.isArray(paths) && paths.length <= SAMPLER_LIMITS.paths && paths.every(value => boundedText(value, 32768)
      && !/[\x00-\x1f\x7f-\x9f]/.test(value) && path.win32.isAbsolute(value) && (/^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\.+/.test(value))), code);
    requireValue(new Set(paths.map(value => value.toLowerCase())).size === paths.length, code);
  }
  const bytes = Buffer.from(JSON.stringify(request) + '\n', 'utf8');
  requireValue(bytes.length <= SAMPLER_LIMITS.requestBytes, 'SAMPLER_REQUEST_TOO_LARGE');
  return bytes;
}

function validateTimings(value) {
  keys(value, ['totalMs', 'enumerateMs', 'pinMs', 'cimMs']);
  requireValue(typeof value.totalMs === 'number');
  for (const duration of Object.values(value)) requireValue(Number.isFinite(duration) && duration >= 0 && duration <= 60000);
}

// JSON.parse keeps only the last occurrence of a duplicate key. Walk the
// bounded grammar first, comparing decoded keys (including \u escapes), so
// contradictory identity/completeness fields never become valid evidence.
function validateJsonStructure(text) {
  let index = 0;
  const space = () => { while (index < text.length && /[ \t]/.test(text[index])) index++; };
  const need = token => { space(); requireValue(text[index++] === token, 'SAMPLER_INVALID_JSON'); };
  const string = () => {
    space(); const start = index; need('"');
    while (index < text.length) {
      const next = text[index++];
      if (next === '\\') { index++; continue; }
      if (next === '"') {
        try { return JSON.parse(text.slice(start, index)); } catch { throw invalid('SAMPLER_INVALID_JSON'); }
      }
    }
    throw invalid('SAMPLER_INVALID_JSON');
  };
  const value = depth => {
    requireValue(depth <= 16, 'SAMPLER_JSON_DEPTH'); space();
    if (text[index] === '{') {
      index++; space(); const names = new Set();
      if (text[index] === '}') { index++; return; }
      for (;;) {
        const name = string(); requireValue(!names.has(name), 'SAMPLER_AMBIGUOUS_JSON'); names.add(name);
        need(':'); value(depth + 1); space();
        if (text[index] === '}') { index++; return; }
        need(',');
      }
    } else if (text[index] === '[') {
      index++; space(); if (text[index] === ']') { index++; return; }
      for (;;) { value(depth + 1); space(); if (text[index] === ']') { index++; return; } need(','); }
    } else if (text[index] === '"') string();
    else {
      const start = index;
      while (index < text.length && !/[,\]} \t]/.test(text[index])) index++;
      requireValue(/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/.test(text.slice(start, index)), 'SAMPLER_INVALID_JSON');
    }
  };
  value(0); space(); requireValue(index === text.length, 'SAMPLER_INVALID_JSON');
}

export function validateSamplerReply(bytes, request, exitCode) {
  validateSamplerRequest(request);
  requireValue(Buffer.isBuffer(bytes) && bytes.length <= SAMPLER_LIMITS.responseBytes, 'SAMPLER_RESPONSE_TOO_LARGE');
  let text, reply;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalid('SAMPLER_INVALID_UTF8'); }
  requireValue(/\r?\n$/.test(text), 'SAMPLER_INCOMPLETE_RESPONSE');
  const line = text.replace(/\r?\n$/, '');
  requireValue(!/[\r\n]/.test(line), 'SAMPLER_MULTIPLE_RESPONSES');
  validateJsonStructure(line);
  try { reply = JSON.parse(line); } catch { throw invalid('SAMPLER_INVALID_JSON'); }
  keys(reply, ['version', 'requestId', 'operation', 'ok', 'result', 'error']);
  requireValue(reply.version === 1 && reply.requestId === request.requestId && reply.operation === request.operation && typeof reply.ok === 'boolean', 'SAMPLER_RESPONSE_MISMATCH');
  if (!reply.ok) {
    requireValue(exitCode === 2 && !Object.hasOwn(reply, 'result'), 'SAMPLER_EXIT_MISMATCH');
    keys(reply.error, ['code', 'stage', 'pid', 'win32Error', 'cleanupFailed', 'cleanupWin32Error']);
    requireValue(/^WINDOWS_SAMPLER_[A-Z0-9_]{1,64}$/.test(reply.error.code) && stages.has(reply.error.stage));
    requireValue(reply.error.pid === undefined || integer(reply.error.pid, true));
    requireValue(reply.error.win32Error === undefined || integer(reply.error.win32Error));
    requireValue(reply.error.cleanupFailed === undefined || reply.error.cleanupFailed === true);
    requireValue(reply.error.cleanupWin32Error === undefined || reply.error.cleanupFailed === true && integer(reply.error.cleanupWin32Error));
    throw Object.assign(invalid(reply.error.code), { details: { ...reply.error } });
  }
  requireValue(exitCode === 0 && !Object.hasOwn(reply, 'error'), 'SAMPLER_EXIT_MISMATCH');
  const result = reply.result;
  keys(result, request.operation === 'snapshot' ? ['processes', 'complete', 'timings'] : ['rows', 'complete', 'timings']);
  requireValue(result.complete === true, 'SAMPLER_INCOMPLETE_EVIDENCE'); validateTimings(result.timings);
  const seen = new Map();
  if (request.operation === 'snapshot') {
    requireValue(Array.isArray(result.processes) && result.processes.length > 0 && result.processes.length <= SAMPLER_LIMITS.processRows);
    for (const row of result.processes) {
      keys(row, ['pid', 'parentPid', 'name', 'executablePath', 'commandLine', 'commandLineAvailable', 'startedAt', 'creationFileTime', 'identityStatus', 'identityReason', 'identityWin32Error']);
      requireValue(integer(row.pid, true) && integer(row.parentPid) && !seen.has(row.pid)); seen.set(row.pid, true);
      requireValue(boundedText(row.name, 512) && row.name.length > 0 && (row.executablePath === null || boundedText(row.executablePath, 32768)));
      requireValue(boundedText(row.commandLine, 32768) && typeof row.commandLineAvailable === 'boolean' && (!row.commandLineAvailable || row.commandLine.length > 0));
      requireValue(row.startedAt === null || boundedText(row.startedAt, 64) && Number.isFinite(Date.parse(row.startedAt)));
      if (row.identityStatus === 'confirmed') requireValue(isCreationFileTime(row.creationFileTime) && row.identityReason === undefined && row.identityWin32Error === undefined);
      else requireValue(row.identityStatus === 'unavailable' && row.creationFileTime === null && reasons.has(row.identityReason)
        && (row.identityWin32Error === undefined || integer(row.identityWin32Error)));
    }
  } else {
    requireValue(Array.isArray(result.rows) && result.rows.length <= SAMPLER_LIMITS.lockRows);
    const paths = new Set(request.params.paths), rows = new Set();
    for (const row of result.rows) {
      keys(row, ['path', 'pid', 'creationFileTime']);
      requireValue(paths.has(row.path) && integer(row.pid, true) && isCreationFileTime(row.creationFileTime));
      requireValue(!seen.has(row.pid) || seen.get(row.pid) === row.creationFileTime, 'SAMPLER_IDENTITY_CONFLICT'); seen.set(row.pid, row.creationFileTime);
      const key = JSON.stringify([row.path, row.pid]); requireValue(!rows.has(key)); rows.add(key);
    }
  }
  return result;
}

// One child, one read-only request, no retry. A deadline/exit/parse failure
// cannot produce partial evidence. Only this directly spawned child is killed.
export async function runWindowsSampler({ executable, request, timeoutMs = 12000, killGraceMs = 1500, spawnImpl = spawn }) {
  const input = validateSamplerRequest(request);
  requireValue(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, 'SAMPLER_INVALID_DEADLINE');
  requireValue(Number.isFinite(killGraceMs) && killGraceMs > 0 && killGraceMs <= 5000, 'SAMPLER_INVALID_DEADLINE');
  const began = performance.now();
  return new Promise((resolve, reject) => {
    let child, timer, grace, settled = false, failure, stdoutBytes = 0, stderrBytes = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(grace);
      if (error) reject(error); else resolve(value);
    };
    const stop = error => {
      if (settled || failure) return; failure = error;
      grace = setTimeout(() => finish(Object.assign(invalid('SAMPLER_EXIT_UNCONFIRMED'), { causeCode: error.code })), killGraceMs);
      try { child?.kill(); } catch { /* Confirmation is still required below. */ }
    };
    try { child = spawnImpl(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { finish(invalid('SAMPLER_SPAWN_FAILED')); return; }
    child.once('error', () => child.pid === undefined ? finish(invalid('SAMPLER_SPAWN_FAILED')) : stop(invalid('SAMPLER_PROCESS_ERROR')));
    child.once('close', code => {
      if (failure) { finish(failure); return; }
      try {
        requireValue(stderrBytes === 0, 'SAMPLER_UNEXPECTED_STDERR');
        const result = validateSamplerReply(Buffer.concat(chunks), request, code);
        finish(null, { result, requestId: request.requestId, elapsedMs: performance.now() - began, stdoutBytes, stderrBytes });
      } catch (error) { finish(error); }
    });
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', () => stop(invalid('SAMPLER_PIPE_ERROR')));
    if (!child.stdin || !child.stdout || !child.stderr) { stop(invalid('SAMPLER_PIPE_UNAVAILABLE')); return; }
    child.stdout.on('data', chunk => {
      if (settled || failure) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); stdoutBytes += value.length;
      if (stdoutBytes > SAMPLER_LIMITS.responseBytes) stop(invalid('SAMPLER_RESPONSE_TOO_LARGE')); else chunks.push(value);
    });
    child.stderr.on('data', chunk => { stderrBytes += Buffer.byteLength(chunk); if (stderrBytes > SAMPLER_LIMITS.stderrBytes) stop(invalid('SAMPLER_STDERR_TOO_LARGE')); });
    timer = setTimeout(() => stop(invalid('SAMPLER_TIMEOUT')), timeoutMs);
    try { child.stdin.end(input); } catch { stop(invalid('SAMPLER_PIPE_ERROR')); }
  });
}
