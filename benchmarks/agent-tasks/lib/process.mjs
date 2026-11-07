import { spawn } from 'node:child_process';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';

const knownSecrets = () => Object.entries(process.env).filter(([name, value]) => /(?:TOKEN|PASSWORD|SECRET|API_KEY|ACCESS_KEY)/i.test(name) && value?.length >= 8).map(([, value]) => value);
function scrub(value, secrets) {
  let text = String(value);
  for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
  return text.replace(/(Bearer\s+)[\w.\-]+/gi, '$1[REDACTED]');
}
export const redact = value => scrub(value, knownSecrets());

export function redactValue(value) {
  // Enumerate the Windows process environment once per document, not once
  // per string in a growing multi-cell report.
  const secrets = knownSecrets();
  const walk = item => {
    if (typeof item === 'string') return scrub(item, secrets);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [scrub(key, secrets), walk(child)]));
    return item;
  };
  return walk(value);
}

export async function readJson(file) {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

export async function loadAdapter(file, repoRoot) {
  const config = await readJson(file);
  if (config.protocolVersion !== 1) throw Error('Adapter protocolVersion must be 1');
  for (const key of ['id', 'agent', 'tool', 'model', 'toolVersion', 'track', 'command']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) throw Error(`Adapter requires nonempty ${key}`);
  }
  if (!Array.isArray(config.args) || !config.args.every(arg => typeof arg === 'string')) throw Error('Adapter args must be a string array (no shell command).');
  if (!['isolated-profilepilot-gateway', 'existing-profilepilot-extension', 'external-browser'].includes(config.environment)) throw Error('Unknown adapter environment.');
  // No shell interpolation; paths with spaces and Chinese are individual argv entries.
  const expand = arg => arg.replaceAll('$REPO', repoRoot).replaceAll('$NODE', process.execPath);
  return { ...config, command: expand(config.command), args: config.args.map(expand) };
}

async function stopProcess(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
      const timer = setTimeout(() => { killer.kill(); resolve(); }, 10000);
      const done = () => { clearTimeout(timer); resolve(); };
      killer.once('error', done); killer.once('close', done);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

export function executeAdapter(config, request, { signal } = {}) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', failure, timedOut = false, settled = false, stopping = false, cleanupFailed = false, stopTimer;
    const started = Date.now();
    const child = spawn(config.command, config.args, {
      cwd: request.workspace, env: { ...process.env, PP_EVAL_RUN_ID: request.runId },
      stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
      detached: process.platform !== 'win32'
    });
    const stop = reason => {
      failure ||= reason;
      if (!stopping) {
        stopping = true;
        void stopProcess(child);
        stopTimer = setTimeout(() => {
          cleanupFailed = true; failure += '; process-tree shutdown could not be confirmed';
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
          finish(null);
        }, 12000);
      }
    };
    const abort = () => stop('Run interrupted');
    const timer = setTimeout(() => { timedOut = true; stop('Agent time budget exceeded'); }, request.budget.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const finish = (code, spawnError) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(stopTimer); signal?.removeEventListener('abort', abort);
      let response;
      try {
        if (spawnError) throw spawnError;
        if (failure) throw Error(failure);
        if (code !== 0) throw Error(`Adapter exited ${code}`);
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        if (lines.length !== 1) throw Error('Adapter stdout must contain exactly one JSON response; write logs to stderr.');
        response = redactValue(JSON.parse(lines[0]));
        if (response.protocolVersion !== 1 || !['completed', 'failed', 'blocked'].includes(response.status) || typeof response.answer !== 'string') throw Error('Invalid adapter response contract');
        if (response.answer.length > 1024 * 1024) throw Error('Adapter answer exceeds 1 MiB');
        for (const key of ['agent', 'model', 'tool', 'toolVersion', 'track']) {
          const identity = response.metadata?.[key];
          if (response.status !== 'completed' && identity == null) continue;
          if (typeof identity !== 'string' || !identity.trim()) throw Error(`Adapter response requires metadata.${key}`);
          if (config[key] && !['configured', 'local-build'].includes(config[key]) && identity !== config[key]) throw Error(`Adapter metadata.${key} differs from registered configuration`);
        }
        for (const [key, value] of Object.entries(response.usage || {})) {
          if (!['inputTokens', 'outputTokens', 'costUsd'].includes(key) || (value !== null && (!Number.isFinite(value) || value < 0))) throw Error('Invalid adapter usage');
        }
      } catch (error) { failure ||= error.message; }
      resolve({ response, error: failure ? redact(failure) : undefined, timedOut, cleanupFailed, elapsedMs: Date.now() - started, stderr: redact(stderr) });
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { if (Buffer.byteLength(stdout) + Buffer.byteLength(data) > 2 * 1024 * 1024) { stop('Adapter stdout limit exceeded'); return; } stdout += data; });
    child.stderr.on('data', data => { if (Buffer.byteLength(stderr) < 2 * 1024 * 1024) stderr += data; });
    child.once('error', error => finish(null, error));
    child.once('close', code => finish(code));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}

export async function collectArtifacts(workspace) {
  const directory = path.join(workspace, 'outputs');
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw Error('Output directory must not be a link');
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > 32) throw Error('At most 32 output artifacts are allowed');
  const artifacts = {};
  let total = 0;
  for (const entry of entries) {
    if (!/^[\p{L}\p{N}_. -]+\.(json|csv|txt|md)$/iu.test(entry.name) || entry.name.startsWith('.')) throw Error(`Unsupported output artifact: ${entry.name}`);
    const file = path.join(directory, entry.name), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw Error('Artifacts must be regular files, not links or directories');
    total += info.size;
    if (info.size > 1024 * 1024 || total > 4 * 1024 * 1024) throw Error('Output artifacts exceed size limit');
    artifacts[entry.name] = await readFile(file, 'utf8');
  }
  return artifacts;
}
