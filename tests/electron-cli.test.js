const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runElectronCli, listElectronTargets } = require('./cli-test-build.cjs').loadCli('src/main/electron-cli.ts');

function fixture(exitCode = 0) {
  let stdout = '', stderr = '';
  const calls = [];
  return { calls, output: () => ({ stdout, stderr }),
    io: { stdout: { write: text => stdout += text }, stderr: { write: text => stderr += text } },
    runtime: { targets: () => [{ id: 'local-app:test', name: '测试应用', port: 49337 }],
      browser: async (args, _io, env) => { calls.push({ args, env }); return exitCode; } }
  };
}

test('Electron routes only the chosen application through the existing Gateway and propagates takeover', async () => {
  for (const operation of [['snapshot', '-i'], ['fill', '@e1', '中文 --connection extension'], ['handoff'], ['complete']]) {
    const f = fixture(75), env = { CODEX_THREAD_ID: 'same-owner' };
    const args = ['--session', 'test', '--cdp', '49337', ...operation];
    assert.equal(await runElectronCli(args, f.io, env, f.runtime), 75);
    assert.deepEqual(f.calls, [{ args: ['--connection', 'gateway', ...args], env }]);
  }
});

test('Electron rejects browser targets, raw ports and target switching before driver invocation', async () => {
  for (const args of [
    ['snapshot'], ['--cdp', '9224', 'snapshot'], ['--cdp', '9337', 'snapshot'],
    ['--connection', 'extension', 'status'], ['--profile', 'native:Default', 'status'],
    ['--cdp', '49337', 'use', 'Browser'], ['--cdp', '49337', 'connect', '9224'],
    ['--cdp', '49337', 'close'], ['--cdp', '49337', 'profiles'],
    ['--cdp', '49337', '--cdp', '9224', 'snapshot']
  ]) {
    const f = fixture();
    assert.equal(await runElectronCli(args, f.io, {}, f.runtime), 64, args.join(' '));
    assert.equal(f.calls.length, 0);
    assert.equal(JSON.parse(f.output().stderr).code, 'ELECTRON_CLI_INVALID_ARGUMENTS');
  }
});

test('Electron list is read only and help describes its application scope', async () => {
  const f = fixture();
  assert.equal(await runElectronCli(['list', '--json'], f.io, {}, f.runtime), 0);
  assert.equal(JSON.parse(f.output().stdout).apps[0].name, '测试应用');
  assert.equal(f.calls.length, 0);
  const help = fixture();
  assert.equal(await runElectronCli(['--help'], help.io, {}, help.runtime), 0);
  assert.match(help.output().stdout, /ppilot electron/);
  assert.match(help.output().stdout, /Agent 逻辑端口/);
  assert.equal(help.calls.length, 0);
});

test('Electron catalog includes only registered applications and never exposes raw debug ports', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pp-electron-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(listElectronTargets(root), []);
  const directory = path.join(root, '.profilepilot', 'gateway');
  mkdirSync(directory, { recursive: true });
  const catalog = path.join(directory, 'managed-profiles.json');
  writeFileSync(catalog, JSON.stringify({ profiles: [
    { profileId: 'isolated:browser', profileName: 'Browser', publicPort: 9224 },
    { profileId: 'local-app:app', profileName: '应用', publicPort: 49337, electronCdpPort: 9337 },
    { profileId: 'local-app:invalid', profileName: 'Invalid', publicPort: 70000, electronCdpPort: 9338 }, null
  ] }));
  assert.deepEqual(listElectronTargets(root), [{ id: 'local-app:app', name: '应用', port: 49337 }]);
  writeFileSync(catalog, 'broken');
  assert.throws(() => listElectronTargets(root), SyntaxError);
});
