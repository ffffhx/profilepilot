const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runBrowserCli, parseBrowserCliRoute, browserCliRuntime } = require('./cli-test-build.cjs').loadCli('src/main/browser-cli.ts');

function fixture() {
  const calls = []; let stdout = '', stderr = '';
  return {
    calls, io: { stdout: { write: text => stdout += text }, stderr: { write: text => stderr += text } },
    output: () => ({ stdout, stderr }),
    runtime: {
      executable: () => '/private/bundled-driver',
      extension: async args => { calls.push({ connection: 'extension', args }); },
      gateway: async (args, env) => { calls.push({ connection: 'gateway', args, env }); return 0; }
    }
  };
}

test('extension remains the default even with an inherited Gateway session', async () => {
  const f = fixture();
  assert.equal(await runBrowserCli(['--profile', 'native:Default', 'tabs'], f.io, { AGENT_BROWSER_SESSION: 'old-task' }, f.runtime), 0);
  assert.deepEqual(f.calls, [{ connection: 'extension', args: ['--profile', 'native:Default', 'tabs'] }]);
});

test('Gateway uses bundled runtime, preserves arguments and reuses host identity', async () => {
  const f = fixture();
  const payload = "JSON.stringify({text:'中文 --connection extension',url:'https://example.com/?a=1&b=2'})";
  const env = { CODEX_THREAD_ID: 'test-thread', PROFILEPILOT_AGENT_BROWSER_REAL: '/unrelated-global-driver' };
  assert.equal(await runBrowserCli(['--cdp=9223', 'eval', payload], f.io, env, f.runtime), 0);
  assert.deepEqual(f.calls[0].args, ['--cdp', '9223', 'eval', payload]);
  assert.equal(f.calls[0].env.PROFILEPILOT_AGENT_BROWSER_REAL, '/private/bundled-driver');
  assert.equal(f.calls[0].env.AGENT_BROWSER_SESSION, 'cx-test-thread');
  assert.equal(f.calls[0].env.PROFILEPILOT_BROWSER_CLI, '1');
  assert.equal(env.AGENT_BROWSER_SESSION, undefined, 'do not alter the host environment');
});

test('lifecycle commands use the same guarded wrapper and propagate a hard stop without fallback', async () => {
  const f = fixture();
  f.runtime.gateway = async (args, env) => { f.calls.push({ args, env }); return 75; };
  assert.equal(await runBrowserCli(['--session', 'task', '--cdp', '9223', 'handoff', '--reason', '登录后交还'], f.io, {}, f.runtime), 75);
  assert.deepEqual(f.calls[0].args, ['--session', 'task', '--cdp', '9223', 'profilepilot', 'handoff', '--reason', '登录后交还']);
  assert.equal(f.calls.length, 1);
});

test('ambiguous, unbound and unsupported Gateway routes never call a driver', async () => {
  for (const args of [
    ['--connection', 'extension', '--cdp', '9223', 'snapshot'],
    ['--connection', 'other', 'status'],
    ['--cdp', 'ws://localhost:9223', 'snapshot'],
    ['--cdp', '9223', '--cdp', '9224', 'snapshot'],
    ['--connection', 'gateway', 'snapshot'],
    ['--cdp', '9223', 'snapshot'], // no session
    ['--session', 'task', '--cdp', '9223', '--profile', 'native:Default', 'snapshot'],
    ['--session', 'task', '--cdp', '9223', 'install']
  ]) {
    const f = fixture();
    assert.equal(await runBrowserCli(args, f.io, {}, f.runtime), 64, args.join(' '));
    assert.equal(f.calls.length, 0);
    assert.equal(JSON.parse(f.output().stderr).code, 'BROWSER_CLI_INVALID_ARGUMENTS');
  }
});

test('routing never interprets payload values or rewrites extension CDP', () => {
  for (const args of [
    ['action', '--params', '{"value":"--cdp"}'],
    ['--params', '--cdp=9223', 'action'],
    ['cdp', 'Runtime.evaluate', '--params', '{"expression":"1"}']
  ]) {
    if (args[0] === '--params') {
      assert.throws(() => parseBrowserCliRoute(args), /需要参数/); // invalid prefix value, never a route
    } else {
      const route = parseBrowserCliRoute(args);
      assert.equal(route.connection, 'extension');
      assert.deepEqual(route.args, args);
    }
  }
  const f = parseBrowserCliRoute(['--cdp', '9223', 'fill', '@e1', '--connection']);
  assert.equal(f.connection, 'gateway');
  assert.equal(f.args.at(-1), '--connection');
});

test('help is local and an explicitly broken installed runtime never falls back to PATH', async () => {
  const f = fixture();
  assert.equal(await runBrowserCli(['--connection', 'gateway', '--help'], f.io, {}, f.runtime), 0);
  assert.equal(f.calls.length, 0);
  assert.match(f.output().stdout, /ppilot browser CLI/);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ppilot-browser-runtime-'));
  try {
    writeFileSync(path.join(dir, 'browser-runtime.json'), JSON.stringify({ executable: path.join(dir, 'missing.exe') }));
    assert.throws(() => browserCliRuntime(dir), /内置浏览器驱动缺失/);
    writeFileSync(path.join(dir, 'browser-runtime.json'), JSON.stringify({ executable: process.execPath }));
    assert.equal(browserCliRuntime(dir), process.execPath);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
