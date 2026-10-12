const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const ready = { webSocketDebuggerUrl: 'ws://127.0.0.1:9999/devtools/browser/test' };
async function options(overrides = {}) {
  let clock = 0;
  return {
    child: { exitCode: null, signalCode: null }, spawnError: () => null,
    probe: async () => ready, timeoutMs: 500, port: 9999,
    now: () => clock, sleep: async ms => { clock += ms; }, ...overrides
  };
}

test('Windows normal launcher exit still waits for the relaunched Chrome CDP endpoint', async () => {
  const { waitForTestChrome } = await import('../scripts/test-chrome-lifecycle.mjs');
  let probes = 0;
  const result = await waitForTestChrome(await options({
    platform: 'win32', child: { exitCode: 0, signalCode: null },
    probe: async () => { if (++probes < 3) throw new Error('ECONNREFUSED'); return ready; }
  }));
  assert.equal(result, ready);
  assert.equal(probes, 3);
});

test('normal launcher exit without a ready browser times out instead of reporting success', async () => {
  const { waitForTestChrome } = await import('../scripts/test-chrome-lifecycle.mjs');
  await assert.rejects(waitForTestChrome(await options({
    platform: 'win32', child: { exitCode: 0, signalCode: null },
    probe: async () => { throw new Error('ECONNREFUSED'); }
  })), /Timed out.*launcher exited normally.*ECONNREFUSED/);
});

test('nonzero launcher exit and signals remain startup failures on Windows', async () => {
  const { waitForTestChrome } = await import('../scripts/test-chrome-lifecycle.mjs');
  for (const child of [{ exitCode: 1, signalCode: null }, { exitCode: null, signalCode: 'SIGTERM' }]) {
    await assert.rejects(waitForTestChrome(await options({
      platform: 'win32', child, probe: async () => assert.fail('must not probe after abnormal exit')
    })), /Chrome (exited|terminated)/);
  }
});

test('macOS and Linux retain immediate exit detection and ordinary live startup', async () => {
  const { waitForTestChrome } = await import('../scripts/test-chrome-lifecycle.mjs');
  for (const platform of ['darwin', 'linux']) {
    assert.equal(await waitForTestChrome(await options({ platform })), ready);
    await assert.rejects(waitForTestChrome(await options({ platform, child: { exitCode: 0 } })), /exit code 0/);
  }
});

test('spawn errors and incomplete CDP responses never report a ready browser', async () => {
  const { waitForTestChrome } = await import('../scripts/test-chrome-lifecycle.mjs');
  await assert.rejects(waitForTestChrome(await options({ spawnError: () => new Error('ENOENT') })), /ENOENT/);
  await assert.rejects(waitForTestChrome(await options({ probe: async () => ({}) })), /Timed out.*websocket/);
});

test('cleanup requires an exact overlay test profile inside the OS temporary directory', async () => {
  const { windowsTestChromeCleanupScript } = await import('../scripts/test-chrome-lifecycle.mjs');
  for (const unsafe of [os.tmpdir(), path.join(os.homedir(), 'pp-e2e-overlay-abc'), path.join(os.tmpdir(), 'Chrome'), path.join(os.tmpdir(), 'pp-e2e-overlay-abc', 'nested')]) {
    assert.throws(() => windowsTestChromeCleanupScript(unsafe), /Refusing Chrome cleanup/);
  }
  const safe = path.join(os.tmpdir(), 'pp-e2e-overlay-abc');
  const script = windowsTestChromeCleanupScript(safe);
  assert.ok(script.includes(Buffer.from(path.resolve(safe), 'utf8').toString('base64')));
  assert.match(script, /CreationDate -eq \$testProcess.CreationDate/);
  assert.match(script, /CommandLine -match \$profileArgument/);
});
