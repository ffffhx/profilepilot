const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { loadCli } = require('./cli-test-build.cjs');
const { readAvdMemoryMb, parseMacAvailableMemory, readHostMemory, assertEmulatorMemory } = loadCli('src/main/phones/emulator-memory.ts');
const GB = 1024 ** 3;

function files(t, values) {
  t.mock.method(fs, 'existsSync', file => Object.hasOwn(values, file));
  t.mock.method(fs, 'readFileSync', file => {
    if (!Object.hasOwn(values, file)) throw Error('missing fixture file');
    return values[file];
  });
}

test('Windows AVD index follows a relocated drive and paths containing spaces', t => {
  files(t, {
    'C:\\User Data\\avd\\Phone.ini': 'path=D:\\Virtual Phones\\Phone.avd\r\n',
    'D:\\Virtual Phones\\Phone.avd\\config.ini': 'hw.ramSize = 3072\r\n',
  });
  assert.equal(readAvdMemoryMb('Phone', { ANDROID_AVD_HOME: 'C:\\User Data\\avd' }, 'win32', 'C:\\Users\\tester'), 3072);
});

test('macOS uses custom user home and the relative fallback for a moved AVD', t => {
  files(t, {
    '/Users/tester/Android Config/avd/Phone.ini': 'path=/old/Phone.avd\npath.rel=avd/Phone.avd\n',
    '/Users/tester/Android Config/avd/Phone.avd/config.ini': 'hw.ramSize=4G\n',
  });
  assert.equal(readAvdMemoryMb('Phone', { ANDROID_USER_HOME: '/Users/tester/Android Config' }, 'darwin', '/Users/tester'), 4096);
});

test('AVD search honors precedence and legacy SDK home without underestimating RAM', t => {
  const values = {
    '/preferred/Phone.ini': 'path=/large/Phone.avd',
    '/large/Phone.avd/config.ini': 'hw.ramSize=8192',
    '/legacy/.android/avd/Phone.ini': 'path=/small/Phone.avd',
    '/small/Phone.avd/config.ini': 'hw.ramSize=1024M',
  };
  files(t, values);
  assert.equal(readAvdMemoryMb('Phone', { ANDROID_AVD_HOME: '/preferred', ANDROID_SDK_HOME: '/legacy' }, 'darwin', '/home'), 8192);
  assert.equal(readAvdMemoryMb('Phone', { ANDROID_SDK_HOME: '/legacy' }, 'darwin', '/home'), 1536);
  values['/large/Phone.avd/config.ini'] = 'hw.ramSize=invalid';
  assert.throws(() => readAvdMemoryMb('Phone', { ANDROID_AVD_HOME: '/preferred', ANDROID_SDK_HOME: '/legacy' }, 'darwin', '/home'), /无法确认/);
});

test('missing, automatic or malformed AVD memory fails closed rather than assuming a small device', t => {
  const values = { '/avd/Phone.ini': 'path=/avd/Phone.avd', '/avd/Phone.avd/config.ini': '' };
  files(t, values);
  for (const value of ['', '0', '-1024', 'NaN', '2.5', '2048garbage', '99999999999999999999']) {
    values['/avd/Phone.avd/config.ini'] = `hw.ramSize=${value}`;
    assert.throws(() => readAvdMemoryMb('Phone', { ANDROID_AVD_HOME: '/avd' }, 'darwin', '/home'), /已取消启动/);
  }
  assert.throws(() => readAvdMemoryMb('Unknown', {}, 'darwin', '/home'), /已取消启动/);
  for (const name of ['../Phone', '.', '..']) assert.throws(() => readAvdMemoryMb(name), /名称无效/);
});

test('low physical RAM blocks even with abundant Windows commit capacity', () => {
  assert.throws(() => assertEmulatorMemory('Phone', 3072, { totalBytes: 16 * GB, availableBytes: 1.5 * GB, commitAvailableBytes: 64 * GB }), error => {
    assert.match(error.message, /当前可用 1.5 GB/);
    assert.match(error.message, /至少需要 6.0 GB/);
    assert.match(error.message, /系统预留 2.0 GB/);
    return true;
  });
});

test('commit exhaustion blocks despite adequate RAM, and exact budgets succeed', () => {
  assert.throws(() => assertEmulatorMemory('Phone', 3072, { totalBytes: 16 * GB, availableBytes: 10 * GB, commitAvailableBytes: 5 * GB }), /Windows 可提交内存不足/);
  assert.doesNotThrow(() => assertEmulatorMemory('Phone', 3072, { totalBytes: 16 * GB, availableBytes: 6 * GB, commitAvailableBytes: 6 * GB }));
  assert.throws(() => assertEmulatorMemory('Large', 8192, { totalBytes: 32 * GB, availableBytes: 11 * GB }), /至少需要 12.0 GB/);
  assert.throws(() => assertEmulatorMemory('Tencent', 8192, { totalBytes: 16 * GB, availableBytes: 2 * GB }, true), /按 8.0 GB 估算/);
});

test('Windows queries physical and system commit counters without counting disk space', async t => {
  t.mock.method(os, 'totalmem', () => 16 * GB);
  const result = await readHostMemory('win32', async (script, options) => {
    assert.match(script, /Win32_PerfFormattedData_PerfOS_Memory/);
    assert.match(script, /CommitLimit - \[double\]\$memory.CommittedBytes/);
    assert.ok(options.timeout <= 5000);
    return JSON.stringify({ availableBytes: 3 * GB, commitAvailableBytes: 9 * GB });
  }, async () => assert.fail('must not run macOS command'));
  assert.deepEqual(result, { totalBytes: 16 * GB, availableBytes: 3 * GB, commitAvailableBytes: 9 * GB });
});

const vmStat = pageSize => `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)\nPages free: 1000.\nPages inactive: 3000.\nPages speculative: 100.\nPages purgeable: 2000.\nPages wired down: 9000.\nPages occupied by compressor: 8000.\n`;

test('macOS includes reclaimable pages with Intel/Apple Silicon page sizes, without double counting purgeable memory', async t => {
  t.mock.method(os, 'totalmem', () => 16 * GB);
  t.mock.method(os, 'freemem', () => assert.fail('raw free pages undercount macOS availability'));
  for (const pageSize of [4096, 16384]) {
    assert.equal(parseMacAvailableMemory(vmStat(pageSize)), 4100 * pageSize);
    const result = await readHostMemory('darwin', async () => assert.fail('must not use PowerShell'), async (file, args) => {
      assert.equal(file, '/usr/bin/vm_stat'); assert.deepEqual(args, []); return vmStat(pageSize);
    });
    assert.equal(result.availableBytes, 4100 * pageSize);
    assert.equal(result.commitAvailableBytes, undefined);
  }
});

test('failed and invalid host readings block startup and are never cached', async t => {
  t.mock.method(os, 'totalmem', () => 16 * GB);
  for (const output of ['bad json', '{}', '{"availableBytes":-1,"commitAvailableBytes":1}', '{"availableBytes":1,"commitAvailableBytes":null}', '{"availableBytes":999999999999,"commitAvailableBytes":1}']) {
    await assert.rejects(readHostMemory('win32', async () => output), /已取消启动模拟器/);
  }
  await assert.rejects(readHostMemory('win32', async () => { throw Error('timeout'); }), /已取消启动模拟器/);
  await assert.rejects(readHostMemory('darwin', undefined, async () => 'invalid'), /已取消启动模拟器/);
  let availableBytes = GB;
  const probe = async () => JSON.stringify({ availableBytes, commitAvailableBytes: 10 * GB });
  assert.equal((await readHostMemory('win32', probe)).availableBytes, GB);
  availableBytes = 8 * GB;
  assert.equal((await readHostMemory('win32', probe)).availableBytes, 8 * GB);
});
