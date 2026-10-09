import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWindowsCimInvocation, quoteWindowsArgument } from './start-independent.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'artifacts/shared-skills');
mkdirSync(output, { recursive: true });
const resultFile = path.join(output, 'preview-processes.json');
const stampFile = path.join(output, `preview-launch-${Date.now()}.json`);
const electron = path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
const electronArgs = [root, `--user-data-dir=${path.join(output, 'electron-data')}`];
const serverArgs = [path.join(root, 'scripts/serve-workflow-preview.mjs')];
const alive = pid => { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const previous = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : {};
const needApp = !alive(previous.appPid || -1), needServer = !alive(previous.serverPid || -1);
let result = { ...previous };
if (needApp || needServer) {
  const environment = { CPM_DATA_DIR: path.join(output, 'app-data'), CPM_START_VIEW: 'agent', CPM_ELECTRON_SMOKE_TEST: '1', PROFILEPILOT_SKILL_ROOTS: path.resolve(root, '../my-agent-skills/skills') };
  if (process.platform === 'win32') {
    const ps = value => "'" + String(value).replace(/'/g, "''") + "'";
    const bootstrap = [
      "$ErrorActionPreference = 'Stop'",
      ...Object.entries(environment).map(([name, value]) => `$env:${name} = ${ps(value)}`),
      '$launched = @{}',
      ...(needApp ? [`$previewApp = Start-Process -FilePath ${ps(electron)} -ArgumentList ${ps(electronArgs.map(quoteWindowsArgument).join(' '))} -WorkingDirectory ${ps(root)} -PassThru`, '$launched.appPid = $previewApp.Id'] : []),
      ...(needServer ? [`$previewServer = Start-Process -FilePath ${ps(process.execPath)} -ArgumentList ${ps(serverArgs.map(quoteWindowsArgument).join(' '))} -WorkingDirectory ${ps(root)} -WindowStyle Hidden -PassThru`, '$launched.serverPid = $previewServer.Id'] : []),
      `[IO.File]::WriteAllText(${ps(stampFile)}, ($launched | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))`
    ].join('\n');
    const powershellPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const invocation = buildWindowsCimInvocation({ bootstrapScript: bootstrap, powershellPath });
    const launch = spawnSync(invocation.executable, invocation.args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (launch.status !== 0) throw new Error(launch.stderr || launch.stdout);
    for (let i = 0; i < 60 && !existsSync(stampFile); i++) await new Promise(resolve => setTimeout(resolve, 200));
    if (!existsSync(stampFile)) throw new Error('Independent launcher did not return a process record');
    result = { ...result, ...JSON.parse(readFileSync(stampFile, 'utf8')) };
  } else {
    for (const [key, executable, args] of [['appPid', electron, electronArgs], ['serverPid', process.execPath, serverArgs]]) {
      if ((key === 'appPid' && !needApp) || (key === 'serverPid' && !needServer)) continue;
      const child = spawn(executable, args, { cwd: root, env: { ...process.env, ...environment }, detached: true, stdio: 'ignore' });
      child.unref(); result[key] = child.pid;
    }
  }
}
await new Promise(resolve => setTimeout(resolve, 2500));
if (!alive(result.appPid) || !alive(result.serverPid)) throw new Error('A preview process exited');
const response = await fetch('http://127.0.0.1:18765/');
if (!response.ok) throw new Error('Report preview is not reachable');
result.url = 'http://127.0.0.1:18765/';
writeFileSync(resultFile, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
