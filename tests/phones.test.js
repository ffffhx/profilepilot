const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadCli } = require('./cli-test-build.cjs');
const { PhonesService } = loadCli('src/main/phones/service.ts');
const { parseAdbDevices, deviceShell, validateDeviceId } = loadCli('src/main/phones/adb.ts');
const { runPhoneCli } = loadCli('src/main/phones/cli.ts');

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-phone-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const token = 'a'.repeat(64), id = 'SERIAL-1', calls = [];
  fs.writeFileSync(path.join(root, 'devices.json'), JSON.stringify({ [id]: { token } }));
  const h = { id, root, calls, fail: false, installed: false, deviceOutput: `${id} device product:test model:Test_Phone usb:1`, hook: null,
    state: { protocol: 1, instanceId: 'instance-1', sessionId: null, generation: 0, phase: 'idle', mode: 'control', computer: 'pc', controller: '', task: '', startedAt: null, lastAction: '', permissions: { overlay: true, notifications: true, accessibility: true } } };
  h.service = new PhonesService({ root, apkPath: path.join(root, 'phone.apk'), computer: 'pc', now: () => h.now ?? Date.now(), adb: { run: async args => {
    calls.push(['adb', ...args]); if (args[0] === 'devices') return h.deviceOutput; if (args.includes('tcp:0')) return '18762';
    if (args[2] === 'shell' && args[3].startsWith("'settings' 'get' 'global'")) return h.debugHook ? h.debugHook(args[3]) : '';
    if (args[2] === 'shell' && args[3].includes("'pm' 'path'")) return h.installed ? 'package:/data/app/test/base.apk' : '';
    if (args[2] === 'install') { h.installed = true; return 'Success'; }
    return '';
  } }, request: async (port, receivedToken, method, body) => {
    assert.equal(receivedToken, token); calls.push([method, body]);
    if (h.hook) { const custom = await h.hook(method, body); if (custom) return custom; }
    if (h.fail) throw new Error('link unavailable');
    if (method === 'start') Object.assign(h.state, { ...body, generation: h.state.generation + 1, phase: body.mode === 'view' ? 'viewing' : 'controlling', startedAt: Date.now() });
    if (['pause', 'stop', 'resume'].includes(method)) { h.state.generation++; h.state.phase = method === 'pause' ? 'paused' : method === 'stop' ? 'stopped' : 'controlling'; }
    return { ok: true, state: structuredClone(h.state), result: { accepted: method } };
  } });
  return h;
}
test('desktop preview creates and releases its own read-only session', async t => {
  const h = harness(t); await h.service.refresh();
  const result = await h.service.preview(h.id);
  assert.equal(result.result.accepted, 'action'); assert.equal(h.state.phase, 'stopped');
  const starts = h.calls.filter(c => c[0] === 'start');
  assert.equal(starts.length, 1); assert.equal(starts[0][1].mode, 'view');
  assert.deepEqual(h.calls.find(c => c[0] === 'action')[1].action, { kind: 'screenshot' });
  assert.equal(h.calls.filter(c => c[0] === 'stop').length, 1);
});

test('accessibility repair bootstraps a disabled service without starting a control lease', async t => {
  const h = harness(t); h.state.permissions.accessibility = false;
  h.hook = (method, body) => {
    if (method !== 'accessibility-recovery') return;
    if (body.op === 'repair') { h.state.permissions.accessibility = true; h.autoRestore = body.autoRestore; }
    return { ok: true, state: structuredClone(h.state), result: { authorized: h.state.permissions.accessibility, enabled: body.op === 'repair' ? false : h.state.permissions.accessibility, autoRestore: h.autoRestore ?? false } };
  };
  const result = await h.service.repairAccessibility(h.id, true);
  assert.equal(result.running, true); assert.equal(result.autoRestore, true);
  assert.equal(result.enabled, true);
  assert.equal(h.state.phase, 'idle'); assert.equal(h.state.sessionId, null);
  assert.ok(h.calls.some(c => c[0] === 'adb' && c.at(-1).includes("'pm' 'grant'") && c.at(-1).includes('android.permission.WRITE_SECURE_SETTINGS')));
  assert.equal(h.calls.filter(c => ['start', 'resume', 'action'].includes(c[0])).length, 0);
});

test('accessibility repair rejects occupied or paused sessions and unsupported companions before granting permissions', async t => {
  for (const phase of ['controlling', 'paused']) {
    const h = harness(t); await h.service.refresh(); h.state.phase = phase; h.calls.length = 0;
    await assert.rejects(h.service.repairAccessibility(h.id, true), /先结束/);
    assert.equal(h.calls.filter(c => c[0] === 'accessibility-recovery').length, 0);
    assert.ok(!h.calls.some(c => c[0] === 'adb' && String(c.at(-1)).includes("'grant'")));
  }
  const h = harness(t);
  h.hook = method => { if (method === 'accessibility-recovery') throw new Error('unsupported companion'); };
  await assert.rejects(h.service.repairAccessibility(h.id), /unsupported companion/);
  assert.ok(!h.calls.some(c => c[0] === 'adb' && String(c.at(-1)).includes("'grant'")));
});
test('preview observes an existing task without starting or ending it', async t => {
  const h = harness(t); await h.service.refresh();
  await h.service.start(h.id, 'control', 'Agent', 'keep task'); h.calls.length = 0;
  await h.service.preview(h.id);
  assert.equal(h.state.phase, 'controlling'); assert.equal(h.state.task, 'keep task');
  assert.equal(h.calls.filter(c => ['start', 'stop', 'pause', 'resume'].includes(c[0])).length, 0);
});
test('preview cannot resume a paused session or bypass a concurrent action', async t => {
  const h = harness(t); await h.service.refresh(); await h.service.start(h.id, 'control', 'Agent', 'test'); await h.service.control(h.id, 'pause');
  h.calls.length = 0; await assert.rejects(h.service.preview(h.id), /已暂停/);
  assert.equal(h.state.phase, 'paused'); assert.equal(h.calls.filter(c => c[0] === 'action').length, 0);
});
test('a phone-side pause during preview remains paused instead of being cleaned up', async t => {
  const h = harness(t); await h.service.refresh();
  h.hook = method => { if (method === 'action') { h.state.phase = 'paused'; h.state.generation++; } };
  await h.service.preview(h.id);
  assert.equal(h.state.phase, 'paused'); assert.equal(h.calls.filter(c => c[0] === 'stop').length, 0);
});
test('a newer session returned during preview is never stopped by preview cleanup', async t => {
  const h = harness(t); await h.service.refresh();
  h.hook = method => { if (method === 'action') { h.state.sessionId = 'replacement'; h.state.generation++; h.state.phase = 'controlling'; } };
  await h.service.preview(h.id);
  assert.equal(h.state.sessionId, 'replacement'); assert.equal(h.calls.filter(c => c[0] === 'stop').length, 0);
});
test('permission settings use fixed intents and reject occupied sessions', async t => {
  const h = harness(t); await h.service.refresh();
  await h.service.openSettings(h.id, 'accessibility');
  assert.ok(h.calls.some(c => c[0] === 'adb' && c.at(-1).includes('android.settings.ACCESSIBILITY_SETTINGS')));
  await assert.rejects(h.service.openSettings(h.id, 'arbitrary-shell'));
  await h.service.start(h.id, 'control', 'Agent', 'keep task'); h.calls.length = 0;
  await assert.rejects(h.service.openSettings(h.id, 'overlay'), /先结束/);
  assert.equal(h.calls.filter(c => c[0] === 'adb' && String(c.at(-1)).includes("'am' 'start'")).length, 0);
  await h.service.control(h.id, 'pause'); await assert.rejects(h.service.openSettings(h.id, 'overlay'), /先结束/);
});
test('developer setup opens build-number page when developer mode is disabled', async t => {
  const h = harness(t); h.state.readiness = { unlocked: true, computerConnected: true, usbConnected: true, wifiConnected: false, developerOptions: 'disabled', usbDebugging: 'enabled', wirelessDebugging: 'disabled', accessibilityService: 'running' };
  await h.service.refresh(); await h.service.openSettings(h.id, 'wirelessDebugging');
  assert.ok(h.calls.some(c => c[0] === 'adb' && c.at(-1).includes('android.settings.DEVICE_INFO_SETTINGS') && c.at(-1).includes('build_number')));
});
test('ADB wrapper owns a single phone session, enforces view mode and never replaces an occupied session', async t => {
  const h = harness(t);
  const owner = await h.service.startWrapper(h.id, 'view', 'Agent A', 'inspect');
  assert.equal(owner.device.state.controller, 'Agent A');
  await assert.rejects(h.service.startWrapper(h.id, 'control', 'Agent B', 'steal'), /已有会话/);
  await assert.rejects(h.service.performWrapper(owner.lease, owner.device.state.generation, { kind: 'tap', x: 1, y: 2 }, randomUUID()), /仅查看/);
  await h.service.performWrapper(owner.lease, owner.device.state.generation, { kind: 'screenshot', format: 'png' }, randomUUID());
  await h.service.stopWrapper(owner.lease);
  assert.equal(h.state.phase, 'stopped');
  await assert.rejects(h.service.wrapperState(owner.lease), /已结束或失联/);
});

test('native PNG screenshots negotiate bounded pages and retain the public screenshot shape', async t => {
  const h = harness(t), owner = await h.service.startWrapper(h.id, 'view', 'Agent', 'PNG');
  const id = randomUUID(), base64 = Buffer.alloc(100000, 43).toString('base64'), size = 48 * 1024;
  h.hook = (method, body) => {
    if (method === 'action') {
      assert.equal(body.imageTransfer, 'base64-chunks-v1');
      assert.deepEqual(body.action, { kind: 'screenshot', format: 'png' });
      return { ok: true, state: structuredClone(h.state), result: { mime: 'image/png', width: 2772, height: 1240,
        transfer: { protocol: 1, id, length: base64.length, chunkSize: size, ttlMs: 15000 } } };
    }
    if (method === 'screenshot-chunk') {
      assert.equal(body.transferId, id); assert.equal(body.generation, owner.device.state.generation);
      return { ok: true, state: structuredClone(h.state), result: { id, offset: body.offset,
        base64: base64.slice(body.offset, body.offset + size), done: body.offset + size >= base64.length } };
    }
  };
  const result = await h.service.performWrapper(owner.lease, owner.device.state.generation, { kind: 'screenshot', format: 'png' }, randomUUID());
  assert.deepEqual(result.result, { mime: 'image/png', width: 2772, height: 1240, base64 });
  assert.equal(h.calls.filter(c => c[0] === 'action').length, 1);
  assert.equal(h.calls.filter(c => c[0] === 'screenshot-chunk').length, 3);
  assert.equal(h.service.snapshot().devices[0].companion, 'ready');
});

test('follow frames negotiate bounded JPEG pages while small and legacy frames stay direct', async t => {
  const h = harness(t), owner = await h.service.startWrapper(h.id, 'view', 'Agent', 'follow');
  const id = randomUUID(), size = 48 * 1024, base64 = Buffer.alloc(300000, 47).toString('base64');
  const region = { x: 120, y: 36, width: 425, height: 425 };
  let chunked = true, frames = 0, pages = 0;
  h.hook = (method, body) => {
    if (method === 'follow') {
      if (body.op !== 'frame') { assert.equal(body.imageTransfer, undefined); return; }
      frames++; assert.equal(body.imageTransfer, 'base64-chunks-v1'); assert.deepEqual(body.region, region);
      return { ok: true, state: structuredClone(h.state), result: { mime: 'image/jpeg', width: 2772, height: 1240, region,
        ...(chunked ? { transfer: { protocol: 1, id, length: base64.length, chunkSize: size, ttlMs: 15000 } } : { base64: 'AAAA' }) } };
    }
    if (method === 'screenshot-chunk') {
      pages++; assert.equal(body.transferId, id); assert.equal(body.sessionId, owner.device.state.sessionId);
      return { ok: true, state: structuredClone(h.state), result: { id, offset: body.offset,
        base64: base64.slice(body.offset, body.offset + size), done: body.offset + size >= base64.length } };
    }
  };
  await h.service.followLive(owner.lease, h.state.generation, { op: 'probe' });
  const frame = await h.service.followLive(owner.lease, h.state.generation, { op: 'frame', region });
  assert.deepEqual(frame, { mime: 'image/jpeg', width: 2772, height: 1240, region, base64 });
  assert.equal(frames, 1); assert.equal(pages, Math.ceil(base64.length / size));
  const downloaded = pages; chunked = false;
  const direct = await h.service.followLive(owner.lease, h.state.generation, { op: 'frame', region });
  assert.equal(direct.base64, 'AAAA'); assert.deepEqual(direct.region, region);
  assert.equal(frames, 2); assert.equal(pages, downloaded, 'small and legacy direct responses do not request chunks');
  await h.service.stopWrapper(owner.lease);
});

test('phone rejection between PNG pages keeps the observed pause and never returns a partial image', async t => {
  const h = harness(t), owner = await h.service.startWrapper(h.id, 'view', 'Agent', 'PNG');
  const id = randomUUID(), size = 48 * 1024; let pages = 0;
  h.hook = (method, body) => {
    if (method === 'action') return { ok: true, state: structuredClone(h.state), result: { mime: 'image/png', width: 2772, height: 1240,
      transfer: { protocol: 1, id, length: size * 3, chunkSize: size, ttlMs: 15000 } } };
    if (method === 'screenshot-chunk') {
      if (++pages === 2) {
        h.state.generation++; h.state.phase = 'paused';
        return { ok: false, code: 'PHONE_REJECTED', error: '手机已暂停', state: structuredClone(h.state) };
      }
      return { ok: true, state: structuredClone(h.state), result: { id, offset: body.offset, base64: 'A'.repeat(size), done: false } };
    }
  };
  await assert.rejects(h.service.performWrapper(owner.lease, owner.device.state.generation, { kind: 'screenshot', format: 'png' }, randomUUID()), /已暂停/);
  assert.equal(pages, 2); assert.equal(h.calls.filter(c => c[0] === 'action').length, 1);
  const device = h.service.snapshot().devices[0]; assert.equal(device.companion, 'ready'); assert.equal(device.state.phase, 'paused');
});

test('a concurrent poll during PNG capture cannot invalidate its later completed response', async t => {
  const h = harness(t), owner = await h.service.startWrapper(h.id, 'control', 'Agent', 'PNG');
  const id = randomUUID(), base64 = Buffer.alloc(50000, 37).toString('base64'), size = 48 * 1024;
  let capturing, finishCapture;
  const arrived = new Promise(resolve => { capturing = resolve; });
  h.hook = (method, body) => {
    if (method === 'action') {
      h.state.phase = 'executing'; capturing();
      return new Promise(resolve => { finishCapture = () => {
        h.state.phase = 'controlling';
        resolve({ ok: true, state: structuredClone(h.state), result: { mime: 'image/png', width: 2772, height: 1240,
          transfer: { protocol: 1, id, length: base64.length, chunkSize: size, ttlMs: 15000 } } });
      }; });
    }
    if (method === 'screenshot-chunk') return { ok: true, state: structuredClone(h.state), result: { id, offset: body.offset,
      base64: base64.slice(body.offset, body.offset + size), done: body.offset + size >= base64.length } };
  };
  const pending = h.service.performWrapper(owner.lease, owner.device.state.generation, { kind: 'screenshot', format: 'png' }, randomUUID());
  await arrived;
  // This later-started poll observes encoding in flight, so its sequence is newer
  // than the eventual action result even though it describes an earlier phase.
  await h.service.refresh();
  assert.equal(h.service.snapshot().devices[0].state.phase, 'executing');
  finishCapture();
  const result = await pending;
  assert.equal(result.result.base64, base64); assert.equal(result.state.phase, 'controlling');
  assert.equal(h.calls.filter(c => c[0] === 'action').length, 1);
  assert.equal(h.calls.filter(c => c[0] === 'screenshot-chunk').length, 2);
  assert.equal(h.service.snapshot().devices[0].state.phase, 'controlling');
});
test('wrapper pause/resume rejects an old action generation but permits newly requested input', async t => {
  const h = harness(t), owner = await h.service.startWrapper(h.id, 'control', 'Agent', 'test');
  const oldGeneration = owner.device.state.generation;
  await h.service.control(h.id, 'pause');
  assert.equal(h.service.pulseWrapper(owner.lease).state.phase, 'paused');
  await assert.rejects(h.service.performWrapper(owner.lease, h.state.generation, { kind: 'key', key: 'back' }, randomUUID()), /已暂停/);
  await h.service.control(h.id, 'resume');
  await assert.rejects(h.service.performWrapper(owner.lease, oldGeneration, { kind: 'key', key: 'back' }, randomUUID()), /会话已改变/);
  await h.service.performWrapper(owner.lease, (await h.service.wrapperState(owner.lease)).state.generation, { kind: 'key', key: 'back' }, randomUUID());
  assert.equal(h.calls.filter(c => c[0] === 'action').length, 1);
});
test('lost wrapper heartbeat revokes commands and ends session despite ongoing desktop polling', async t => {
  const h = harness(t); h.now = 1000;
  const owner = await h.service.startWrapper(h.id, 'control', 'Agent', 'crash');
  h.now += 8001;
  assert.throws(() => h.service.pulseWrapper(owner.lease), /失联/);
  await assert.rejects(h.service.performWrapper(owner.lease, h.state.generation, { kind: 'key', key: 'home' }, randomUUID()), /失联/);
  await h.service.refresh(); assert.equal(h.state.phase, 'stopped');
});
test('old wrapper exit never stops a later session or inherits its authority', async t => {
  const h = harness(t), owner = await h.service.startWrapper(h.id, 'control', 'old', 'test');
  await h.service.control(h.id, 'stop');
  const next = await h.service.start(h.id, 'control', 'new', 'test');
  await assert.rejects(h.service.wrapperState(owner.lease), /切换会话/);
  await h.service.stopWrapper(owner.lease);
  assert.equal(h.state.phase, 'controlling'); assert.equal(h.state.sessionId, next.state.sessionId);
});
test('ADB device discovery keeps authorization and transport distinct', () => {
  const result = parseAdbDevices('List of devices attached\nusb-123 device usb:1 model:Realme_Phone\n10.0.0.2:3333 unauthorized\nemulator-5554 offline\n');
  assert.deepEqual(result.map(d => [d.id, d.transport, d.connection]), [['usb-123','usb','device'],['10.0.0.2:3333','wifi','unauthorized'],['emulator-5554','emulator','offline']]);
  assert.equal(result[0].name, 'Realme Phone'); assert.throws(() => validateDeviceId('serial;reboot'));
  assert.equal(deviceShell(['am', 'a b', "O'Brien", '$(test)']), "'am' 'a b' 'O'\\''Brien' '$(test)'");
});
test('connecting a device never starts a control session', async t => {
  const h = harness(t); const data = await h.service.refresh();
  assert.equal(data.devices[0].state.phase, 'idle'); assert.equal(data.devices[0].companion, 'ready');
  assert.equal(h.calls.some(c => c[0] === 'start'), false);
});
test('setup diagnostics preserve unknown settings and a paused session', async t => {
  const h = harness(t);
  h.state.phase = 'paused'; h.state.sessionId = randomUUID(); h.state.generation = 8;
  h.state.readiness = { unlocked: false, computerConnected: true, usbConnected: true, wifiConnected: false,
    developerOptions: 'unconfirmed', usbDebugging: 'enabled', wirelessDebugging: 'unconfirmed', accessibilityService: 'enabled' };
  h.state.permissions.accessibility = false;
  await h.service.refresh();
  const observed = h.service.snapshot().devices[0].state;
  assert.deepEqual(observed.readiness, h.state.readiness);
  assert.equal(observed.phase, 'paused'); assert.equal(observed.generation, 8);
  assert.deepEqual(h.calls.find(call => call[0] === 'sync')[1], { transport: 'usb' });
  assert.equal(h.calls.some(call => ['start', 'pause', 'resume', 'stop', 'action'].includes(call[0])), false);
});

test('debug switch checks do not block heartbeats and report zero as disabled', { timeout: 2000 }, async t => {
  const h = harness(t);
  let release;
  const pending = new Promise(resolve => release = resolve);
  t.after(() => release());
  h.debugHook = async command => { await pending; return command.includes('adb_wifi_enabled') ? '0' : '1'; };
  await h.service.refresh();
  assert.equal(h.service.snapshot().devices[0].companion, 'ready');
  assert.equal(h.calls.filter(call => call[0] === 'sync').length, 1);
  release(); await new Promise(resolve => setImmediate(resolve));
  await h.service.refresh();
  const body = h.calls.filter(call => call[0] === 'sync').at(-1)[1];
  assert.equal(body.debugSettings.wirelessDebugging, 'disabled');
  assert.equal(body.debugSettings.usbDebugging, 'enabled');
  assert.equal(h.calls.some(call => ['start', 'resume', 'action'].includes(call[0])), false);
});

test('sync sends the discovered wireless transport and accepts an older companion', async t => {
  const h = harness(t);
  // Use an actual wireless identifier as the ADB parser does on both host OSes.
  h.deviceOutput = '192.168.1.8:37891 device product:test model:Test_Phone';
  fs.writeFileSync(path.join(h.root, 'devices.json'), JSON.stringify({ '192.168.1.8:37891': { token: 'a'.repeat(64) } }));
  // Existing harness construction loads saved routes once, so a fresh service reads this record.
  const service = new PhonesService({ root: h.root, apkPath: path.join(h.root, 'phone.apk'), adb: { run: async args => args[0] === 'devices' ? h.deviceOutput : '18762' },
    request: async (_port, _token, method, body) => { assert.equal(method, 'sync'); assert.deepEqual(body, { transport: 'wifi' }); return { ok: true, state: h.state }; } });
  await service.refresh();
  assert.equal(service.snapshot().devices[0].companion, 'ready');
  assert.equal(service.snapshot().devices[0].state.readiness, undefined);
});

test('view-only session refuses input without forwarding it to the phone', async t => {
  const h = harness(t); await h.service.refresh(); const device = await h.service.start(h.id, 'view', 'test', 'inspect');
  await assert.rejects(h.service.perform({ id: h.id, sessionId: device.state.sessionId, generation: device.state.generation, requestId: randomUUID(), action: { kind: 'tap', x: 10, y: 20 } }), /仅查看/);
  assert.equal(h.calls.some(c => c[0] === 'action'), false);
  const result = await h.service.perform({ id: h.id, sessionId: device.state.sessionId, generation: device.state.generation, requestId: randomUUID(), action: { kind: 'snapshot' } });
  assert.equal(result.result.accepted, 'action');
});
test('phone-side pause revokes old desktop generation before another input', async t => {
  const h = harness(t); await h.service.refresh(); const device = await h.service.start(h.id, 'control', 'test', 'inspect');
  h.state.generation++; h.state.phase = 'paused';
  await assert.rejects(h.service.perform({ id: h.id, sessionId: device.state.sessionId, generation: device.state.generation, requestId: randomUUID(), action: { kind: 'key', key: 'home' } }), /会话已改变/);
  assert.equal(h.calls.some(c => c[0] === 'action'), false);
  assert.equal(h.service.snapshot().devices[0].state.phase, 'paused');
});

test('selectors remain subject to phone generation and view-mode checks', async t => {
  const h = harness(t); await h.service.refresh(); const device = await h.service.start(h.id, 'view', 'test', 'find');
  const input = { id: h.id, sessionId: device.state.sessionId, generation: device.state.generation, requestId: randomUUID() };
  await h.service.perform({ ...input, action: { kind: 'find', selector: { resourceId: 'app:id/name' } } });
  for (const action of [{kind:'click',selector:{text:'Save'}},{kind:'fill',selector:{editable:true},text:''},{kind:'scroll',selector:{scrollable:true},direction:'forward'}]) {
    await assert.rejects(h.service.perform({ ...input, requestId: randomUUID(), action }), /仅查看/);
  }
  h.state.phase = 'paused'; h.state.generation++;
  await assert.rejects(h.service.perform({ ...input, action: { kind:'find',selector:{text:'Save'} } }), /会话已改变/);
  assert.equal(h.calls.filter(c => c[0] === 'action').length, 1);
});
test('delayed observation cannot overwrite a completed pause', async t => {
  const h = harness(t); await h.service.refresh(); await h.service.start(h.id, 'control', 'test', 'inspect');
  let release, observed; const arrived = new Promise(resolve => observed = resolve); let first = true;
  h.hook = async method => { if (method === 'sync' && first) { first = false; const state = structuredClone(h.state); observed(); return new Promise(resolve => release = () => resolve({ ok: true, state })); } };
  const poll = h.service.refresh(); await arrived;
  await h.service.control(h.id, 'pause'); release(); await poll;
  assert.equal(h.service.snapshot().devices[0].state.phase, 'paused');
});

test('a failed old poll cannot tear down a route with a newer successful phone response', async t => {
  const h = harness(t); await h.service.refresh();
  const owner = await h.service.startWrapper(h.id, 'control', 'Codex', 'follow');
  let rejectPoll, observed; const arrived = new Promise(resolve => observed = resolve); let first = true;
  h.hook = method => { if (method === 'sync' && first) {
    first = false; observed(); return new Promise((_, reject) => rejectPoll = reject);
  } };
  const poll = h.service.refresh(); await arrived;
  await h.service.followLive(owner.lease, h.state.generation, { op: 'frame' });
  rejectPoll(new Error('old poll socket reset')); await poll;
  assert.equal(h.service.snapshot().devices[0].companion, 'ready');
  assert.equal(h.service.snapshot().devices[0].state.phase, 'controlling');
  assert.ok(!h.calls.some(c => c.includes('--remove')));
  await h.service.followLive(owner.lease, h.state.generation, { op: 'touch', sequence: 1, points: [], ttlMs: 1200 });
  assert.ok(!h.calls.some(c => ['resume', 'pause'].includes(c[0])));
  await h.service.stopWrapper(owner.lease);
});

test('visual follow suspends sidebar captures and releases that restriction when stopped', async t => {
  const h = harness(t); await h.service.refresh();
  const owner = await h.service.startWrapper(h.id, 'view', 'Codex', 'observe follow');
  let captures = 0;
  h.service.adb.runBinary = async () => { captures++; throw Error('preview capture resumed'); };
  await h.service.followLive(owner.lease, h.state.generation, { op: 'probe' });
  assert.equal(h.service.snapshot().devices[0].visualFollowActive, true);
  await assert.rejects(h.service.screen(h.id), /视觉跟随正在采集/);
  assert.equal(captures, 0);
  await h.service.stopWrapper(owner.lease);
  assert.equal(h.service.snapshot().devices[0].visualFollowActive, false);
  await assert.rejects(h.service.screen(h.id), /preview capture resumed/);
  assert.equal(captures, 1);
});

test('a newer poll cached during follow capture cannot reject the next touch after capture completes', async t => {
  const h = harness(t); await h.service.refresh();
  const owner = await h.service.startWrapper(h.id, 'control', 'Codex', 'follow');
  let entered, release;
  const arrived = new Promise(resolve => entered = resolve);
  h.hook = (method, body) => {
    if (method === 'follow' && body.op === 'frame') {
      h.state.phase = 'executing'; entered();
      return new Promise(resolve => release = () => {
        h.state.phase = 'controlling'; resolve({ ok: true, state: structuredClone(h.state), result: {} });
      });
    }
  };
  const capture = h.service.followLive(owner.lease, h.state.generation, { op: 'frame' });
  await arrived; await h.service.refresh(); release(); await capture;
  assert.equal(h.service.snapshot().devices[0].state.phase, 'executing');
  await h.service.followLive(owner.lease, h.state.generation, { op: 'touch', sequence: 1, points: [], ttlMs: 1200 });
  assert.equal(h.service.snapshot().devices[0].state.phase, 'controlling');
  assert.equal(h.calls.filter(call => call[0] === 'follow' && call[1].op === 'touch').length, 1);
  await h.service.stopWrapper(owner.lease);
});

test('starting visual follow aborts a pending capture on another physical alias before its first RPC', async t => {
  const h = harness(t); await h.service.refresh();
  const owner = await h.service.startWrapper(h.id, 'control', 'Codex', 'follow');
  const primary = h.service.devices.get(h.id), alias = '192.168.0.2:40000';
  primary.hardwareId = 'physical-phone';
  h.service.devices.set(alias, { ...primary, id: alias, transport: 'wifi', companion: 'unknown' });
  let entered;
  let aborted = false;
  const started = new Promise(resolve => entered = resolve);
  h.service.adb.runBinary = async (_, __, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(Error('preview capture aborted')); }, { once: true }); entered();
  });
  h.hook = method => { if (method === 'follow') assert.equal(aborted, true, 'cancel full capture before probing follow'); };
  const capture = h.service.screen(alias);
  const rejected = assert.rejects(capture, /preview capture aborted/);
  await started;
  await h.service.followLive(owner.lease, h.state.generation, { op: 'probe' });
  await rejected;
  assert.equal(h.service.snapshot().devices[0].state.phase, 'controlling');
  assert.ok(h.service.snapshot().devices.every(device => device.visualFollowActive));
  await assert.rejects(h.service.screen(alias), /视觉跟随正在采集/);
  await h.service.stopWrapper(owner.lease);
  assert.ok(h.service.snapshot().devices.every(device => !device.visualFollowActive));
});

test('a newer heartbeat never hides an uncertain input result', async t => {
  const h = harness(t); await h.service.refresh();
  const device = await h.service.start(h.id, 'control', 'Codex', 'input');
  let rejectInput, observed; const arrived = new Promise(resolve => observed = resolve);
  h.hook = method => { if (method === 'action') {
    observed(); return new Promise((_, reject) => rejectInput = reject);
  } };
  const action = h.service.perform({ id: h.id, sessionId: device.state.sessionId, generation: device.state.generation,
    requestId: randomUUID(), action: { kind: 'key', key: 'home' } });
  await arrived; await h.service.rpc(h.id, 'sync');
  rejectInput(new Error('input result unknown')); await assert.rejects(action, /unknown/);
  assert.equal(h.service.snapshot().devices[0].companion, 'unavailable');
  assert.equal(h.calls.filter(c => c[0] === 'action').length, 1);
});

test('a stale poll without a recent successful response still invalidates the route once', async t => {
  const h = harness(t); h.now = 10000; await h.service.refresh();
  await h.service.start(h.id, 'control', 'Codex', 'test');
  let rejectPoll, observed; const arrived = new Promise(resolve => observed = resolve); let first = true;
  h.hook = method => { if (method === 'sync' && first) {
    first = false; observed(); return new Promise((_, reject) => rejectPoll = reject);
  } };
  const poll = h.service.refresh(); await arrived; await h.service.rpc(h.id, 'sync');
  h.now += 7000; rejectPoll(new Error('link lost')); await poll;
  assert.equal(h.service.snapshot().devices[0].companion, 'unavailable');
  assert.equal(h.calls.filter(c => c.includes('--remove')).length, 1);
  const log = JSON.parse(fs.readFileSync(path.join(h.root, 'connection-events.json'), 'utf8'));
  assert.equal(log.at(-1).method, 'sync'); assert.equal(log.at(-1).reason, 'link lost');
  assert.ok(!JSON.stringify(log).includes('a'.repeat(64)));
});
test('a late response from an old companion instance cannot restore its session', async t => {
  const h = harness(t); await h.service.refresh(); await h.service.start(h.id, 'control', 'test', 'inspect');
  let release, observed; const arrived = new Promise(resolve => observed = resolve); let first = true;
  h.hook = async method => { if (method === 'sync' && first) { first = false; const state = structuredClone(h.state); observed(); return new Promise(resolve => release = () => resolve({ ok: true, state })); } };
  const poll = h.service.refresh(); await arrived;
  h.state.instanceId = 'instance-2'; h.state.phase = 'idle'; h.state.generation = 0; h.state.sessionId = null;
  await h.service.start(h.id, 'control', 'new agent', 'new task'); release(); await poll;
  assert.equal(h.service.snapshot().devices[0].state.instanceId, 'instance-2');
});
test('disconnect is visible and reconnect only observes the phone state', async t => {
  const h = harness(t); await h.service.refresh(); await h.service.start(h.id, 'control', 'test', 'inspect');
  h.fail = true; await h.service.refresh(); assert.equal(h.service.snapshot().devices[0].state.phase, 'disconnected');
  h.fail = false; h.state.phase = 'disconnected'; h.state.generation++; await h.service.refresh();
  assert.equal(h.service.snapshot().devices[0].state.phase, 'disconnected'); assert.equal(h.calls.filter(c => c[0] === 'start').length, 1);
});
test('app exit ends its phone sessions and removes only its own forwards', async t => {
  const h = harness(t); await h.service.refresh(); await h.service.start(h.id, 'control', 'test', 'inspect'); await h.service.close();
  assert.equal(h.state.phase, 'stopped');
  assert.ok(h.calls.some(c => c[0] === 'adb' && c.includes('--remove') && c.includes('tcp:18762')));
  assert.equal(h.calls.some(c => c.includes('kill-server') || c.includes('--remove-all')), false);
});
test('a brief lost link pauses a surviving phone lease rather than silently resuming', async t => {
  const h = harness(t); await h.service.refresh(); const device = await h.service.start(h.id, 'control', 'test', 'inspect');
  h.fail = true; await h.service.refresh(); h.fail = false;
  await assert.rejects(h.service.perform({ id: h.id, sessionId: device.state.sessionId, generation: device.state.generation, requestId: randomUUID(), action: { kind: 'key', key: 'home' } }), /重新确认/);
  await h.service.refresh(); assert.equal(h.state.phase, 'paused');
});
test('desktop restart pauses a still-live session discovered on the phone', async t => {
  const h = harness(t); Object.assign(h.state, { sessionId: randomUUID(), generation: 5, phase: 'controlling' });
  await h.service.refresh(); assert.equal(h.service.snapshot().devices[0].state.phase, 'paused');
});

test('USB reconnect recreates its ADB forward and keeps the old controller paused', async t => {
  const h = harness(t); await h.service.refresh(); await h.service.start(h.id, 'control', 'test', 'inspect');
  h.deviceOutput = ''; await h.service.refresh();
  assert.equal(h.service.snapshot().devices[0].connection, 'missing');
  h.deviceOutput = `${h.id} device model:Test_Phone`; await h.service.refresh();
  assert.equal(h.calls.filter(c => c[0] === 'adb' && c.includes('tcp:0')).length, 2);
  assert.equal(h.service.snapshot().devices[0].state.phase, 'paused');
});

test('uncertain input response invalidates the route and never replays the input', async t => {
  const h = harness(t); await h.service.refresh(); const device = await h.service.start(h.id, 'control', 'test', 'inspect');
  h.hook = async method => { if (method === 'action') throw new Error('response lost after input'); };
  const input = { id: h.id, sessionId: device.state.sessionId, generation: device.state.generation, requestId: randomUUID(), action: { kind: 'key', key: 'home' } };
  await assert.rejects(h.service.perform(input), /response lost/);
  assert.equal(h.service.snapshot().devices[0].state.phase, 'disconnected');
  await assert.rejects(h.service.perform(input), /重新确认/);
  await h.service.refresh(); assert.equal(h.state.phase, 'paused');
  assert.equal(h.calls.filter(c => c[0] === 'action').length, 1);
});
test('CLI requires an explicit device and rejects unsupported flags', async () => {
  let calls = 0, error = '';
  const io = { stdout: { write() {} }, stderr: { write(value) { error += value; } } };
  const request = async () => { calls++; return { ok: true, data: {} }; };
  assert.equal(await runPhoneCli(['start'], request, io), 1); assert.match(error, /--device/);
  assert.equal(await runPhoneCli(['list','--device','oops'], request, io), 1); assert.equal(calls, 0);
});

test('prepare materializes bundled APK bytes and opens without reinstalling unchanged package', async t => {
  const h = harness(t); fs.writeFileSync(path.join(h.root, 'phone.apk'), 'test APK bytes'); await h.service.refresh();
  await h.service.prepare(h.id);
  const install = h.calls.find(call => call[0] === 'adb' && call[3] === 'install');
  assert.ok(install); assert.notEqual(install[5], path.join(h.root, 'phone.apk'));
  assert.equal(fs.readFileSync(install[5], 'utf8'), 'test APK bytes');
  await h.service.prepare(h.id);
  assert.equal(h.calls.filter(call => call[0] === 'adb' && call[3] === 'install').length, 1);
  fs.writeFileSync(path.join(h.root, 'phone.apk'), 'updated APK bytes'); await h.service.prepare(h.id);
  assert.equal(h.calls.filter(call => call[0] === 'adb' && call[3] === 'install').length, 2);
});

test('opening companion cannot replace an active control session', async t => {
  const h = harness(t); await h.service.refresh(); await h.service.start(h.id, 'control', 'test', 'inspect');
  await assert.rejects(h.service.prepare(h.id), /请先结束/);
  assert.equal(h.calls.some(call => call[0] === 'adb' && call[3] === 'install'), false);
});

test('initial connection stays pending until the companion service responds', async t => {
  const h = harness(t); fs.writeFileSync(path.join(h.root, 'phone.apk'), 'test APK bytes'); await h.service.refresh();
  h.fail = true; const pending = await h.service.prepare(h.id);
  assert.equal(pending.companion, 'pairing'); assert.equal(pending.error, '');
  await h.service.refresh(); assert.equal(h.service.snapshot().devices[0].companion, 'pairing');
  h.fail = false; await h.service.refresh(); assert.equal(h.service.snapshot().devices[0].companion, 'ready');
  h.fail = true; await h.service.refresh(); assert.equal(h.service.snapshot().devices[0].companion, 'unavailable');
});

test('phone IPC only allows local workspace main frames and restricts mutation to phones', async t => {
  const { buildSync } = require('esbuild');
  const Module = require('node:module');
  const { pathToFileURL } = require('node:url');
  const source = path.resolve(__dirname, '../src/main/phones/ipc.ts');
  const bundle = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], logLevel: 'silent' });
  let handle;
  const instance = new Module(source, module); instance.filename = source; instance.paths = Module._nodeModulePaths(path.dirname(source));
  instance.require = name => name === 'electron' ? { BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: (_, callback) => handle = callback } } : Module.prototype.require.call(instance, name);
  instance._compile(bundle.outputFiles[0].text, source);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-phone-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = instance.exports.registerPhones(root, '', false);
  t.after(() => service.close());
  const url = page => pathToFileURL(path.resolve(__dirname, '../public', page)).href;
  const event = (url, subframe = false) => { const frame = { url }; return { senderFrame: frame, sender: { mainFrame: subframe ? {} : frame } }; };
  assert.deepEqual((await handle(event(url('phones.html')), 'snapshot')).devices, []);
  assert.deepEqual((await handle(event(url('index.html')), 'snapshot')).devices, []);
  assert.deepEqual((await handle(event(url('workspace.html')), 'snapshot')).devices, []);
  await assert.rejects(handle(event(url('workspace.html'), true), 'snapshot'), /仅供/);
  await assert.rejects(handle(event(url('index.html')), 'start', {}), /手机工作区/);
  await assert.rejects(handle(event(url('phones.html'), true), 'snapshot'), /仅供/);
  await assert.rejects(handle(event('https://example.com/phones.html'), 'snapshot'), /仅供/);
  await assert.rejects(handle(event(pathToFileURL(path.join(root, 'phones.html')).href), 'snapshot'), /仅供/);
});
