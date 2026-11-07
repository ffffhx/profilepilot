import path from 'node:path';
import { TextDecoder } from 'node:util';

export const WINDOWS_SAMPLER_LIMITS = Object.freeze({ requestBytes: 256 * 1024, responseBytes: 32 * 1024 * 1024,
  stderrBytes: 64 * 1024, processRows: 16384, lockRows: 16384, paths: 256 });
export type WindowsSamplerOperation = 'snapshot' | 'fileLocks';
export type WindowsSamplerRequest = { version: 1; requestId: string } & (
  { operation: 'snapshot'; params: Record<string, never> } | { operation: 'fileLocks'; params: { paths: string[] } });
export type WindowsSamplerIdentityReason = 'not_pinned' | 'open_failed' | 'birth_failed' | 'exited' | 'wait_failed';
export type WindowsSamplerProcess = {
  pid: number; parentPid: number; name: string; executablePath: string | null; commandLine: string;
  commandLineAvailable: boolean; startedAt: string | null;
} & ({ identityStatus: 'confirmed'; creationFileTime: string } |
  { identityStatus: 'unavailable'; creationFileTime: null; identityReason: WindowsSamplerIdentityReason; identityWin32Error?: number });
export interface WindowsSamplerSnapshotResult {
  processes: WindowsSamplerProcess[]; complete: true;
  timings: { totalMs: number; enumerateMs: number; pinMs: number; cimMs: number };
}
export interface WindowsSamplerFileLocksResult {
  rows: { path: string; pid: number; creationFileTime: string }[]; complete: true; timings: { totalMs: number };
}
export type WindowsSamplerResult = WindowsSamplerSnapshotResult | WindowsSamplerFileLocksResult;
export type WindowsSamplerError = Error & { code: string; outcome: 'unavailable'; causeCode?: string; details?: Record<string, unknown> };
export function windowsSamplerError(code: string, details?: Record<string, unknown>): WindowsSamplerError {
  return Object.assign(new Error(code), { code, outcome: 'unavailable' as const, ...(details ? { details } : {}) });
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const reasons = new Set(['not_pinned', 'open_failed', 'birth_failed', 'exited', 'wait_failed']);
const stages = new Set(['protocol', 'process_enumeration', 'process_pin', 'process_cim', 'process_identity', 'process_close',
  'rm_start', 'rm_register', 'rm_list', 'rm_end', 'serialize']);
function requireValue(value: unknown, code = 'WINDOWS_SAMPLER_INVALID_RESPONSE'): asserts value { if (!value) throw windowsSamplerError(code); }
function object(value: unknown, allowed: string[], code?: string): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), code);
  requireValue(Object.keys(value).every(key => allowed.includes(key)), code);
  return value as Record<string, unknown>;
}
const integer = (value: unknown, positive = false): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= (positive ? 1 : 0) && value <= 0xffffffff;
function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) { const low = value.charCodeAt(++index); if (!(low >= 0xdc00 && low <= 0xdfff)) return false; }
    else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
const boundedText = (value: unknown, limit: number): value is string => typeof value === 'string'
  && value.length <= limit && !value.includes('\0') && wellFormed(value);
export function isWindowsCreationFileTime(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
}

export function validateWindowsSamplerRequest(input: unknown): Buffer {
  const code = 'WINDOWS_SAMPLER_INVALID_REQUEST', request = object(input, ['version', 'requestId', 'operation', 'params'], code);
  requireValue(request.version === 1 && typeof request.requestId === 'string' && uuid.test(request.requestId)
    && request.requestId !== '00000000-0000-0000-0000-000000000000' && typeof request.operation === 'string'
    && ['snapshot', 'fileLocks'].includes(request.operation), code);
  const params = object(request.params, request.operation === 'snapshot' ? [] : ['paths'], code);
  if (request.operation === 'fileLocks') {
    const paths = params.paths;
    requireValue(Array.isArray(paths) && paths.length <= WINDOWS_SAMPLER_LIMITS.paths && paths.every(value => boundedText(value, 32768)
      && !/[\x00-\x1f\x7f-\x9f]/.test(value) && path.win32.isAbsolute(value) && (/^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\.+/.test(value))), code);
    requireValue(new Set(paths.map(value => value.toLowerCase())).size === paths.length, code);
  }
  const bytes = Buffer.from(JSON.stringify(input) + '\n', 'utf8');
  requireValue(bytes.length <= WINDOWS_SAMPLER_LIMITS.requestBytes, 'WINDOWS_SAMPLER_REQUEST_TOO_LARGE');
  return bytes;
}

function validateTimings(input: unknown, operation: WindowsSamplerOperation): void {
  const fields = operation === 'snapshot' ? ['totalMs', 'enumerateMs', 'pinMs', 'cimMs'] : ['totalMs'];
  const value = object(input, fields);
  for (const field of fields) requireValue(typeof value[field] === 'number' && Number.isFinite(value[field])
    && (value[field] as number) >= 0 && (value[field] as number) <= 60000);
}

// JSON.parse silently keeps the last duplicate property. Compare decoded keys
// before parsing the bounded response, including escaped spellings of a key.
function validateJsonStructure(text: string): void {
  let index = 0;
  const space = () => { while (index < text.length && /[ \t]/.test(text[index])) index++; };
  const need = (token: string) => { space(); requireValue(text[index++] === token, 'WINDOWS_SAMPLER_INVALID_JSON'); };
  const string = (): string => {
    space(); const start = index; need('"');
    while (index < text.length) {
      const next = text[index++];
      if (next === '\\') { index++; continue; }
      if (next === '"') {
        try { return JSON.parse(text.slice(start, index)) as string; } catch { throw windowsSamplerError('WINDOWS_SAMPLER_INVALID_JSON'); }
      }
    }
    throw windowsSamplerError('WINDOWS_SAMPLER_INVALID_JSON');
  };
  const value = (depth: number): void => {
    requireValue(depth <= 16, 'WINDOWS_SAMPLER_JSON_DEPTH'); space();
    if (text[index] === '{') {
      index++; space(); const names = new Set<string>();
      if (text[index] === '}') { index++; return; }
      for (;;) {
        const name = string(); requireValue(!names.has(name), 'WINDOWS_SAMPLER_AMBIGUOUS_JSON'); names.add(name);
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
      requireValue(/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/.test(text.slice(start, index)), 'WINDOWS_SAMPLER_INVALID_JSON');
    }
  };
  value(0); space(); requireValue(index === text.length, 'WINDOWS_SAMPLER_INVALID_JSON');
}

export function validateWindowsSamplerReply(bytes: Buffer, request: WindowsSamplerRequest, exitCode: number | null): WindowsSamplerResult {
  validateWindowsSamplerRequest(request);
  requireValue(Buffer.isBuffer(bytes) && bytes.length <= WINDOWS_SAMPLER_LIMITS.responseBytes, 'WINDOWS_SAMPLER_RESPONSE_TOO_LARGE');
  let text: string, parsed: unknown;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw windowsSamplerError('WINDOWS_SAMPLER_INVALID_UTF8'); }
  requireValue(/\r?\n$/.test(text), 'WINDOWS_SAMPLER_INCOMPLETE_RESPONSE');
  const line = text.replace(/\r?\n$/, '');
  requireValue(!/[\r\n]/.test(line), 'WINDOWS_SAMPLER_MULTIPLE_RESPONSES'); validateJsonStructure(line);
  try { parsed = JSON.parse(line); } catch { throw windowsSamplerError('WINDOWS_SAMPLER_INVALID_JSON'); }
  const reply = object(parsed, ['version', 'requestId', 'operation', 'ok', 'result', 'error']);
  requireValue(reply.version === 1 && reply.requestId === request.requestId && reply.operation === request.operation
    && typeof reply.ok === 'boolean', 'WINDOWS_SAMPLER_RESPONSE_MISMATCH');
  if (!reply.ok) {
    requireValue(exitCode === 2 && !Object.hasOwn(reply, 'result'), 'WINDOWS_SAMPLER_EXIT_MISMATCH');
    const error = object(reply.error, ['code', 'stage', 'pid', 'win32Error', 'cleanupFailed', 'cleanupWin32Error']);
    requireValue(typeof error.code === 'string' && /^WINDOWS_SAMPLER_[A-Z0-9_]{1,64}$/.test(error.code)
      && typeof error.stage === 'string' && stages.has(error.stage));
    requireValue(error.pid === undefined || integer(error.pid, true));
    requireValue(error.win32Error === undefined || integer(error.win32Error));
    requireValue(error.cleanupFailed === undefined || error.cleanupFailed === true);
    requireValue(error.cleanupWin32Error === undefined || error.cleanupFailed === true && integer(error.cleanupWin32Error));
    throw windowsSamplerError(error.code, { ...error });
  }
  requireValue(exitCode === 0 && !Object.hasOwn(reply, 'error'), 'WINDOWS_SAMPLER_EXIT_MISMATCH');
  const result = object(reply.result, request.operation === 'snapshot' ? ['processes', 'complete', 'timings'] : ['rows', 'complete', 'timings']);
  requireValue(result.complete === true, 'WINDOWS_SAMPLER_INCOMPLETE_EVIDENCE'); validateTimings(result.timings, request.operation);
  const seen = new Map<number, string | true>();
  if (request.operation === 'snapshot') {
    requireValue(Array.isArray(result.processes) && result.processes.length > 0 && result.processes.length <= WINDOWS_SAMPLER_LIMITS.processRows);
    for (const item of result.processes) {
      const row = object(item, ['pid', 'parentPid', 'name', 'executablePath', 'commandLine', 'commandLineAvailable', 'startedAt',
        'creationFileTime', 'identityStatus', 'identityReason', 'identityWin32Error']);
      requireValue(integer(row.pid, true) && integer(row.parentPid) && !seen.has(row.pid)); seen.set(row.pid, true);
      requireValue(boundedText(row.name, 512) && row.name.length > 0 && (row.executablePath === null || boundedText(row.executablePath, 32768)));
      requireValue(boundedText(row.commandLine, 32768) && typeof row.commandLineAvailable === 'boolean' && (!row.commandLineAvailable || row.commandLine.length > 0));
      requireValue(row.startedAt === null || boundedText(row.startedAt, 128) && Number.isFinite(Date.parse(row.startedAt)));
      if (row.identityStatus === 'confirmed') requireValue(isWindowsCreationFileTime(row.creationFileTime) && row.identityReason === undefined && row.identityWin32Error === undefined);
      else requireValue(row.identityStatus === 'unavailable' && row.creationFileTime === null && typeof row.identityReason === 'string' && reasons.has(row.identityReason)
        && (row.identityWin32Error === undefined || integer(row.identityWin32Error)));
    }
  } else {
    requireValue(Array.isArray(result.rows) && result.rows.length <= WINDOWS_SAMPLER_LIMITS.lockRows);
    const paths = new Set(request.params.paths), rows = new Set<string>();
    for (const item of result.rows) {
      const row = object(item, ['path', 'pid', 'creationFileTime']);
      requireValue(typeof row.path === 'string' && paths.has(row.path) && integer(row.pid, true) && isWindowsCreationFileTime(row.creationFileTime));
      requireValue(!seen.has(row.pid) || seen.get(row.pid) === row.creationFileTime, 'WINDOWS_SAMPLER_IDENTITY_CONFLICT'); seen.set(row.pid, row.creationFileTime);
      const key = JSON.stringify([row.path, row.pid]); requireValue(!rows.has(key)); rows.add(key);
    }
  }
  return result as unknown as WindowsSamplerResult;
}
