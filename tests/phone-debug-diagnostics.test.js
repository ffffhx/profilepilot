const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { readinessSchema } = loadCli('src/main/phones/readiness-schema.ts');
const { phonePresentation, phoneConnectionPresentation } = loadCli('src/shared/phone-presentation.ts');
const report = () => ({ deviceId: 'c5f53402-8f58-496f-a0a8-384f244dc03c', name: 'Phone',
  permissions: { accessibility: true, overlay: true, notifications: true },
  readiness: { unlocked: true, computerConnected: false, usbConnected: false, wifiConnected: false,
    developerOptions: 'enabled', usbDebugging: 'enabled', wirelessDebugging: 'unconfirmed', accessibilityService: 'running',
    appVersion: '0.2.1', debugReasons: { developerOptions: 'system-value', usbDebugging: 'system-value', wirelessDebugging: 'denied' } } });
const cloudDevice = data => ({ id: 'cloud-test', name: 'Phone', model: 'Phone', transport: 'cloud', connection: 'missing',
  companion: 'unavailable', state: null, confirmedAt: null, pending: null, error: '', cloud: { paired: true, report: data, reportedAt: 1000 } });

test('relay and desktop preserve diagnostic causes and app version; reject malformed diagnostics', async () => {
  const { validateReport } = await import('../services/phone-status/server.mjs');
  const data = report();
  assert.deepEqual(validateReport(data), data);
  assert.deepEqual(readinessSchema.parse(data.readiness), data.readiness);
  for (const value of [null, [], { wirelessDebugging: 'unvalidated exception text' }]) {
    const bad = { ...data.readiness, debugReasons: value };
    assert.throws(() => validateReport({ ...data, readiness: bad }));
    assert.equal(readinessSchema.safeParse(bad).success, false);
  }
  const legacy = structuredClone(data);
  delete legacy.readiness.debugReasons; delete legacy.readiness.appVersion;
  assert.deepEqual(validateReport(legacy), legacy);
  assert.equal(readinessSchema.safeParse(legacy.readiness).success, true);
});

test('fresh local and cloud unknown states show the reported cause, not a guessed system restriction', () => {
  for (const [reason, label] of [['denied', '系统拒绝读取'], ['missing', '系统未提供状态'], ['error', '读取失败'], ['invalid', '状态异常'], ['masked-zero', '状态待确认']]) {
    const data = report(); data.readiness.debugReasons.wirelessDebugging = reason;
    for (const direct of [false, true]) {
      const device = cloudDevice(data);
      if (direct) Object.assign(device, { connection: 'device', companion: 'ready', confirmedAt: 1000, state: { permissions: data.permissions, readiness: data.readiness, phase: 'idle' } });
      const row = phonePresentation(device, 2000).settings.find(row => row.key === 'wirelessDebugging');
      assert.equal(row.status, 'unknown'); assert.equal(row.value, label); assert.ok(row.description.length > 10);
      assert.equal(phonePresentation(device, 46000).settings.find(row => row.key === 'wirelessDebugging').value, '未检测');
    }
  }
});

test('reported wireless off is shown as off while ready USB still makes the phone connectable', () => {
  const data = report();
  data.readiness.wirelessDebugging = 'disabled'; data.readiness.debugReasons.wirelessDebugging = 'system-value';
  const device = cloudDevice(data);
  const view = phoneConnectionPresentation({ device, routes: [device] }, 2000);
  assert.equal(view.routes.find(route => route.transport === 'wifi').setting.value, '未开启');
  assert.equal(view.routes.find(route => route.transport === 'wifi').condition, 'blocked');
  assert.equal(view.condition, 'ready'); assert.equal(view.connected, false);
  data.readiness.usbDebugging = 'disabled';
  assert.equal(phoneConnectionPresentation({ device, routes: [device] }, 2000).condition, 'blocked');
});
