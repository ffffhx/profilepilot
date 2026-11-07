import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';

// Acceptance runner only: one CLI process, one absolute deadline, no retries.
// A timeout does not establish whether an App request ran. The caller must
// reconcile its own session and must never replay input based on this error.
export function runDesktopCliProcess({ entry, args, env = process.env, cwd, timeoutMs = 70000, expectedExitCode = 0,
  maxOutputBytes = 8 * 1024 * 1024 }, { spawnProcess = spawn } = {}) {
  if (typeof entry !== 'string' || !Array.isArray(args) || args.some(value => typeof value !== 'string') ||
    !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 ||
    !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16 * 1024 * 1024 ||
    (expectedExitCode !== null && !Number.isInteger(expectedExitCode))) throw new Error('Invalid desktop CLI runner options.');
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, bytes = 0;
    const stdout = [], stderr = [];
    const fail = (error, stop = false) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (stop && child) {
        try { error.killRequested = child.kill(); } catch (failure) { error.terminationError = failure.message; }
        // Do not wait for close after a deadline: a broken child or inherited
        // pipe must not keep the harness from its independent fixture cleanup.
        for (const close of [() => child.stdout?.destroy(), () => child.stderr?.destroy(), () => child.unref()]) {
          try { close(); } catch (failure) { error.terminationError ||= failure.message; }
        }
      }
      reject(error);
    };
    const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code, outcome: 'unknown', pid: child?.pid, ...extra });
    try { child = spawnProcess(process.execPath, [entry, ...args], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { fail(error); return; }
    child.on('error', error => fail(error, true));
    for (const pipe of [child.stdout, child.stderr]) if (typeof pipe?.on === 'function') pipe.on('error', error => fail(error, true));
    if (!child.stdout || !child.stderr || typeof child.stdout.on !== 'function' || typeof child.stderr.on !== 'function') {
      fail(failure('DESKTOP_CLI_PIPE_UNAVAILABLE', 'Desktop CLI output pipes are unavailable.'), true); return;
    }
    const collect = destination => chunk => {
      if (settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > maxOutputBytes) { fail(failure('DESKTOP_CLI_OUTPUT_LIMIT', 'Desktop CLI output exceeded its UTF-8 byte limit.', { maxOutputBytes }), true); return; }
      destination.push(value);
    };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      let output, errors, response;
      try {
        output = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdout));
        errors = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stderr));
        response = JSON.parse(output);
      } catch { fail(failure('DESKTOP_CLI_INVALID_OUTPUT', 'Desktop CLI did not return valid UTF-8 JSON.', { exitCode })); return; }
      if (!Number.isInteger(exitCode) || (expectedExitCode !== null && exitCode !== expectedExitCode)) {
        fail(failure('DESKTOP_CLI_EXIT', `Desktop CLI exited ${exitCode}; expected ${expectedExitCode}.`, { exitCode, signal, response, stderr: errors.slice(0, 8192) })); return;
      }
      settled = true; clearTimeout(timer); resolve({ exitCode, response });
    });
    timer = setTimeout(() => fail(failure('DESKTOP_CLI_TIMEOUT', `Desktop CLI exceeded its ${timeoutMs} ms total deadline; request outcome is unknown.`, { timeoutMs }), true), timeoutMs);
  });
}
