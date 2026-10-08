const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { readDebugSettings } = loadCli('src/main/phones/readiness.ts');

test('fixed diagnostic reads distinguish on, off and unavailable without changing settings', async () => {
  const calls = [];
  const value = await readDebugSettings({ run: async (args, timeout) => {
    calls.push(args); assert.equal(timeout, 1500);
    if (args[3].includes('development_settings_enabled')) return '1\r\n';
    if (args[3].includes('adb_wifi_enabled')) return '0\n';
    throw new Error('read unavailable');
  } }, 'SERIAL-1');
  assert.deepEqual(value, { developerOptions: 'enabled', usbDebugging: 'unconfirmed', wirelessDebugging: 'disabled' });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(args => args[0] === '-s' && args[1] === 'SERIAL-1' && args[2] === 'shell' && args[3].startsWith("'settings' 'get' 'global' ")));
});

test('absent, malformed and failed reads cannot be treated as disabled', async () => {
  for (const output of ['', 'null', 'Permission denied', 'false', '0\n1']) {
    const value = await readDebugSettings({ run: async () => output }, 'SERIAL-1');
    assert.ok(Object.values(value).every(state => state === 'unconfirmed'));
  }
  const value = await readDebugSettings({ run: () => { throw new Error('process unavailable'); } }, 'SERIAL-1');
  assert.ok(Object.values(value).every(state => state === 'unconfirmed'));
});
