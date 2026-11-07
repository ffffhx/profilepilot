const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../scripts/verify-windows-tcp.mjs');
const nonce = 'a'.repeat(32), hash = 'b'.repeat(64);
const identity = () => ({ ok: true, pid: 42, parentPid: 1, startedUtcTicks: '639289000000000000', executable: 'C:\\owned\\node.exe', sha256: hash, integrityRid: 8192, elevated: false, uiAccess: false });
test('TCP harness defaults to check and fixes five alternating rounds', async () => {
  const { tcpOptions, tcpOrder } = await load();
  assert.deepEqual(tcpOptions([]), { run: false, rounds: 5 }); assert.equal(tcpOptions(['--check']).run, false); assert.equal(tcpOptions(['--run']).run, true);
  for (const args of [['--run', '--check'], ['--run', '--run'], ['--rounds', '100'], ['--medium']]) assert.throws(() => tcpOptions(args));
  assert.deepEqual(Array.from({ length: 5 }, (_, i) => tcpOrder(i)), [['netstat', 'native'], ['native', 'netstat'], ['netstat', 'native'], ['native', 'netstat'], ['netstat', 'native']]);
});
test('five paired summaries retain first-run timing and do not hide failed/missing samples', async () => {
  const { tcpSummary, tcpOrder } = await load();
  const rounds = Array.from({ length: 5 }, (_, index) => ({ index: index + 1, order: tcpOrder(index), samples: tcpOrder(index).map(variant => ({ variant, ok: true,
    wallMs: variant === 'native' ? [10, 2, 3, 4, 5][index] : [20, 12, 13, 14, 15][index], samplingChildren: variant === 'native' ? 1 : 2 })) }));
  const summary = tcpSummary(rounds); assert.deepEqual(summary.map(value => [value.variant, value.firstWallMs, value.medianWallMs, value.samplingChildren]), [['netstat', 20, 14, 10], ['native', 10, 4, 5]]);
  assert.throws(() => tcpSummary(rounds.slice(1))); const failed = structuredClone(rounds); failed[0].samples[0].ok = false; assert.throws(() => tcpSummary(failed));
});
test('launcher side effect followed by rejection still recovers full identity and sends nonce close', async () => {
  const { tcpRunnerLifecycle } = await load(), events = []; let alive = false, returned;
  const lifecycle = tcpRunnerLifecycle({ nonce, executable: identity().executable, sha256: hash }, {
    launch: async () => { alive = true; throw Object.assign(new Error('handshake failed after start'), { code: 'LAUNCH_FAILURE' }); },
    ready: async () => { events.push('ready'); return { nonce, identity: identity() }; },
    inspect: async pid => { assert.equal(pid, 42); assert.equal(alive, true); events.push('inspect'); return identity(); },
    requestClose: async () => { events.push('close'); alive = false; },
    retire: async original => { assert.equal(original.startedUtcTicks, identity().startedUtcTicks); assert.equal(alive, false); events.push('exit'); return { ok: true, exit: { originalExited: true } }; }
  });
  await assert.rejects(async () => { returned = await lifecycle.launch(); }, { code: 'LAUNCH_FAILURE' }); assert.equal(returned, undefined);
  const result = await lifecycle.cleanup(); assert.equal(result.ok, true); assert.equal(result.identityRecovered, true); assert.equal(alive, false);
  assert.deepEqual(events, ['ready', 'inspect', 'close', 'exit']);
});
test('untrusted ready/identity cannot authorize force, but always gets nonce close', async () => {
  const { tcpRunnerLifecycle } = await load();
  for (const mode of ['nonce', 'birth', 'hash', 'elevated', 'parent', 'missing']) {
    let closed = 0, retired = 0;
    const lifecycle = tcpRunnerLifecycle({ nonce, executable: identity().executable, sha256: hash }, {
      launch: async () => { throw Error('after side effect'); },
      ready: async () => { if (mode === 'missing') throw Error('missing'); return { nonce: mode === 'nonce' ? 'x' : nonce, identity: { ...identity(), ...(mode === 'birth' ? { startedUtcTicks: '639289999999999999' } : {}) } }; },
      inspect: async () => ({ ...identity(), ...(mode === 'hash' ? { sha256: 'c'.repeat(64) } : {}), ...(mode === 'parent' ? { parentPid: 0 } : {}), ...(mode === 'elevated' ? { elevated: true } : {}) }),
      requestClose: async () => { closed++; }, retire: async () => { retired++; return { ok: true }; }
    });
    await assert.rejects(lifecycle.launch()); const result = await lifecycle.cleanup(); assert.equal(result.ok, false, mode); assert.equal(closed, 1, mode); assert.equal(retired, 0, mode);
  }
});
test('forced retirement remains failure and unused lifecycle performs no IO', async () => {
  const { tcpRunnerLifecycle } = await load(); let io = 0;
  const unused = tcpRunnerLifecycle({ nonce, executable: identity().executable, sha256: hash }, new Proxy({}, { get() { io++; throw Error('unexpected'); } }));
  assert.equal((await unused.cleanup()).ok, true); assert.equal(io, 0);
  const lifecycle = tcpRunnerLifecycle({ nonce, executable: identity().executable, sha256: hash }, { launch: async () => ({ pid: 42 }), requestClose: async () => {}, retire: async () => ({ ok: true, forced: { originalExited: true } }) });
  await lifecycle.launch(); lifecycle.pin(identity()); assert.equal((await lifecycle.cleanup()).ok, false);
});
test('exit-query failure retains error and attempts only fully pinned cleanup identity', async () => {
  const { retireSamplerProcess } = await import('../scripts/verify-windows-sampler.mjs'), original = identity(), calls = [];
  const result = await retireSamplerProcess({ identity: original, executable: original.executable,
    close: async () => {}, closed: async () => ({ reason: 'requested', exitCode: 0 }),
    inspect: args => { calls.push(args); if (args[0] === '--wait-owned-exit') throw Object.assign(Error('unknown'), { code: 'OWNED_QUERY_FAILED' }); return { ok: true, originalExited: true }; }
  });
  assert.equal(result.ok, false); assert.equal(result.exitError.code, 'OWNED_QUERY_FAILED'); assert.equal(result.forced.originalExited, true);
  assert.deepEqual(calls[1], ['--cleanup-owned', '42', original.startedUtcTicks, original.executable, original.sha256, '1']);
});
test('frozen baseline exposes only two family reads to the TCP benchmark and executes no PowerShell', async () => {
  const fs = require('node:fs'); const { loadLegacySampler } = await import('../scripts/verify-windows-sampler.mjs'), calls = [], segments = [];
  const source = fs.readFileSync(require('node:path').resolve(__dirname, '../scripts/e2e/windows-sampler-legacy-platform.ts'), 'utf8');
  const legacy = loadLegacySampler(source, segments, { execute: async (executable, args) => {
    calls.push({ executable, args }); assert.equal(executable, 'netstat');
    return { stdout: 'Active Connections\n  Proto  Local Address  Foreign Address  State  PID\n' };
  } });
  const result = await legacy.__samplerBenchmarkTcp(); await legacy.__samplerBenchmarkSettle();
  assert.equal(result.complete, true); assert.equal(result.connections.length, 0);
  assert.deepEqual(calls.map(call => Array.from(call.args)), [['-ano', '-p', 'tcp'], ['-ano', '-p', 'tcpv6']]); assert.equal(segments.length, 2);
});
const owner = { pid: 42, endpoints: [{ family: 2, address: '127.0.0.1', port: 43111, clientPort: 45111 }, { family: 23, address: '::1', port: 43112, clientPort: 45112 }] };
function rows(native) {
  return owner.endpoints.flatMap(endpoint => [2, 5].map(state => ({ pid: 42, family: endpoint.family,
    state: native ? state : state === 2 ? 'Listen' : 'Established', localPort: state === 2 ? endpoint.port : endpoint.clientPort,
    remotePort: state === 2 ? 0 : endpoint.port, localAddress: endpoint.address, remoteAddress: endpoint.address,
    localAddressHex: endpoint.family === 2 ? '7f000001' : '00000000000000000000000000000001',
    remoteAddressHex: state === 2 ? '0'.repeat(endpoint.family === 2 ? 8 : 32) : endpoint.family === 2 ? '7f000001' : '00000000000000000000000000000001',
    localScopeRaw: 0, remoteScopeRaw: 0, remoteMeaningful: state !== 2 })));
}
test('owned listener and established evidence is exact per PID/family/local/remote ports', async () => {
  const { verifyOwnedTcp } = await load();
  for (const native of [false, true]) {
    assert.equal(verifyOwnedTcp(rows(native), owner, native).length, 2);
    for (const mutate of [value => { value[0].pid = 99; }, value => { value[1].remotePort++; }, value => { value.pop(); }, value => { value.push({ ...value[0] }); }]) {
      const value = rows(native); mutate(value); assert.throws(() => verifyOwnedTcp(value, owner, native));
    }
  }
});
test('empty or degenerate owned endpoint manifests never pass without checking TCP rows', async () => {
  const { verifyOwnedTcp } = await load();
  for (const mutate of [value => { value.endpoints = []; }, value => { value.endpoints.pop(); }, value => { value.endpoints[1] = { ...value.endpoints[0] }; },
    value => { value.pid = 0; }, value => { value.endpoints[0].address = '192.0.2.1'; }, value => { value.endpoints[1].port = 0; },
    value => { value.endpoints[1].clientPort = 65536; }, value => { value.endpoints[0].clientPort = value.endpoints[0].port; }]) {
    const value = structuredClone(owner); mutate(value); for (const native of [false, true]) assert.throws(() => verifyOwnedTcp(rows(native), value, native), { code: 'TCP_OWN_ENDPOINTS_INVALID' });
  }
});
test('prototype reply requires both ordered families and keeps scope raw', async () => {
  const { validateTcpReply } = await load(), id = '11111111-1111-4111-8111-111111111111';
  const nativeRows = rows(true).map(({ localAddress, remoteAddress, ...row }) => row);
  const reply = { protocol: 'profilepilot.windows-tcp-prototype', version: 1, operation: 'tcp', requestId: id, ok: true,
    result: { complete: true, processBirthJoined: false, scopeEncoding: 'raw-DWORD-uninterpreted', families: [2, 23].map(family => ({ family, rowCount: 2, apiCalls: 2, rows: nativeRows.filter(row => row.family === family) })) } };
  const wire = value => Buffer.from(JSON.stringify(value) + '\n');
  assert.equal(validateTcpReply(wire(reply), id, 0).result.processBirthJoined, false);
  for (const mutate of [value => { value.protocol = 'production'; }, value => { value.result.families.pop(); }, value => { value.result.families.reverse(); }, value => { value.result.processBirthJoined = true; }, value => { value.result.families[1].rows[0].state = 100; }]) {
    const value = structuredClone(reply); mutate(value); assert.throws(() => validateTcpReply(wire(value), id, 0));
  }
  assert.throws(() => validateTcpReply(wire(reply), id, 2)); assert.throws(() => validateTcpReply(Buffer.from(JSON.stringify(reply)), id, 0));
});
