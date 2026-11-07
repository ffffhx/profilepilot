const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./cli-test-build.cjs');
const { PhonesService } = loadCli('src/main/phones/service.ts');
const { parseScreenSize, parseKeyguardLocked, validateCredential, validatePattern, parsePatternLayout, defaultPatternLayout, patternPoints, parseRawScreencap, detectPatternGrid } = loadCli('src/main/phones/screen-access.ts');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-screen-access-'));
  const token = 'a'.repeat(64), id = 'SERIAL-1';
  fs.writeFileSync(path.join(root, 'devices.json'), JSON.stringify({ [id]: { token } }));
  const h = { id, root, calls: [], now: 100000, unlocked: false, size: 'Physical size: 1080x2400', typeReply: '', keyguardDump: 'mDreamingLockscreen=true', wakefulness: 'mWakefulness=Awake' };
  const state = () => ({
    protocol: 1, instanceId: 'instance', sessionId: null, generation: 1, phase: 'idle', mode: 'control',
    computer: 'pc', controller: '', task: '', startedAt: null, lastAction: '',
    pauseCause: '', keepScreenOn: true,
    permissions: { overlay: true, notifications: true, accessibility: true },
    readiness: { unlocked: h.unlocked, computerConnected: true, usbConnected: true, wifiConnected: false,
      developerOptions: 'enabled', usbDebugging: 'enabled', wirelessDebugging: 'disabled', accessibilityService: 'running' }
  });
  h.service = new PhonesService({ root, apkPath: '', now: () => h.now, secrets: options.secrets,
    adb: { run: async args => {
      h.calls.push(['adb', ...args]);
      if (args[0] === 'devices') return `${id} device model:Phone`;
      if (args[3] === "'getprop' 'ro.serialno'") return 'SERIAL-1';
      if (args.includes('tcp:0')) return '19000';
      if (args[3] === "'wm' 'size'") return h.size;
      if (args[3] === "'dumpsys' 'window'") return h.keyguardDump;
      if (args[3] === "'dumpsys' 'power'") return h.wakefulness;
      if (args[3] === "'input' 'keyevent' '224'") h.wakefulness = 'mWakefulness=Awake';
      if (args[3] === "'input' 'text' '1234'") { h.calls.push(['typed']); if (options.onType) options.onType(h); return h.typeReply; }
      return '';
    } }, request: async (_port, _token, method, body) => {
      h.calls.push([method]);
      if (method === 'sync' && options.onSync) options.onSync(h);
      if (method === 'unattended') return { ok: true, state: state(), result: { enabled: body.op === 'on', charging: true, active: body.op === 'on' } };
      return { ok: true, state: state() };
    } });
  t.after(async () => { await h.service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return h;
}

test('screen size and keyguard parsing stay bounded and refuse unknown output', () => {
  assert.deepEqual(parseScreenSize('Physical size: 1080x2400'), { width: 1080, height: 2400 });
  assert.deepEqual(parseScreenSize('Physical size: 1080x2400\nOverride size: 720x1600'), { width: 720, height: 1600 });
  assert.equal(parseScreenSize('error: closed'), null);
  assert.equal(parseScreenSize('Physical size: 0x0'), null);
  assert.equal(parseKeyguardLocked('mDreamingLockscreen=true mShowingLockscreen=false'), true);
  assert.equal(parseKeyguardLocked('mDreamingLockscreen=false mShowingLockscreen=false'), false);
  assert.equal(parseKeyguardLocked('unrelated dump'), null);
});

test('the credential must be printable without spaces and is never echoed', () => {
  assert.equal(validateCredential('1234'), '1234');
  assert.throws(() => validateCredential(''), /1–64/);
  assert.throws(() => validateCredential('12 34'), /1–64/);
  assert.throws(() => validateCredential('123\n'), /1–64/);
  assert.throws(() => validateCredential('x'.repeat(65)), /1–64/);
});

test('the charging-only unattended switch round-trips through the companion', async t => {
  const h = fixture(t);
  await h.service.refresh();
  const on = await h.service.unattended(h.id, 'on');
  assert.deepEqual(on, { enabled: true, charging: true, active: true });
  const off = await h.service.unattended(h.id, 'off');
  assert.equal(off.enabled, false);
});

test('wake only dispatches a wake keyevent and a best-effort keyguard dismissal', async t => {
  const h = fixture(t);
  await h.service.refresh();
  h.calls.length = 0;
  await h.service.wake(h.id);
  const shells = h.calls.filter(call => call[0] === 'adb' && call[4]).map(call => call[4]);
  assert.ok(shells.includes("'input' 'keyevent' '224'"));
  assert.ok(shells.includes("'wm' 'dismiss-keyguard'"));
  assert.equal(shells.some(shell => shell.includes("'text'")), false);
});

test('unlock types the credential once, submits it, and reports the verified result', async t => {
  const h = fixture(t, { onSync: current => { if (current.calls.some(call => call[0] === 'typed')) current.unlocked = true; } });
  await h.service.refresh();
  h.calls.length = 0;
  const result = await h.service.unlock(h.id, '1234');
  assert.equal(result.unlocked, true);
  assert.equal(result.verified, true);
  assert.ok(!JSON.stringify(result).includes('1234'));
  const shells = h.calls.filter(call => call[0] === 'adb' && call[4]).map(call => call[4]);
  assert.deepEqual(shells.filter(shell => shell.startsWith("'input' 'text'")), ["'input' 'text' '1234'"]);
  assert.ok(shells.some(shell => shell.startsWith("'input' 'swipe'")));
  assert.ok(shells.includes("'input' 'keyevent' '66'"));
});

test('an unverified unlock is reported as such and never retried', async t => {
  const h = fixture(t, { onSync: current => { if (current.calls.some(call => call[0] === 'typed')) current.now += 6000; } });
  await h.service.refresh();
  h.calls.length = 0;
  const result = await h.service.unlock(h.id, '1234');
  assert.equal(result.unlocked, false);
  assert.equal(result.verified, false);
  assert.match(result.note, /不会自动重试/);
  const typed = h.calls.filter(call => call[0] === 'adb' && call[4]?.startsWith("'input' 'text'"));
  assert.equal(typed.length, 1);
});

test('a sleeping phone is woken before a stale unlocked reading is trusted', async t => {
  const h = fixture(t);
  h.unlocked = true; h.wakefulness = 'mWakefulness=Asleep';
  await h.service.refresh();
  h.calls.length = 0;
  const result = await h.service.unlock(h.id, '1234');
  assert.equal(result.unlocked, true);
  assert.match(result.note, /没有输入凭据/);
  const shells = h.calls.filter(call => call[0] === 'adb' && call[4]).map(call => call[4]);
  assert.ok(shells.includes("'input' 'keyevent' '224'"));
  assert.equal(shells.some(shell => shell.startsWith("'input' 'text'")), false);
});

test('an already unlocked phone is not sent a credential', async t => {
  const h = fixture(t);
  h.unlocked = true;
  await h.service.refresh();
  h.calls.length = 0;
  const result = await h.service.unlock(h.id, '1234');
  assert.equal(result.unlocked, true);
  assert.match(result.note, /没有输入凭据/);
  assert.equal(h.calls.some(call => call[0] === 'adb' && call[4]?.startsWith("'input' 'text'")), false);
});

function rawScreen(width, height, centers, radius = 12) {
  const buffer = Buffer.alloc(12 + width * height * 4);
  buffer.writeUInt32LE(width, 0); buffer.writeUInt32LE(height, 4); buffer.writeUInt32LE(1, 8);
  for (const [cx, cy] of centers) {
    for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y++)
      for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue;
        const at = 12 + (y * width + x) * 4;
        buffer[at] = buffer[at + 1] = buffer[at + 2] = 255; buffer[at + 3] = 255;
      }
  }
  return buffer;
}

test('pattern digits, geometry overrides and default layout stay bounded', () => {
  assert.deepEqual(validatePattern('1478'), [1, 4, 7, 8]);
  assert.throws(() => validatePattern('123'), /4–9/);
  assert.throws(() => validatePattern('1123'), /重复/);
  assert.throws(() => validatePattern('12350'), /4–9/);
  assert.deepEqual(parsePatternLayout('300,1200,150'), { cx: 300, cy: 1200, stepX: 150, stepY: 150 });
  assert.deepEqual(parsePatternLayout('300,1200,150,160'), { cx: 300, cy: 1200, stepX: 150, stepY: 160 });
  assert.throws(() => parsePatternLayout('300,1200'), /格式/);
  assert.throws(() => parsePatternLayout('300,1200,5'), /超出/);
  assert.deepEqual(defaultPatternLayout(720, 1600), { cx: 360, cy: 1147, stepX: 181, stepY: 181 });
  assert.deepEqual(patternPoints([1, 5, 9], { cx: 360, cy: 1100, stepX: 180, stepY: 180 }), [
    { x: 180, y: 920 }, { x: 360, y: 1100 }, { x: 540, y: 1280 }
  ]);
});

test('the keyguard grid is detected from raw pixels and ignored when irregular', () => {
  const centers = [];
  for (const row of [0, 1, 2]) for (const column of [0, 1, 2]) centers.push([180 + column * 181, 966 + row * 181]);
  const screen = parseRawScreencap(rawScreen(720, 1600, centers));
  assert.ok(screen);
  const layout = detectPatternGrid(screen);
  assert.ok(layout);
  assert.ok(Math.abs(layout.cx - 361) <= 2 && Math.abs(layout.cy - 1148) <= 2);
  assert.ok(Math.abs(layout.stepX - 181) <= 2 && Math.abs(layout.stepY - 181) <= 2);

  assert.equal(parseRawScreencap(Buffer.alloc(11)), null);
  assert.equal(detectPatternGrid({ width: 720, height: 1600, format: 1, pixels: Buffer.alloc(720 * 1600 * 4) }), null);
  // A missing dot must not be guessed from the remaining eight.
  assert.equal(detectPatternGrid(parseRawScreencap(rawScreen(720, 1600, centers.slice(1)))), null);
});

test('pattern unlock draws one continuous gesture and saves the verified geometry', async t => {
  const h = fixture(t, { onSync: current => { if (current.calls.some(call => call[0] === 'adb' && call[4]?.startsWith("'input' 'motionevent' 'MOVE'"))) current.unlocked = true; } });
  await h.service.refresh();
  h.calls.length = 0;
  const result = await h.service.unlockPattern(h.id, '1478');
  assert.equal(result.unlocked, true);
  assert.equal(result.verified, true);
  const shells = h.calls.filter(call => call[0] === 'adb' && call[4]).map(call => call[4]);
  assert.deepEqual(shells.filter(shell => shell.startsWith("'input' 'motionevent'")), [
    "'input' 'motionevent' 'DOWN' '268' '1449'",
    "'input' 'motionevent' 'MOVE' '268' '1721'",
    "'input' 'motionevent' 'MOVE' '268' '1993'",
    "'input' 'motionevent' 'MOVE' '540' '1993'",
    "'input' 'motionevent' 'UP' '540' '1993'"
  ]);
  assert.equal(shells.some(shell => shell.startsWith("'input' 'text'")), false);
  const stored = [h.root, path.join(h.root, 'development')].map(dir => path.join(dir, 'pattern-layout.json')).some(file => fs.existsSync(file));
  assert.equal(stored, true);
});

function memorySecrets() {
  const records = new Map();
  return {
    available: () => true,
    status: key => records.has(key) ? { kind: records.get(key).kind, savedAt: records.get(key).savedAt, allowAgent: records.get(key).allowAgent } : null,
    get: key => records.get(key)?.value ?? null,
    save: (key, input) => { const saved = { ...input, savedAt: 1 }; records.set(key, saved); return { kind: saved.kind, savedAt: 1, allowAgent: saved.allowAgent }; },
    remove: key => records.delete(key)
  };
}

test('stored pattern unlocks without the value appearing in any result', async t => {
  const secrets = memorySecrets();
  const h = fixture(t, { secrets, onSync: current => { if (current.calls.some(call => call[0] === 'adb' && call[4]?.startsWith("'input' 'motionevent' 'MOVE'"))) current.unlocked = true; } });
  await h.service.refresh();
  const status = h.service.saveUnlockSecret(h.id, { kind: 'pattern', value: '2586', allowAgent: true });
  assert.equal(status.saved, true);
  assert.equal(status.kind, 'pattern');
  h.calls.length = 0;
  const result = await h.service.unlockStored(h.id);
  assert.equal(result.unlocked, true);
  assert.equal(result.verified, true);
  assert.ok(!JSON.stringify(result).includes('2586'));
  const events = h.calls.filter(call => call[0] === 'adb' && call[4]?.startsWith("'input' 'motionevent'")).map(call => call[4]);
  assert.equal(events.filter(event => event.includes("'DOWN'")).length, 1);
});

test('stored credentials respect the agent switch and deletion', async t => {
  const secrets = memorySecrets();
  const h = fixture(t, { secrets });
  await h.service.refresh();
  h.service.saveUnlockSecret(h.id, { kind: 'pattern', value: '2586', allowAgent: false });
  await assert.rejects(h.service.unlockStored(h.id), /未开启/);
  h.service.saveUnlockSecret(h.id, { kind: 'credential', value: '1234', allowAgent: true });
  const deleted = h.service.deleteUnlockSecret(h.id);
  assert.equal(deleted.removed, true);
  assert.equal(deleted.saved, false);
  await assert.rejects(h.service.unlockStored(h.id), /没有保存解锁凭据/);
  assert.equal(h.service.snapshot().devices.find(device => device.id === h.id).unlockSecret.saved, false);
});

test('stored PIN uses the credential path and invalid patterns are never saved', async t => {
  const secrets = memorySecrets();
  const h = fixture(t, { secrets, onType: current => { current.unlocked = true; } });
  await h.service.refresh();
  h.service.saveUnlockSecret(h.id, { kind: 'credential', value: '1234', allowAgent: true });
  assert.equal(h.service.snapshot().devices.find(device => device.id === h.id).unlockSecret.kind, 'credential');
  h.calls.length = 0;
  const result = await h.service.unlockStored(h.id);
  assert.equal(result.verified, true);
  assert.ok(h.calls.some(call => call[0] === 'adb' && call[4]?.startsWith("'input' 'text'")));
  assert.throws(() => h.service.saveUnlockSecret(h.id, { kind: 'pattern', value: '123', allowAgent: true }), /4–9/);
  assert.equal(h.service.snapshot().devices.find(device => device.id === h.id).unlockSecret.kind, 'credential');
});

test('a wrong pattern is one attempt, never retried, and echoes the used geometry', async t => {
  const h = fixture(t, { onSync: current => { if (current.calls.some(call => call[0] === 'adb' && call[4]?.startsWith("'input' 'motionevent' 'MOVE'"))) current.now += 6000; } });
  await h.service.refresh();
  h.calls.length = 0;
  const result = await h.service.unlockPattern(h.id, '2586', '300,1200,150');
  assert.equal(result.unlocked, false);
  assert.equal(result.verified, false);
  assert.match(result.note, /不会自动重试/);
  assert.deepEqual(result.layout, { cx: 300, cy: 1200, stepX: 150, stepY: 150 });
  const events = h.calls.filter(call => call[0] === 'adb' && call[4]?.startsWith("'input' 'motionevent'")).map(call => call[4]);
  assert.equal(events.filter(event => event.includes("'DOWN'")).length, 1);
  assert.equal(events.filter(event => event.includes("'UP'")).length, 1);
  assert.deepEqual(events.slice(0, 2), ["'input' 'motionevent' 'DOWN' '300' '1050'", "'input' 'motionevent' 'MOVE' '300' '1200'"]);
});
