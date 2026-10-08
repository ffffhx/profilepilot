const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { terminalEnvironment, terminalInvocation } = require('../dist/main/tasks/terminal');

if (process.platform !== 'win32') process.exit(0);
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-shell-probe-')));
const command = '[Console]::WriteLine("before cmdlets"); [IO.File]::WriteAllText((Join-Path $PWD "unicode.txt"), "hello"); [Console]::WriteLine("before read"); Get-Content -LiteralPath "unicode.txt"; [Console]::WriteLine("complete")';
const invocation = terminalInvocation('win32', 'shell', path.join(root, 'probe.ps1'), command);
const source = invocation.source.replace(/^\uFEFF/, '').split('\n').map((line, index) => `[Console]::Error.WriteLine("stage:${index}")\n${line}`).join('\n');
fs.writeFileSync(invocation.args.at(-1), '\uFEFF' + source);
const filtered = terminalEnvironment();
const withPlatformPaths = { ...filtered };
for (const key of Object.keys(process.env)) {
  if (/^(ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramFiles\(x86\)|CommonProgramW6432|SystemDrive)$/i.test(key)) withPlatformPaths[key] = process.env[key];
}
try {
  for (const [label, env] of [['filtered', filtered], ['platform-paths', withPlatformPaths], ['host', process.env]]) {
    const started = Date.now();
    const result = spawnSync(invocation.executable, invocation.args, { env, cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true });
    console.log(JSON.stringify({ label, elapsedMs: Date.now() - started, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message }));
    if (result.status !== 0) process.exitCode = 1;
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
