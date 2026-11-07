const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const plist = require('plist');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { loadCli } = require('./cli-test-build.cjs');
const { IphoneTools } = loadCli('src/main/phones/iphone-tools.ts');
const { forwardIphone } = loadCli('src/main/phones/iphone-usbmux.ts');
const { IphoneUsb } = loadCli('src/main/phones/iphone-usb.ts');
const { runIphoneCli } = loadCli('src/main/phones/iphone-cli.ts');
const { packageWdaIpa } = loadCli('src/main/phones/iphone-artifact.ts');
const udid = '00008110-0011223344556677';
function root(t) { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-iphone-tools-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; }

test('USB tooling uses platform paths, exact UDID, explicit developer-mode reveal, and rejects identity changes', async t => {
  const calls = []; let identity = udid;
  const run = async (exe, args) => {
    calls.push({ exe, args });
    if (args[0] === 'version') return '{"version":"1.3.2"}';
    if (args[0] === 'list') return JSON.stringify({ deviceList: [udid] });
    if (args[0] === 'info') return JSON.stringify({ DeviceName: 'iPhone 13', ProductVersion: '18.7.8', ProductType: 'iPhone14,5', UniqueDeviceID: identity });
    return '{}';
  };
  for (const platform of ['win32', 'darwin']) {
    const tools = new IphoneTools(root(t), platform, fetch, run);
    fs.mkdirSync(tools.directory, { recursive: true }); fs.writeFileSync(tools.executable(), 'fixture');
    assert.equal(path.basename(tools.executable()), platform === 'win32' ? 'ios.exe' : 'ios');
    assert.equal((await tools.doctor()).devices[0].version, '18.7.8');
    await tools.revealDeveloperMode(udid);
    assert.deepEqual(calls.at(-1).args, ['devmode', 'reveal', `--udid=${udid}`]);
    identity = '00008110-9988776655443322';
    assert.match((await tools.devices())[0].error, /身份/);
    const before = calls.filter(x => x.args[0] === 'devmode').length;
    await assert.rejects(tools.revealDeveloperMode(udid), /身份/);
    assert.equal(calls.filter(x => x.args[0] === 'devmode').length, before); identity = udid;
  }
});

test('tool downloads require the pinned hash and do not install a corrupt archive', async t => {
  const tools = new IphoneTools(root(t), 'win32', async () => new Response('corrupt download'));
  await assert.rejects(tools.setup(), /SHA-256/); assert.equal(fs.existsSync(tools.executable()), false);
  const missing = new IphoneTools(root(t), 'darwin', async () => { throw new Error('must not fetch'); });
  assert.equal((await missing.doctor()).installed, false);
});

test('IPA packaging preserves executable bits from the upstream ZIP on Windows and macOS', async t => {
  const { ZipFile } = require('yazl'); const { pipeline } = require('node:stream/promises'); const extract = require('extract-zip');
  const directory = root(t), zipPath = path.join(directory, 'upstream.zip'), ipa = path.join(directory, 'out.ipa');
  const zip = new ZipFile(), writing = pipeline(zip.outputStream, fs.createWriteStream(zipPath));
  zip.addBuffer(Buffer.from('Mach-O fixture'), 'WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner', { mode: 0o100755 });
  zip.addBuffer(Buffer.from('plist fixture'), 'WebDriverAgentRunner-Runner.app/Info.plist', { mode: 0o100644 }); zip.end(); await writing;
  await packageWdaIpa(directory, zipPath, ipa);
  const modes = new Map(); await extract(ipa, { dir: path.join(directory, 'inspect'), onEntry: entry => modes.set(entry.fileName, entry.externalFileAttributes >>> 16) });
  assert.equal(modes.get('Payload/WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner'), 0o100755);
  assert.equal(modes.get('Payload/WebDriverAgentRunner-Runner.app/Info.plist'), 0o100644);
});

test('signed installation requires exact connected UDID and an IPA; CLI forwards structured parameters', async t => {
  const directory = root(t), calls = [];
  const tools = new IphoneTools(directory, 'win32', fetch, async (_, args) => { calls.push(args); return JSON.stringify({ deviceList: [] }); });
  fs.mkdirSync(tools.directory, { recursive: true }); fs.writeFileSync(tools.executable(), 'fixture');
  const ipa = path.join(directory, 'signed.ipa'); fs.writeFileSync(ipa, 'fixture');
  await assert.rejects(tools.installSigned(udid, ipa), /未连接/);
  assert.equal(calls.some(args => args[0] === 'install'), false);
  const io = { stdout: { write() {} }, stderr: { write() {} } }; let command;
  const request = async c => { command = c; return { ok: true, data: {} }; };
  assert.equal(await runIphoneCli(['usb-start', '--udid', udid, '--bundle-id', 'dev.test.WDARunner'], request, io), 0);
  assert.deepEqual(command, { action: 'phone', method: 'iphone-usb-start', params: { udid, bundleId: 'dev.test.WDARunner' } });
  command = undefined;
  assert.equal(await runIphoneCli(['install-signed', '--udid', udid], request, io),2); assert.equal(command, undefined);
});

async function mux(t) {
  const h = { serial: udid, calls: [], connections: new Set() };
  const server = net.createServer(socket => {
    h.connections.add(socket); socket.once('close', () => h.connections.delete(socket)); socket.on('error', () => {});
    let pending = Buffer.alloc(0), connected = false;
    socket.on('data', chunk => {
      if (connected) return socket.write(chunk);
      pending = Buffer.concat([pending, chunk]); if (pending.length < 16 || pending.length < pending.readUInt32LE(0)) return;
      const request = plist.parse(pending.subarray(16).toString()); h.calls.push(request);
      const response = request.MessageType === 'ListDevices' ? { DeviceList: [{ DeviceID: 23, Properties: { SerialNumber: h.serial, ConnectionType: 'USB' } }] } : { Number: 0 };
      const body = Buffer.from(plist.build(response)), header = Buffer.alloc(16);
      header.writeUInt32LE(body.length + 16); header.writeUInt32LE(1, 4); header.writeUInt32LE(8, 8); header.writeUInt32LE(1, 12);
      connected = request.MessageType === 'Connect';
      socket.write(header.subarray(0, 7)); setImmediate(() => socket.write(Buffer.concat([header.subarray(7), body])));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  h.forward = await forwardIphone(udid, () => net.connect(server.address().port, '127.0.0.1'));
  t.after(async () => { await h.forward.close(); for (const s of h.connections) s.destroy(); await new Promise(resolve => server.close(resolve)); });
  return h;
}
test('USB forwarding binds loopback, handles fragmented plist responses, and re-resolves serial after unplugging', async t => {
  const h = await mux(t); const endpoint = new URL(h.forward.endpoint); assert.equal(endpoint.hostname, '127.0.0.1');
  const first = net.connect(Number(endpoint.port), '127.0.0.1'); first.on('error', () => {});
  const received = new Promise(resolve => first.once('data', b => resolve(b.toString()))); first.write('hello iPhone');
  assert.equal(await received, 'hello iPhone');
  assert.equal(h.calls[1].DeviceID, 23); assert.equal(h.calls[1].PortNumber, 42015); first.destroy();
  h.serial = '00008110-9988776655443322';
  const second = net.connect(Number(endpoint.port), '127.0.0.1'); second.on('error', () => {});
  await new Promise(resolve => second.once('close', resolve));
  assert.equal(h.calls.filter(x => x.MessageType === 'Connect').length, 1);
  await h.forward.close(); await assert.rejects(new Promise((resolve, reject) => { const s = net.connect(Number(endpoint.port), '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(); }); s.once('error', reject); }));
});

function bridge(t, options = {}) {
  const h = { calls: [], children: [], closed: 0, ready: 0, ended: 0, directory: root(t) };
  const tools = { directory: h.directory,
    devices: async () => [{ udid, name: 'iPhone 13', version: '18.7.8' }],
    run: async args => { h.calls.push(args); return args[0] === 'apps' ? JSON.stringify([{ CFBundleIdentifier: 'dev.test.WebDriverAgentRunner', CFBundleExecutable: 'WebDriverAgentRunner-Runner' }]) : JSON.stringify([{ udid }]); },
    spawn: args => { h.calls.push(args); const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
      child.kill = () => { child.signalCode = 'SIGTERM'; queueMicrotask(() => child.emit('exit', null)); return true; };
      h.children.push(child);
      if (args[0] === 'image') queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0); }); return child;
    }
  };
  const request = async () => {
    if (options.foreign) return { value: { ready: true }, sessionId: 'foreign-session' };
    if (!options.existing && !h.calls.some(args => args[0] === 'runwda')) throw new Error('WDA not started');
    return { value: { ready: true } };
  };
  h.bridge = new IphoneUsb(tools, { ready: async () => { h.ready++; return 'iphone-fixture'; }, ended: () => h.ended++, changed() {} },
    async () => { if (options.hold) await options.hold; return { endpoint: 'http://127.0.0.1:9876', close: async () => h.closed++ }; }, request);
  t.after(() => h.bridge.close()); return h;
}
async function settled(h) { for (let i = 0; i < 100; i++) { const s = h.bridge.status()[0]; if (['ready', 'error', 'stopped'].includes(s?.phase)) return s; await delay(10); } throw new Error('bridge did not settle'); }

test('USB startup owns isolated tunnel/runner and preserves the full lifecycle', async t => {
  const h = bridge(t); h.bridge.start({ udid });
  const state = await settled(h); assert.equal(state.phase, 'ready'); assert.equal(state.deviceId, 'iphone-fixture');
  const tunnel = h.calls.find(args => args[0] === 'tunnel' && args[1] === 'start');
  assert.ok(tunnel.includes('--userspace')); assert.ok(tunnel.includes(`--udid=${udid}`)); assert.ok(tunnel.includes('--tunnel-info-host=127.0.0.1'));
  assert.equal(h.calls.some(args => ['forward', 'stopagent'].includes(args[0])), false);
  await h.bridge.stop(udid); assert.equal(h.bridge.status()[0].phase, 'stopped');
  assert.ok(h.children.every(child => child.exitCode !== null || child.signalCode)); assert.equal(h.closed, 1);
});
test('already-running WDA is attached without restarting it; foreign sessions are refused', async t => {
  const h = bridge(t, { existing: true }); h.bridge.start({ udid }); assert.equal((await settled(h)).phase, 'ready'); assert.equal(h.children.length, 0);
  const foreign = bridge(t, { foreign: true }); foreign.bridge.start({ udid }); const state = await settled(foreign);
  assert.equal(state.phase, 'error'); assert.match(state.message, /其他会话/); assert.equal(foreign.ready, 0); assert.equal(foreign.children.length, 0);
});
test('runner exit disconnects without restarting; cancellation during forward setup leaves no listener', async t => {
  const h = bridge(t); h.bridge.start({ udid }); await settled(h); h.children.at(-1).emit('exit', 1); await delay(20);
  assert.equal(h.bridge.status()[0].phase, 'error'); assert.equal(h.calls.filter(a => a[0] === 'runwda').length, 1); assert.equal(h.closed, 1);
  let release; const pending = bridge(t, { hold: new Promise(resolve => { release = resolve; }) }); pending.bridge.start({ udid }); await delay(10);
  const stopping = pending.bridge.stop(udid); release(); await stopping;
  assert.equal(pending.bridge.status()[0].phase, 'stopped'); assert.equal(pending.ready, 0); assert.equal(pending.closed, 1);
});
