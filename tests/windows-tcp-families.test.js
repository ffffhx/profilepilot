const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsModule } = require('./helpers/load-ts-module.js');

const header = 'Active Connections\n  Proto  Local Address  Foreign Address  State  PID\n';
const ipv4 = header + 'TCP  127.0.0.1:9223  0.0.0.0:0  LISTENING  41\n';
const ipv6 = header + 'TCP  [::1]:9224  [::]:0  LISTENING  42\n';
const platformOverrides = new WeakSet();
function fixture(t, outputs) {
  if (!platformOverrides.has(t)) {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    t.after(() => Object.defineProperty(process, 'platform', original));
    platformOverrides.add(t);
  }
  const calls = [];
  const api = loadTsModule('src/main/windows-platform.ts', { stubs: {
    './windows-sampler': { sampleWindowsProcesses: async () => ({ complete: true, processes: [{ pid: 41, parentPid: 1, name: 'Owned.exe' }, { pid: 42, parentPid: 1, name: 'Owned.exe' }] }),
      sampleWindowsFileLocks: () => assert.fail('Unexpected sampler child') },
    'node:util': { promisify: () => async (executable, args) => {
      if (executable !== 'netstat') return { stdout: JSON.stringify({ processes: [{ pid: 41, parentPid: 1, name: 'Owned.exe' }, { pid: 42, parentPid: 1, name: 'Owned.exe' }] }) };
      const family = args.at(-1); calls.push(family);
      const output = outputs[family]; if (output instanceof Error) throw output;
      return output;
    } }
  } });
  return { api, calls };
}

test('Windows process evidence contains owned IPv4 and IPv6 listeners from separate complete reads', async t => {
  const { api, calls } = fixture(t, { tcp: { stdout: ipv4 }, tcpv6: { stdout: ipv6 } });
  const sample = await api.collectWindowsControlSample();
  assert.deepEqual(calls.sort(), ['tcp', 'tcpv6']);
  assert.deepEqual(sample.snapshot.tcp.map(row => [row.pid, row.localAddress, row.localPort]), [[41, '127.0.0.1', 9223], [42, '::1', 9224]]);
  assert.equal(sample.snapshot.tcpAvailable, true); assert.equal(sample.snapshot.tcpComplete, true);
});

for (const family of ['tcp', 'tcpv6']) test('failure of ' + family + ' retains other rows but cannot certify port absence', async t => {
  const outputs = { tcp: { stdout: ipv4 }, tcpv6: { stdout: ipv6 } }; outputs[family] = new Error('owned read failed');
  const { api } = fixture(t, outputs); const snapshot = await api.getWindowsSystemSnapshot();
  assert.equal(snapshot.tcpAvailable, true); assert.equal(snapshot.tcpComplete, false);
  assert.deepEqual(snapshot.tcp.map(row => row.pid), [family === 'tcp' ? 42 : 41]);
});

test('IPv6 warnings or a missing envelope never make an otherwise complete IPv4 table complete', async t => {
  for (const output of [{ stdout: ipv6, stderr: 'partial read' }, { stdout: '' }, { stdout: header + 'TCP broken' }]) {
    const { api } = fixture(t, { tcp: { stdout: ipv4 }, tcpv6: output });
    const snapshot = await api.getWindowsSystemSnapshot(); assert.equal(snapshot.tcpComplete, false);
  }
});

test('both readable localized empty tables prove emptiness while two failed reads remain unavailable', async t => {
  const empty = { stdout: '活动连接\n  协议  本地地址  外部地址  状态  PID\n' };
  const first = fixture(t, { tcp: empty, tcpv6: empty }); const snapshot = await first.api.getWindowsSystemSnapshot();
  assert.equal(snapshot.tcpComplete, true); assert.deepEqual(snapshot.tcp, []);
  const failed = fixture(t, { tcp: new Error('failed'), tcpv6: new Error('failed') });
  const missing = await failed.api.getWindowsSystemSnapshot(); assert.equal(missing.tcpAvailable, false); assert.equal(missing.tcpComplete, false);
});

test('unexpected address families cannot certify the requested family was collected', async t => {
  const { api } = fixture(t, { tcp: { stdout: ipv4 }, tcpv6: { stdout: ipv4 } });
  const snapshot = await api.getWindowsSystemSnapshot(); assert.equal(snapshot.tcpComplete, false);
  assert.equal(snapshot.tcp.length, 1, 'Keep one best-effort row, not duplicated evidence');
});
