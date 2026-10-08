const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { parseAdb, parsePhoneWrap, wrapperEnvironment, runAdbCli } = loadCli('src/main/phones/adb-wrapper.ts');
const { startProfilePilotManagementServer } = loadCli('src/main/profilepilot-management-server.ts');
const root = path.resolve(__dirname, '..');
const bundle = path.join(root, 'dist/main/profilepilot-cli.cjs');
const binary = path.join(root, 'dist/main/phone-bin', process.platform === 'win32' ? 'adb.exe' : 'adb');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

function io() { const out = [], err = []; return { stdout: { write: s => out.push(Buffer.from(s)) }, stderr: { write: s => err.push(String(s)) }, out: () => Buffer.concat(out), err: () => err.join('') }; }
const device = () => ({ id: 'PHONE1', model: 'Test Phone', name: 'Test Phone', connection: 'device', companion: 'ready', transport: 'usb', state: { sessionId: randomUUID(), generation: 5, phase: 'controlling', mode: 'control' } });
test('parses normal ADB syntax without invoking a shell; rejects injection, arbitrary commands and changed semantics', () => {
  assert.deepEqual(parseAdb(['-s', 'PHONE1', 'shell', 'input tap 10 20']).action, { kind: 'tap', x: 10, y: 20 });
  assert.equal(parseAdb(['shell', 'input', 'swipe', '1', '2', '3', '4']).action.duration, 300);
  assert.equal(parseAdb(['shell', 'input', 'keyevent', 'KEYCODE_APP_SWITCH']).action.key, 'recents');
  assert.deepEqual(parseAdb(['exec-out', 'screencap', '-p']).action, { kind: 'screenshot', format: 'png' });
  for (const argv of [ ['shell', 'input tap 1 2; reboot'], ['shell', 'sh', '-c', 'input tap 1 2'], ['shell', 'input', 'text', 'secret'], ['shell', 'input', 'keyevent', '4', '3'], ['shell', 'input', 'swipe', '1','2','3','4','9999'], ['shell'], ['install','x.apk'], ['forward','tcp:1','tcp:2'], ['-P','5038','devices'], ['exec-out','input','tap','1','2'], ['shell','screencap','-p','/sdcard/x.png'] ]) assert.throws(() => parseAdb(argv));
});
test('requires explicit target and keeps child argv intact, including its help flags', () => {
  assert.throws(() => parsePhoneWrap(['--', 'python', 'a.py']), /--device/);
  const p = parsePhoneWrap(['--device','PHONE1','--task','中文 & task','--','python','a b.py','--help']);
  assert.deepEqual(p.command, ['python','a b.py','--help']); assert.equal(p.task, '中文 & task');
  assert.deepEqual(parsePhoneWrap(['--device','PHONE1','node','test.js','--help']).command, ['node','test.js','--help']);
});
test('scoped PATH is portable and does not leak Electron run-as-node into user tools', () => {
  const env = wrapperEnvironment({ Path: 'C:\\tools', ELECTRON_RUN_AS_NODE: '1' }, 'C:\\wrapper', 'cli', 'lease', 'PHONE1', 'win32');
  assert.equal(env.Path, undefined); assert.equal(env.PATH, 'C:\\wrapper;C:\\tools'); assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(wrapperEnvironment({ PATH: '/usr/bin' }, '/wrapper', 'cli', 'lease', 'PHONE1', 'darwin').PATH, '/wrapper:/usr/bin');
});
test('metadata outside a scope does not start control; input requires a scope and exact device', async () => {
  const seen = [], request = async c => { seen.push(c); return { ok: true, data: c.method === 'list' ? { devices: [device()] } : device() }; };
  const log = io(); assert.equal(await runAdbCli(['devices','-l'], request, log, {}), 0); assert.match(log.out().toString(), /PHONE1\tdevice model:Test_Phone/);
  assert.equal(await runAdbCli(['shell','input','tap','1','2'], request, log, {}), 1);
  assert.equal(await runAdbCli(['-s','OTHER','shell','input','tap','1','2'], request, log, { PROFILEPILOT_PHONE_LEASE: randomUUID() }), 1);
  assert.equal(seen.some(c => /start|action/.test(c.method)), false);
});
test('PNG bytes are returned intact with no JSON or status prefix; JPEG and scaled frames are refused', async () => {
  const log = io(); let result = { mime: 'image/png', base64: png.toString('base64'), width: 1, height: 1 };
  const seen = [], request = async c => { seen.push(c); return { ok: true, data: c.method === 'wrapper-state' ? device() : { result } }; };
  const env = { PROFILEPILOT_PHONE_LEASE: randomUUID() };
  assert.equal(await runAdbCli(['exec-out','screencap','-p'], request, log, env), 0); assert.deepEqual(log.out(), png); assert.equal(log.err(), '');
  assert.equal(seen[1].params.generation, 5);
  result = { ...result, mime: 'image/jpeg' }; assert.equal(await runAdbCli(['exec-out','screencap','-p'], request, io(), env), 1);
  result = { ...result, mime: 'image/png', width: 2 }; assert.equal(await runAdbCli(['exec-out','screencap','-p'], request, io(), env), 1);
});
test('paused command is refused before submission and is not queued for resume', async () => {
  const calls = [], log = io(); const d = device(); d.state.phase = 'paused';
  const request = async c => { calls.push(c); return { ok: true, data: d }; };
  assert.equal(await runAdbCli(['shell','input','tap','1','2'], request, log, { PROFILEPILOT_PHONE_LEASE: randomUUID() }), 1);
  assert.equal(calls.length, 1); assert.match(log.err(), /暂停/);
});
test('native launcher preserves quoted argv, binary stdout and nonzero exit code', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-adb-exe-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const cli = path.join(temporary, 'CLI with spaces 中文.cjs');
  fs.writeFileSync(cli, 'process.stdout.write(Buffer.from([0,10,13,128,255]));process.stderr.write(JSON.stringify(process.argv.slice(2)));process.exitCode=23;');
  const args = ['arg with spaces', 'a"b\\', '$(echo bad) & |', '', '中文'];
  const result = spawnSync(binary, args, { env: { ...process.env, PROFILEPILOT_PHONE_RUNTIME: process.execPath, PROFILEPILOT_PHONE_CLI: cli }, windowsHide: true });
  assert.equal(result.status, 23, result.error?.message); assert.deepEqual(result.stdout, Buffer.from([0,10,13,128,255]));
  assert.deepEqual(JSON.parse(result.stderr.toString()), ['phone', 'adb', ...args]);
});
test('real CLI scope injects adb into a child, streams PNG and cleans ownership on exit/failure', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-adb-scope-'));
  const env = { ...process.env, PROFILEPILOT_MANAGEMENT_ROOT: temporary }; const events = []; const lease = randomUUID();
  const service = {
    startWrapper: async (...args) => { events.push(['start', args]); return { lease, device: device() }; },
    wrapperState: async v => { assert.equal(v, lease); return device(); },
    pulseWrapper: v => { assert.equal(v, lease); events.push(['pulse']); return device(); },
    performWrapper: async (...args) => { events.push(['action', args]); return { result: { mime: 'image/png', base64: png.toString('base64'), width: 1, height: 1 } }; },
    stopWrapper: async v => { assert.equal(v, lease); events.push(['stop']); }
  };
  const server = await startProfilePilotManagementServer({ homeDir: temporary, env, appVersion: 'test', profileManager: {}, getPhoneService: () => service });
  t.after(async () => { await server.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  const script = path.join(temporary, 'use-adb.cjs');
  fs.writeFileSync(script, `const {spawnSync}=require('node:child_process');const r=spawnSync('adb',['exec-out','screencap','-p'],{windowsHide:true});process.stdout.write(r.stdout);process.stderr.write(r.stderr);setTimeout(()=>process.exit(17),1700);`);
  async function run(command) {
    const proc = spawn(process.execPath, [bundle,'phone','wrap','--device','PHONE1','--controller','Test Agent','--task','PNG test','--', ...command], { env, windowsHide: true });
    const out = [], err = []; proc.stdout.on('data', c => out.push(c)); proc.stderr.on('data', c => err.push(c));
    const code = await new Promise((resolve,reject) => { proc.on('error',reject); proc.on('close',resolve); });
    return { code, out: Buffer.concat(out), err: Buffer.concat(err).toString() };
  }
  const result = await run([process.execPath, script]);
  assert.equal(result.code, 17, result.err); assert.deepEqual(result.out, png); assert.equal(events[0][0], 'start'); assert.equal(events.at(-1)[0], 'stop'); assert.ok(events.some(e => e[0] === 'pulse'));
  const missing = await run([path.join(temporary,'missing-program.exe')]); assert.equal(missing.code, 1); assert.equal(events.at(-1)[0], 'stop');
});
