const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { Adb, adbLaunchDelays } = loadCli('src/main/phones/adb.ts');
const blocker = new Int32Array(new SharedArrayBuffer(4));
const child = () => ({ stdin: { on() {}, end() {} } });

test('ADB diagnostics measure synchronous launch blocking and never retain arguments', async () => {
  const since = Date.now(), secret = 'private-pairing-credential';
  const adb = new Adb('unused-test-executable', (_, args, options, callback) => {
    Atomics.wait(blocker, 0, 0, 120);
    queueMicrotask(() => callback(null, '1', ''));
    return child();
  });
  assert.equal(await adb.run(['-s', secret, 'shell', "'settings' 'get' 'global' 'adb_enabled'"]), '1');
  const observed = adbLaunchDelays(since);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].operation, 'settings');
  assert.ok(observed[0].spawnMs >= 100);
  assert.ok(!JSON.stringify(observed).includes(secret));
  assert.deepEqual(Object.keys(observed[0]).sort(), ['at', 'operation', 'resolveMs', 'spawnMs']);
  observed[0].operation = secret;
  assert.equal(adbLaunchDelays(since)[0].operation, 'settings');
});

test('a slow asynchronous ADB completion is not reported as event-loop launch blocking', async () => {
  const before = adbLaunchDelays(0);
  const adb = new Adb('unused-test-executable', (_, args, options, callback) => {
    setTimeout(() => callback(null, 'done', ''), 150);
    return child();
  });
  assert.equal(await adb.run(['devices', '-l']), 'done');
  assert.deepEqual(adbLaunchDelays(0), before);
});

test('slow binary launches are recorded with bounded redacted history', async () => {
  const adb = new Adb('unused-test-executable', (_, args, options, callback) => {
    Atomics.wait(blocker, 0, 0, 105);
    queueMicrotask(() => callback(null, Buffer.from('pixels'), Buffer.alloc(0)));
    return child();
  });
  for (let i = 0; i < 9; i++) assert.equal((await adb.runBinary(['-s', `hidden-device-${i}`, 'exec-out', 'screencap', '-p'])).toString(), 'pixels');
  const observed = adbLaunchDelays(0);
  assert.equal(observed.length, 8);
  assert.ok(observed.every(entry => entry.operation === 'other' && entry.spawnMs >= 100));
  assert.ok(!JSON.stringify(observed).includes('hidden-device'));
});
