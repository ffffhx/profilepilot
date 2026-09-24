const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { NativeOnboarding } = require('../dist/main/tasks/native-onboarding');
const id = 'gmdaabnoocjlpimglalnbegfdaklfnaj';

test('onboarding only delivers credentials once to the extension, never to its public page', async t => {
  const onboarding = new NativeOnboarding(id);
  let port;
  const server = http.createServer((req, res) => onboarding.handle(req, res, port));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = onboarding.create(port, 'PP1.secret', '<Profile>', new Date(Date.now() + 300000).toISOString());
  const page = await fetch(url);
  const html = await page.text();
  assert.equal(page.status, 200); assert.match(html, /&lt;Profile&gt;/);
  assert.equal(html.includes('PP1.secret'), false);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(url + '/pair')).status, 403);
  assert.equal((await fetch(url + '/pair', { headers: { Origin: 'https://attacker.example' } })).status, 403);
  const authorized = await fetch(url + '/pair', { method: 'POST', headers: { Origin: `chrome-extension://${id}` } });
  assert.equal((await authorized.json()).code, 'PP1.secret');
  assert.equal((await fetch(url + '/pair', { headers: { Origin: `chrome-extension://${id}` } })).status, 403);
  const expired = onboarding.create(port, 'PP1.expired', 'Old', new Date(Date.now() - 1).toISOString());
  assert.equal((await fetch(expired)).status, 410);
  assert.equal((await fetch(url, { method: 'POST' })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    http.get(url, { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(wrongHost, 403);
});

test('installation actions require same-origin POST, support cancellation and never expose pairing secrets', async t => {
  const onboarding = new NativeOnboarding(id);
  let started = 0; let settings = 0; let signal;
  onboarding.configure({ install: async r => { started++; signal = r.signal; r.report({ stage: 'enable-debugging', message: 'Enable debugging' }); }, openSettings: async () => { settings++; } }, () => {});
  let port;
  const server = http.createServer((req, res) => onboarding.handle(req, res, port));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
  t.after(() => { onboarding.close(); server.closeAllConnections(); server.close(); });
  const url = onboarding.create(port, 'PP1.secret', 'Default', new Date(Date.now() + 300000).toISOString(), 'native:Default');
  onboarding.start(url, true); assert.equal(started, 1);
  onboarding.start(url); onboarding.start(url, true); assert.equal(started, 1); assert.equal(signal.aborted, false);
  const status = await (await fetch(url + '/status')).text(); assert.equal(status.includes('PP1.'), false); assert.match(status, /enable-debugging/);
  assert.equal((await fetch(url + '/open-debugging')).status, 403);
  assert.equal((await fetch(url + '/open-debugging', { method: 'POST', headers: { Origin: 'https://attacker.test', 'X-ProfilePilot-Onboarding': '1' } })).status, 403);
  const post = action => fetch(url + '/' + action, { method: 'POST', headers: { Origin: `http://127.0.0.1:${port}`, 'X-ProfilePilot-Onboarding': '1' } });
  assert.equal((await post('open-debugging')).status, 200); assert.equal(settings, 1);
  assert.equal((await post('retry')).status, 400); assert.equal(started, 1);
  assert.equal((await post('cancel')).status, 200); assert.equal(signal.aborted, true);
  assert.equal((await fetch(url + '/pair', { headers: { Origin: `chrome-extension://${id}` } })).status, 410);
  assert.equal((await post('retry')).status, 200); assert.equal(started, 2);
  assert.equal((await fetch(url + '/pair', { headers: { Origin: `chrome-extension://${id}` } })).status, 200); assert.equal(signal.aborted, true);
  onboarding.connected('native:Default'); assert.equal((await (await fetch(url + '/status')).json()).stage, 'connected');
});

test('slow or returning extensions never cause an automatic debug authorization', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const onboarding = new NativeOnboarding(id);
  let started = 0;
  onboarding.configure({ install: async () => { started++; }, openSettings: async () => {} }, () => {});
  const url = onboarding.create(19000, 'PP1.secret', 'Default', new Date(Date.now() + 300000).toISOString(), 'native:Default');
  try {
    onboarding.start(url); onboarding.start(url);
    assert.equal(started, 0);
    assert.equal(onboarding.pending('native:Default').url, url);
    t.mock.timers.tick(10001);
    assert.equal(onboarding.states()[0].stage, 'failed');
    onboarding.start(url);
    assert.equal(started, 0);
    // A previously paired extension can reconnect without consuming an invitation.
    onboarding.connected('native:Default');
    assert.equal(onboarding.states()[0].stage, 'connected');
    onboarding.start(url);
    assert.equal(started, 0);
    assert.equal(onboarding.pending('native:Default'), undefined);
  } finally { onboarding.close(); }
});
