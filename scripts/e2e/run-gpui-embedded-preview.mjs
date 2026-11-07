import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { buildWindowsBootstrap, buildWindowsCimInvocation } from '../start-independent.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ppgpui-'));
const executable = path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe'
  : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
const environment = { ...process.env, PROFILEPILOT_GPUI_PREVIEW_HOME: home };
if (process.argv.includes('--consent')) environment.PROFILEPILOT_GPUI_CONSENT_PREVIEW = '1';
fs.writeFileSync(path.join(home, 'package.json'), JSON.stringify({ name: 'profilepilot-gpui-embedded-preview', version: '0.0.0',
  main: path.join(root, 'scripts/e2e/gpui-embedded.cjs') }));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let pid;
if (process.platform === 'win32') {
  const resultPath = path.join(home, 'launch.json');
  const powershellPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const bootstrapScript = buildWindowsBootstrap({ executable, repoRoot: home, resultPath, environment, background: true });
  const invocation = buildWindowsCimInvocation({ bootstrapScript, powershellPath });
  const launched = spawnSync(invocation.executable, invocation.args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (launched.error || launched.status !== 0) throw launched.error || new Error(launched.stderr || launched.stdout);
  if (JSON.parse(launched.stdout).ReturnValue !== 0) throw new Error(launched.stdout);
  for (let count = 0; count < 50 && !fs.existsSync(resultPath); count++) await delay(200);
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  if (!result.ok) throw new Error(result.error);
  pid = result.pid;
} else {
  const child = spawn(executable, [home], { cwd: home, detached: true, stdio: 'ignore', env: environment });
  child.unref(); pid = child.pid;
}
const resultPath = path.join(home, 'result.json');
for (let count = 0; count < 300 && !fs.existsSync(resultPath); count++) { process.kill(pid, 0); await delay(200); }
const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
if (!result.ok) throw new Error(JSON.stringify(result));
await delay(2000); process.kill(pid, 0);
console.log(JSON.stringify({ ...result, home, independentProcessConfirmed: true }, null, 2));
