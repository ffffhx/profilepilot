const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { loadCli } = require('./cli-test-build.cjs');
const { windowsPowerShellCliLauncherContent } = loadCli('src/main/shell-integration.ts');
const quote = value => "'" + value.replace(/'/g, "''") + "'";

test('PowerShell entry preserves arguments, Unicode stdin, exit status and caller environment', { skip: process.platform !== 'win32' }, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ppilot-powershell-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, '中文 空格'); fs.mkdirSync(bin);
  const cli = path.join(bin, 'echo-cli.cjs');
  fs.writeFileSync(cli, `const fs=require('node:fs'); if(process.argv[2]!=='--profilepilot-argv-env') throw Error('missing launcher envelope'); const args=JSON.parse(Buffer.from(process.env.PROFILEPILOT_LAUNCHER_ARGV,'base64').toString('utf8')); console.log(JSON.stringify({args,stdin:args.includes('--params-stdin')?fs.readFileSync(0,'utf8'):null,session:process.env.PROFILEPILOT_SESSION})); process.exitCode=args.includes('--fail')?64:0;`);
  fs.writeFileSync(path.join(bin, 'ppilot.ps1'), windowsPowerShellCliLauncherContent(cli, process.execPath), 'utf8');
  fs.writeFileSync(path.join(bin, 'ppilot.cmd'), '@echo WRONG_CMD_ENTRY\r\n@exit /b 99\r\n');
  const shells = [path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')];
  const pwsh = process.env.PROFILEPILOT_TEST_PWSH || spawnSync('where.exe', ['pwsh.exe'], { encoding: 'utf8' }).stdout?.trim().split(/\r?\n/)[0];
  if (pwsh && fs.existsSync(pwsh)) shells.push(pwsh);
  const args = ['browser', 'open', 'https://example.invalid/search?q=人工智能&src=typed_query&f=live', '', '中文 空格', '{"query":"a b\\\"c"}', 'C:\\folder with space\\', 'literal%PATH%|<>'];
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, CODEX_THREAD_ID: 'launcher-fixture' };
  delete env.AGENT_BROWSER_SESSION; delete env.PROFILEPILOT_SESSION; delete env.CLAUDE_CODE_SESSION_ID;
  function run(shell, command) {
    return spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { env, encoding: 'utf8', windowsHide: true });
  }
  for (const shell of shells) await t.test(path.basename(shell), () => {
    const discover = run(shell, '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Command ppilot).Source))');
    assert.equal(discover.status, 0, discover.stderr);
    assert.equal(Buffer.from(discover.stdout.trim(), 'base64').toString('utf8'), path.join(bin, 'ppilot.ps1'));
    const result = run(shell, 'ppilot ' + args.map(quote).join(' ') + '; exit $LASTEXITCODE');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '', 'PowerShell module autoload progress must not pollute CLI stderr');
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.args, args);
    assert.equal(payload.session, 'cx-launcher-fixture');
    const input = '{"query":"人工智能 热点"}';
    const piped = run(shell, `${quote(input)} | ppilot browser status --params-stdin; exit $LASTEXITCODE`);
    assert.equal(piped.status, 0, piped.stderr);
    assert.equal(JSON.parse(piped.stdout).stdin.trim(), input);
    const failed = run(shell, 'ppilot --fail; exit $LASTEXITCODE');
    assert.equal(failed.status, 64, failed.stderr);
    const clean = run(shell, "$before = $OutputEncoding.CodePage; $progressBefore = $ProgressPreference; $env:PROFILEPILOT_LAUNCHER_ARGV = 'preserve-existing-value'; 'input' | ppilot --params-stdin | Out-Null; if ($env:PROFILEPILOT_SESSION -or $env:AGENT_BROWSER_SESSION -or $env:PROFILEPILOT_LAUNCHER_ARGV -ne 'preserve-existing-value' -or $OutputEncoding.CodePage -ne $before -or $ProgressPreference -ne $progressBefore) { exit 91 }; exit 0");
    assert.equal(clean.status, 0, clean.stderr);
    const empty = run(shell, 'ppilot; exit $LASTEXITCODE');
    assert.equal(empty.status, 0, empty.stderr); assert.deepEqual(JSON.parse(empty.stdout).args, []);
  });
});
