import { spawn, spawnSync } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWindowsCimInvocation, quoteWindowsArgument } from './start-independent.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'test-results/browser-tasks');
await mkdir(output, { recursive: true });
const recordPath = path.join(output, 'collaboration-preview.json');
const alive = pid => { try { return Number.isSafeInteger(pid) && pid > 0 && (process.kill(pid, 0), true); } catch { return false; } };
async function ready() {
  try {
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    if (alive(record.pid) && alive(record.appPid) && (await fetch(record.url, { signal: AbortSignal.timeout(2000) })).ok) return record;
  } catch {}
}
let record = await ready();
if (!record) {
  const args = [path.join(root, 'scripts/e2e-task-collaboration.mjs'), '--preview'];
  if (process.platform === 'win32') {
    const ps = value => "'" + String(value).replaceAll("'", "''") + "'";
    const bootstrapScript = `$ErrorActionPreference = 'Stop'\nStart-Process -FilePath ${ps(process.execPath)} -ArgumentList ${ps(args.map(quoteWindowsArgument).join(' '))} -WorkingDirectory ${ps(root)} -WindowStyle Hidden -RedirectStandardOutput ${ps(path.join(output, 'collaboration-preview.out.log'))} -RedirectStandardError ${ps(path.join(output, 'collaboration-preview.err.log'))}`;
    const powershellPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const invocation = buildWindowsCimInvocation({ bootstrapScript, powershellPath });
    const result = spawnSync(invocation.executable, invocation.args, { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    if (JSON.parse(result.stdout).ReturnValue !== 0) throw new Error(result.stdout);
  } else {
    const child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: 'ignore' }); child.unref();
  }
  const deadline = Date.now() + 45000;
  while (!record && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 250)); record = await ready(); }
  if (!record) throw new Error(`Preview did not start; inspect ${output}`);
}
console.log(JSON.stringify(record, null, 2));
