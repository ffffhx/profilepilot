const test = require('node:test');
const assert = require('node:assert/strict');
const { phoneList } = require('../dist/shared/phone-list');
const phone = (id, extra = {}) => ({ id, name: id, model: 'Test phone', transport: 'usb', connection: 'device', companion: 'unknown', state: null, confirmedAt: null, pending: null, error: '', ...extra });

test('list counts hardware, searches names and routes, and keeps offline records', () => {
  const devices = [phone('usb-one', { name: 'My Phone', hardwareId: 'one' }), phone('10.0.0.2:1234', { transport: 'wifi', hardwareId: 'one' }), phone('offline', { connection: 'missing' })];
  const all = phoneList(devices);
  assert.equal(all.all.length, 2); assert.equal(all.online, 1);
  assert.equal(all.items[0].connection, 'USB / Wi-Fi');
  assert.equal(phoneList(devices, 'MY PHONE').items.length, 1);
  assert.equal(phoneList(devices, '10.0.0.2').items.length, 1);
  assert.equal(phoneList(devices, '', 'offline').items[0].id, 'offline');
  devices[0].connection = 'missing';
  assert.equal(phoneList(devices).items[0].id, '10.0.0.2:1234');
  assert.equal(phoneList(devices).items[0].connection, 'Wi-Fi');
});

test('debug connection enables basic viewing without companion installation', () => {
  const item = phoneList([phone('connected', { companion: 'unavailable' })]).items[0];
  assert.equal(item.online, true); assert.equal(item.action, 'basic-control');
  assert.equal(item.status, '已连接'); assert.equal(item.session, '空闲');
});

test('unauthorized, emulator and cloud-only records never claim a control connection', () => {
  const devices = [phone('auth', { connection: 'unauthorized' }), phone('emulator', { transport: 'emulator', connection: 'missing' }), phone('cloud', { transport: 'cloud', connection: 'missing', cloud: { paired: true, reportedAt: Date.now(), report: { name:'Cloud', permissions:{}, readiness:{} } } })];
  const list = phoneList(devices);
  assert.equal(list.online, 0);
  assert.ok(list.items.every(item => item.actionLabel === '查看手机' && item.actionHint && !item.online));
  assert.equal(list.items[0].status, '等待授权');
  assert.equal(list.items[2].status, '仅状态同步');
  assert.equal(phoneList([phone('offline', { connection: 'missing' })]).items[0].actionLabel, '查看手机');
});

test('ongoing sessions open their controls instead of starting a second session', () => {
  const state = { phase: 'paused', mode: 'control', controller: 'Agent', instanceId: 'one', generation: 1, permissions:{}, readiness:{} };
  const basic = phoneList([phone('basic', { basic: state })]).items[0];
  assert.equal(basic.action, 'basic-open'); assert.equal(basic.session, '已暂停');
  const app = phoneList([phone('app', { companion:'ready', confirmedAt:Date.now(), state })]).items[0];
  assert.equal(app.action, 'details'); assert.equal(app.actionLabel, '查看手机');
  assert.equal(app.session, '已暂停');
});

test('a recovered Wi-Fi route offers a new view instead of reopening the disconnected USB session', () => {
  const item = phoneList([
    phone('usb', { hardwareId: 'one', connection: 'missing', basic: { phase: 'disconnected', mode: 'view' } }),
    phone('192.168.1.2:40000', { hardwareId: 'one', transport: 'wifi' })
  ]).items[0];
  assert.equal(item.id, '192.168.1.2:40000');
  assert.equal(item.action, 'basic-control'); assert.equal(item.actionLabel, '查看手机');
  assert.equal(item.session, '空闲');
});
