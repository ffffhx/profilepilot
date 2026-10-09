const test = require('node:test');
const assert = require('node:assert/strict');
const { popupFixture } = require('./helpers/native-popup-fixture.cjs');

test('popup and side panel contain only connection and controlled-page UI after pairing', async () => {
  for (const sidePanel of [false, true]) {
    const f = await popupFixture([], { sidePanel, state: { installationMode: 'temporary' } });
    for (const id of ['temporary-installation', 'confirm-persistent-installation', 'conversation', 'compose', 'new-task', 'next-tab', 'selection', 'messages', 'return', 'takeover']) {
      assert.equal(f.element('#' + id), null, id + ' is removed, not just hidden');
    }
    assert.equal(f.element('#controlled-tab').hidden, false);
    assert.equal(f.element('#connect').hidden, true);
    assert.equal(f.element('#reconnect').hidden, true);
    assert.ok(f.calls.every(c => c.method === 'state'), 'viewing never changes installation mode or control ownership');
  }
});

test('unpaired browsers can pair without reading any page or starting a task', async () => {
  const f = await popupFixture([], { state: { profileId: undefined, connected: false } });
  assert.equal(f.element('#connect').hidden, false);
  assert.equal(f.element('#controlled-tab').hidden, true);
  f.handlers.connect = () => ({ result: { profileId: 'native:Default', connected: true } });
  f.element('#code').value = ' PP1.fixture '; await f.submit('#connect');
  assert.equal(f.calls.find(c => c.method === 'connect').code, 'PP1.fixture');
  assert.equal(f.element('#connect').hidden, true);
  assert.equal(f.element('#connection-label').textContent, '已连接');
  assert.deepEqual(f.calls.map(c => c.method), ['state', 'connect']);
});

test('failed pairing keeps the entered code and offers a retry', async () => {
  const f = await popupFixture([], { state: { profileId: undefined, connected: false } });
  f.handlers.connect = () => ({ error: '配对码无效。' });
  f.element('#code').value = 'PP1.invalid'; await f.submit('#connect');
  assert.equal(f.element('#code').value, 'PP1.invalid');
  assert.equal(f.element('#error').hidden, false);
  assert.equal(f.element('#connect-submit').disabled, false);
});

test('invitation confirmation survives the simplified UI and clears its code after pairing', async () => {
  const id = 'a'.repeat(48), key = 'onboarding:' + id;
  const f = await popupFixture([], { hash: '#setup=' + id, storage: {
    [key]: { profileName: '工作 Profile', code: 'PP1.invitation', expiresAt: Date.now() + 60000 }
  } });
  assert.equal(f.element('#connect').hidden, false);
  assert.equal(f.element('#controlled-tab').hidden, true);
  assert.equal(f.element('#code').hidden, true);
  assert.match(f.element('label[for="code"]').textContent, /工作 Profile/);
  await f.submit('#connect');
  assert.equal(f.storage[key], undefined);
  assert.equal(f.element('#code').value, '');
  assert.equal(f.element('#connect').hidden, true);
});

test('expired invitations never auto-pair', async () => {
  const id = 'b'.repeat(48);
  const f = await popupFixture([], { hash: '#setup=' + id, storage: {
    ['onboarding:' + id]: { code: 'PP1.expired', expiresAt: Date.now() - 1 }
  } });
  assert.match(f.element('#error').textContent, /已过期/);
  assert.ok(f.calls.every(c => c.method === 'state'));
});

test('the popup has no side panel entry and an already open panel can still close', async () => {
  const f = await popupFixture([]);
  assert.equal(f.element('#open-side-panel'), null);
  assert.equal(f.element('#close-panel'), null);
  const panel = await popupFixture([], { sidePanel: true });
  panel.element('#close-panel').listeners.click();
  assert.equal(panel.window.closed, true);
});
