const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { crc32, deflateSync } = require('node:zlib');
const { loadCli } = require('./cli-test-build.cjs');
const { IphonesService, iphonePredicate } = loadCli('src/main/phones/iphone.ts');
const { iphoneEndpoint } = loadCli('src/main/phones/iphone-wda.ts');
const { PhonesService } = loadCli('src/main/phones/service.ts');
const { executePhoneCommand } = loadCli('src/main/phones/management.ts');
const { runPhoneCli } = loadCli('src/main/phones/cli.ts');

function png(width, height) {
  const chunk = (type, data) => { const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); b.write(type, 4); data.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, -4)), b.length - 4); return b; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-iphone-'));
  const h = { root, calls: [], remote: null, fingerprint: randomUUID(), failInput: false, width: 390, height: 844, elements: [], hold: null };
  const screen = png(1170, 2532);
  const server = http.createServer(async (req, res) => {
    const data = []; for await (const chunk of req) data.push(chunk);
    const body = data.length ? JSON.parse(Buffer.concat(data)) : undefined;
    h.calls.push({ route: req.url, method: req.method, body });
    const reply = value => res.end(JSON.stringify({ value, sessionId: h.remote }));
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/status') return reply({ ready: true, os: { name: 'iOS', version: '18.7.8' }, device: 'iphone', ios: { ip: '192.168.1.20' }, build: { productBundleIdentifier: 'com.example.WebDriverAgentRunner' } });
    if (req.url === '/wda/device/info') return reply({ uuid: h.fingerprint, name: 'iPhone 13', model: 'iPhone', isSimulator: false });
    if (req.url === '/session' && req.method === 'POST') { h.remote = randomUUID(); return reply({ sessionId: h.remote, capabilities: { device: 'iphone' } }); }
    if (req.url === `/session/${h.remote}` && req.method === 'DELETE') { h.remote = null; return reply(null); }
    if (!h.remote || !req.url.startsWith(`/session/${h.remote}/`)) { res.statusCode = 404; return reply({ error: 'invalid session id' }); }
    const route = req.url.slice(`/session/${h.remote}`.length);
    if (route === '/window/size') return reply({ width: h.width, height: h.height });
    if (route === '/screenshot') return reply(screen);
    if (route === '/source?format=json') return reply({ type: 'Application', children: [{ type: 'Button', name: 'Settings', label: '设置' }] });
    if (route === '/elements') return reply(h.elements);
    if (h.hold) { h.hold({ req, res, reply }); return; }
    if (h.failInput) { res.statusCode = 500; return reply({ error: 'unknown error', message: 'input may have happened' }); }
    return reply(null);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  h.endpoint = `http://127.0.0.1:${server.address().port}`;
  h.service = new IphonesService(root, 'Test PC', () => {});
  h.device = await h.service.add({ endpoint: h.endpoint, name: 'iPhone 13' });
  h.state = () => h.service.devices()[0].state;
  h.start = (mode = 'control') => h.service.start({ id: h.device.id, mode, controller: 'test', task: 'iPhone verification' });
  h.action = (action, extra = {}) => h.service.perform({ id: h.device.id, sessionId: h.state().sessionId, generation: h.state().generation, requestId: randomUUID(), action, ...extra });
  t.after(async () => { h.hold = null; await h.service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  return h;
}

test('WDA HTTP protocol fixture: connection is read-only; screenshot pixels convert to iPhone points for input', async t => {
  const h = await fixture(t);
  assert.equal(h.device.platform, 'ios'); assert.equal(h.device.iphone.osVersion, '18.7.8');
  assert.equal(h.calls.every(call => call.method === 'GET'), true);
  await h.start();
  await assert.rejects(h.action({ kind: 'tap', x: 300, y: 600 }), /先刷新/);
  const screenshot = await h.action({ kind: 'screenshot' }); assert.equal(screenshot.result.width, 1170);
  await h.action({ kind: 'tap', x: 300, y: 600 });
  assert.deepEqual(h.calls.find(call => call.route.endsWith('/wda/tap')).body, { x: 100, y: 200 });
  await assert.rejects(h.action({ kind: 'tap', x: 300, y: 600 }), /先刷新/);
  await h.action({ kind: 'screenshot' });
  await h.action({ kind: 'swipe', x: 300, y: 600, toX: 300, toY: 300, duration: 600 });
  assert.deepEqual(h.calls.find(call => call.route.endsWith('/wda/dragfromtoforduration')).body, { fromX: 100, fromY: 200, toX: 100, toY: 100, duration: 0.6 });
  await h.action({ kind: 'text', text: '中文🙂' });
  assert.deepEqual(h.calls.find(call => call.route.endsWith('/wda/keys')).body.value, ['中', '文', '🙂']);
});

test('view-only mode rejects input; stale generations and duplicate request IDs never submit twice', async t => {
  const h = await fixture(t); await h.start('view');
  const id = randomUUID(); await h.action({ kind: 'snapshot' }, { requestId: id });
  await assert.rejects(h.action({ kind: 'snapshot' }, { requestId: id }), /提交过/);
  await assert.rejects(h.action({ kind: 'text', text: 'blocked' }), /仅查看/);
  const generation = h.state().generation;
  await h.service.control(h.device.id, 'pause');
  await assert.rejects(h.action({ kind: 'screenshot' }), /暂停/);
  await h.service.control(h.device.id, 'resume');
  await assert.rejects(h.action({ kind: 'snapshot' }, { generation }), /已改变/);
  assert.equal(h.calls.some(call => call.route.endsWith('/wda/keys')), false);
});

test('orientation changes block input; uncertain input pauses without replay', async t => {
  const h = await fixture(t); await h.start(); await h.action({ kind: 'screenshot' });
  h.width = 844; h.height = 390;
  await assert.rejects(h.action({ kind: 'tap', x: 1, y: 1 }), /方向已变化/);
  assert.equal(h.calls.some(call => call.route.endsWith('/wda/tap')), false);
  h.width = 390; h.height = 844; h.failInput = true;
  await assert.rejects(h.action({ kind: 'text', text: 'maybe typed' }), /请求失败/);
  assert.equal(h.state().phase, 'paused');
  await assert.rejects(h.action({ kind: 'text', text: 'maybe typed' }), /暂停/);
  assert.equal(h.calls.filter(call => call.route.endsWith('/wda/keys')).length, 1);
});

test('another WDA controller is never replaced or deleted; a replaced owned session disconnects', async t => {
  const h = await fixture(t); h.remote = 'another-controller';
  await assert.rejects(h.start(), /其他会话/);
  assert.equal(h.calls.some(call => call.method === 'POST'), false);
  h.remote = null; await h.start();
  h.remote = 'new-controller'; await h.service.refresh();
  assert.equal(h.state().phase, 'disconnected');
  await assert.rejects(h.service.control(h.device.id, 'resume'), /断线后/);
  await h.service.control(h.device.id, 'stop'); assert.equal(h.remote, 'new-controller');
});

test('pause invalidates an input already in flight and late replies cannot resume control', async t => {
  const h = await fixture(t); await h.start();
  let reached; const entered = new Promise(resolve => reached = resolve); let release;
  h.hold = ({ reply }) => { release = () => reply(null); reached(); };
  const pending = h.action({ kind: 'text', text: 'one input' }); const rejected = assert.rejects(pending);
  await entered; await h.service.control(h.device.id, 'pause'); release(); await rejected;
  assert.equal(h.state().phase, 'paused'); assert.equal(h.calls.filter(call => call.route.endsWith('/wda/keys')).length, 1);
});

test('selectors require unique exact matches; fill clears before writing and unsupported predicates are explicit', async t => {
  const h = await fixture(t); await h.start();
  h.elements = [{ ELEMENT: 'first' }, { ELEMENT: 'second' }];
  assert.equal((await h.action({ kind: 'find', selector: { text: '名称' } })).result.count, 2);
  await assert.rejects(h.action({ kind: 'click', selector: { text: '名称' } }), /唯一匹配/);
  h.elements = [{ 'element-6066-11e4-a52e-4f735466cecf': 'field-id' }];
  await h.action({ kind: 'fill', selector: { resourceId: 'name' }, text: '测试' });
  const writes = h.calls.filter(call => /\/element\/field-id\//.test(call.route));
  assert.match(writes[0].route, /\/clear$/); assert.match(writes[1].route, /\/value$/);
  assert.throws(() => iphonePredicate({ packageName: 'android.package' }), /不支持 packageName/);
  assert.match(iphonePredicate({ text: 'a" OR true' }), /label == "a\\" OR true"/);
});

test('saved endpoints survive restarts without restoring sessions or connectivity', async t => {
  const h = await fixture(t); await h.start();
  const content = fs.readFileSync(path.join(h.root, 'iphones.json'), 'utf8');
  assert.equal(content.includes(h.state().sessionId), false);
  const restarted = new IphonesService(h.root, 'Test PC', () => {});
  assert.equal(restarted.devices()[0].state, null); assert.equal(restarted.devices()[0].connection, 'missing');
  await assert.rejects(restarted.start({ id: h.device.id }), /其他会话/);
  await restarted.close(); assert.ok(h.remote, 'restart cannot delete the other process session');
});

test('phone management and CLI route iPhone independently of missing Android tools', async t => {
  const h = await fixture(t);
  const root = path.join(h.root, 'combined');
  const service = new PhonesService({ root, apkPath: path.join(root, 'missing.apk'), adb: { run: async () => { throw new Error('ADB missing'); } } });
  t.after(() => service.close());
  const request = async command => ({ ok: true, data: await executePhoneCommand(command, service) });
  let output = ''; const io = { stdout: { write: s => output += s }, stderr: { write: s => output += s } };
  assert.equal(await runPhoneCli(['iphone', 'add', '--endpoint', h.endpoint, '--name', 'iPhone 13'], request, io), 0);
  const device = JSON.parse(output).data; assert.equal(device.platform, 'ios');
  const listed = await executePhoneCommand({ action: 'phone', method: 'list' }, service);
  assert.equal(listed.adbAvailable, false); assert.equal(listed.devices.find(d => d.id === device.id).connection, 'device');
  await assert.rejects(executePhoneCommand({ action: 'phone', method: 'update', params: { id: device.id } }, service), /不适用于 iPhone/);
  output = ''; assert.equal(await runPhoneCli(['start', '--device', device.id, '--controller', 'test', '--mode', 'view'], request, io), 0);
  assert.equal(JSON.parse(output).data.state.phase, 'viewing');
});

test('WDA endpoint validation rejects public services, credentials and redirect-style paths', () => {
  for (const value of ['https://example.com', 'http://user:pass@127.0.0.1:8100', 'file:///tmp/phone', 'http://127.0.0.1:8100/session', 'http://127.0.0.1:8100/?token=secret']) assert.throws(() => iphoneEndpoint(value));
  assert.equal(iphoneEndpoint('http://127.0.0.1:8100/'), 'http://127.0.0.1:8100');
  assert.equal(iphoneEndpoint('http://192.168.1.20:8100'), 'http://192.168.1.20:8100');
});

test('stale desktop controls are rejected and a new session waits for previous-session cleanup', async t => {
  const h = await fixture(t); await h.start();
  const old = structuredClone(h.state());
  await h.service.control(h.device.id, 'pause', { sessionId: old.sessionId, generation: old.generation });
  await assert.rejects(h.service.control(h.device.id, 'resume', { sessionId: old.sessionId, generation: old.generation }), /会话已改变/);
  await h.service.control(h.device.id, 'resume');
  const request = h.service.request; let release, began;
  const waiting = new Promise(resolve => { began = resolve; });
  h.service.request = async (...args) => { if (args[2] === 'DELETE') { began(); await new Promise(resolve => { release = resolve; }); } return request(...args); };
  const stopping = h.service.control(h.device.id, 'stop'); await waiting;
  await assert.rejects(h.start(), /交接/); release(); await stopping;
  h.service.request = request;
  await h.start(); assert.notEqual(h.state().sessionId, old.sessionId);
});
