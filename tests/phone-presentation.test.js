const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCli } = require('./cli-test-build.cjs');
const { phonePresentation, phoneConnectionPresentation } = loadCli('src/shared/phone-presentation.ts');
const device = () => ({ id: 'phone', name: 'Phone', model: 'Phone', transport: 'wifi', connection: 'device', companion: 'ready', confirmedAt: 1000, pending: null, error: '', state: { phase: 'idle', sessionId: null, permissions: { overlay: true, accessibility: true, notifications: true }, readiness: { unlocked: true, developerOptions: 'enabled', usbDebugging: 'enabled', wirelessDebugging: 'enabled', accessibilityService: 'running', usbConnected: false, wifiConnected: true } } });
test('connected phone presents six live switches and offers an on-demand screenshot', () => {
  const view = phonePresentation(device(), 1000);
  assert.equal(view.label, '手机已连接'); assert.equal(view.canPreview, true);
  assert.equal([...view.permissions, ...view.settings].filter(row => row.status === 'enabled').length, 6);
  assert.equal(view.active, false); assert.equal(view.settings[1].value, '已开启');
});
test('offline, stale or unavailable companion data never remains green', () => {
  for (const change of [{ connection: 'missing' }, { confirmedAt: null }, { confirmedAt: 0 }, { companion: 'unavailable' }]) {
    const view = phonePresentation({ ...device(), ...change }, 10000);
    assert.equal(view.known, false); assert.equal(view.canPreview, false); assert.equal(view.canSetup, false);
    assert.ok([...view.permissions, ...view.settings].every(row => row.value === (change.companion === 'unavailable' ? '暂时无法读取' : '未检测')));
  }
});
test('unknown debugging state is neither enabled nor disabled', () => {
  const phone = device(); phone.state.readiness.wirelessDebugging = 'unconfirmed';
  assert.equal(phonePresentation(phone, 1000).settings[2].value, '状态待确认');
  delete phone.state.readiness;
  assert.equal(phonePresentation(phone, 1000).permissionsReady, true);
  assert.ok(phonePresentation(phone, 1000).settings.every(row => row.status === 'unknown'));
});
test('accessibility enabled but not running needs attention, not a green check', () => {
  const phone = device(); phone.state.readiness.accessibilityService = 'enabled';
  const view = phonePresentation(phone, 1000);
  assert.equal(view.permissions[0].value, '未运行'); assert.equal(view.missing, 1); assert.equal(view.canPreview, false); assert.equal(view.canSetup, true);
});
test('paused task stays connected while screenshots and permission navigation stay disabled', () => {
  const phone = device(); phone.state.phase = 'paused';
  const view = phonePresentation(phone, 1000);
  assert.equal(view.label, '手机已连接'); assert.equal(view.paused, true); assert.equal(view.canPreview, false); assert.equal(view.canSetup, false);
  phone.state.phase = 'idle'; phone.state.readiness.unlocked = false;
  assert.equal(phonePresentation(phone, 1000).canPreview, false);
});

test('offline emulator explains local startup without showing phone debugging switches', () => {
  const view = phonePresentation({ ...device(), name: 'Android 手机', transport: 'emulator', connection: 'missing' }, 1000);
  assert.equal(view.displayName, 'Android 模拟器');
  assert.equal(view.label, '模拟器未连接');
  assert.match(view.note, /启动本机模拟器/);
  assert.doesNotMatch(view.note, /请用 USB|手机上允许/);
  assert.deepEqual(view.settings, []);
  assert.equal(view.known, false);
  assert.equal(view.canPreview, false);
});

test('emulator still requires actual companion permissions and retains permission setup', () => {
  const emulator = { ...device(), transport: 'emulator' };
  emulator.state.permissions.overlay = false;
  const view = phonePresentation(emulator, 1000);
  assert.equal(view.label, '模拟器已连接');
  assert.equal(view.permissions.length, 3);
  assert.equal(view.missing, 1);
  assert.equal(view.canPreview, false);
  assert.equal(view.canSetup, true);
  assert.deepEqual(view.settings, []);
  const unauthorized = phonePresentation({ ...emulator, connection: 'unauthorized' }, 1000);
  assert.equal(unauthorized.label, '等待模拟器授权');
  assert.match(unauthorized.note, /模拟器窗口/);
  assert.doesNotMatch(unauthorized.note, /USB/);
});

function remotePhone(usbDebugging, wirelessDebugging) {
  const phone = device();
  return { ...phone, transport: 'cloud', connection: 'missing', companion: 'unavailable', state: null, confirmedAt: null,
    cloud: { paired: true, reportedAt: 1000, report: { name: 'Phone', permissions: phone.state.permissions,
      readiness: { ...phone.state.readiness, computerConnected: true, usbDebugging, wirelessDebugging } } } };
}
const overview = (phone, now = 1000, routes = [phone]) => phoneConnectionPresentation({ device: phone, routes }, now);

test('either ready transport is sufficient; cloud readiness does not mean connected to this computer', () => {
  for (const switches of [['enabled', 'disabled'], ['disabled', 'enabled']]) {
    const status = overview(remotePhone(...switches));
    assert.equal(status.connected, false);
    assert.equal(status.condition, 'ready');
    assert.equal(status.label, '连接条件已就绪');
    assert.match(status.note, /连接尚未验证/);
    assert.equal(status.routes.filter(route => route.condition === 'ready').length, 1);
    assert.equal(status.view.canPreview, false);
  }
});

test('both disabled routes block readiness; an unknown alternative stays unconfirmed', () => {
  assert.equal(overview(remotePhone('disabled', 'disabled')).condition, 'blocked');
  assert.equal(overview(remotePhone('disabled', 'unconfirmed')).condition, 'unknown');
  const noDeveloperOptions = remotePhone('enabled', 'enabled');
  noDeveloperOptions.cloud.report.readiness.developerOptions = 'disabled';
  assert.equal(overview(noDeveloperOptions).condition, 'blocked');
});

test('fresh common permissions are necessary even with a ready route', () => {
  const phone = remotePhone('disabled', 'enabled');
  phone.cloud.report.permissions.overlay = false;
  assert.equal(overview(phone).condition, 'blocked');
  assert.equal(overview(phone).label, '权限未就绪');
  phone.cloud.report.permissions.overlay = true;
  assert.equal(overview(phone, 46000).condition, 'unknown');
  assert.ok(overview(phone, 46000).routes.every(route => route.condition === 'unknown'));
});

test('USB and Wi-Fi route badges use each actual transport, not shared phone flags', () => {
  const wifi = device();
  wifi.state.readiness.usbConnected = true; // A phone report alone does not establish this computer's USB route.
  const usb = { ...wifi, id: 'usb', transport: 'usb', connection: 'missing', companion: 'unavailable', confirmedAt: null };
  const status = overview(wifi, 1000, [usb, wifi]);
  assert.equal(status.connected, true);
  assert.equal(status.routes[0].connected, false);
  assert.equal(status.routes[1].connected, true);
  assert.equal(status.condition, 'ready');
  assert.match(status.connectionNote, /Wi-Fi/);
  assert.doesNotMatch(status.connectionNote, /USB/);
});

test('authorized local transport is usable even when its switch cannot be read; pause stays authoritative', () => {
  const phone = device(); phone.state.readiness.wirelessDebugging = 'unconfirmed';
  phone.state.phase = 'paused';
  const status = overview(phone);
  assert.equal(status.connected, true);
  assert.equal(status.condition, 'ready');
  assert.equal(status.occupied, true);
  assert.equal(status.view.canPreview, false);
  assert.equal(status.view.canSetup, false);
});

test('a companion explicitly reporting disconnection is not shown as connected', () => {
  const phone = device(); phone.state.readiness.computerConnected = false;
  assert.equal(overview(phone).connected, false);
  assert.equal(overview(phone).view.canPreview, false);
  assert.equal(overview(phone).view.canSetup, false);
  phone.state.readiness.computerConnected = true; phone.state.phase = 'disconnected';
  assert.equal(overview(phone).connected, false);
});

test('an unresponsive companion distinguishes recognized transport from unreadable permissions', () => {
  for (const transport of ['usb', 'wifi', 'emulator']) {
    const phone = { ...device(), transport, companion: 'unavailable', error: 'read ECONNRESET' };
    phone.state.readiness.unlocked = false;
    const status = overview(phone, 10000);
    assert.equal(status.connected, false);
    assert.equal(status.connectionLabel, 'App 未响应');
    assert.equal(status.label, '暂时无法读取');
    assert.equal(status.view.locked, false, 'historical lock state does not establish the current state');
    assert.ok([...status.view.permissions, ...status.view.settings].every(row => row.status === 'unknown' && row.value === '暂时无法读取'));
    assert.match(status.issue.description, /仍能识别.*权限和画面都无法更新/);
    assert.match(status.issue.lastState, /上次.*尚未确认/);
    assert.match(status.issue.steps.join(' '), /解锁.*ProfilePilot/);
    assert.equal(status.issue.detail, 'read ECONNRESET');
    if (transport !== 'emulator') assert.equal(status.routes.find(route => route.transport === transport).label, 'App 未响应');
    assert.match(status.issue.steps[1], transport === 'wifi' ? /同一网络/ : transport === 'usb' ? /USB/ : /模拟器/);
  }
});

test('screen lock with a responding app retains permissions and is not diagnosed as a timeout', () => {
  const phone = device(); phone.state.readiness.unlocked = false;
  const status = overview(phone);
  assert.equal(status.connected, true); assert.equal(status.issue, null);
  assert.equal(status.view.permissionsReady, true);
  assert.equal(status.view.canPreview, false);
  assert.match(status.connectionNote, /已锁屏/);
});

test('first setup and a lost physical connection do not claim the companion is unresponsive', () => {
  for (const change of [{ companion: 'unknown', state: null, confirmedAt: null }, { companion: 'pairing' }, { connection: 'missing', companion: 'unavailable', error: '手机连接已断开。' }]) {
    assert.equal(overview({ ...device(), ...change }).issue, null);
  }
});

test('fresh cloud evidence is retained and newer unlocked evidence suppresses the old lock hint', () => {
  const phone = { ...device(), companion: 'unavailable', error: 'socket hang up' };
  phone.state.readiness.unlocked = false;
  phone.cloud = { reportedAt: 2000, report: { permissions: phone.state.permissions, readiness: { ...phone.state.readiness, unlocked: true } } };
  assert.equal(overview(phone, 3000).view.permissionsReady, true);
  assert.equal(overview(phone, 3000).issue.lastState, '');
  assert.equal(overview(phone, 50000).view.permissionsReady, false);
  assert.equal(overview(phone, 50000).issue.lastState, '');
});

test('an uncertain input result remains visible in the recovery explanation', () => {
  const phone = { ...device(), companion: 'unavailable', error: '手机没有返回这次操作的结果。请先查看手机，确认点击或输入是否已生效，再决定是否重试。' };
  assert.match(overview(phone).issue.description, /确认点击或输入是否已生效/);
});
